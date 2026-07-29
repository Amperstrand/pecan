//! `MintPayment` implementation for the "branch" custom payment method.
//!
//! Wallets create mint and melt quotes directly at the mint; every quote is
//! mirrored here as a ticket keyed by the mint's quote id. The operator later
//! matches a ticket in the teller UI by the quote id read off the customer's
//! wallet (last characters typed, or the full id scanned) and confirms the
//! cash movement, which settles the quote at the mint.
//!
//! Mint quotes must be NUT-20 locked: the patched cdk-mintd forwards the
//! mint-generated quote id and the wallet's pubkey inside `extra_json`
//! (see patches/cdk-managed-units.patch), and quote creation is refused when
//! either is missing. Melt quotes carry the quote id natively; the wallet
//! declares the payout amount as a flattened `amount` field.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use cdk_common::nuts::{CurrencyUnit, MeltQuoteState};
use cdk_common::payment::{
    Bolt11Settings, Bolt12Settings, CreateIncomingPaymentResponse, Error, Event,
    IncomingPaymentOptions, MakePaymentResponse, MintPayment, OutgoingPaymentOptions,
    PaymentIdentifier, PaymentQuoteResponse, SettingsResponse, WaitPaymentResponse,
};
use cdk_common::Amount;
use futures::Stream;
use serde_json::Value;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::config::{UnitLifecycle, MELT_QUOTE_TTL_SECS};
use crate::state::{BranchState, Ticket};

/// Field of the gRPC `extra_json` carrying the mint-generated quote id.
/// Injected by the patched cdk-mintd for mint quotes (melt quotes carry the
/// quote id natively); overwrites any wallet-supplied field of the same name.
pub const QUOTE_ID_FIELD: &str = "quote_id";

/// Field of the gRPC `extra_json` carrying the wallet's NUT-20 pubkey,
/// injected by the patched cdk-mintd. Presence is what we enforce; the mint
/// itself verifies the signature at mint time.
pub const PUBKEY_FIELD: &str = "pubkey";

/// Flattened field of the wallet's NUT-05 melt quote request declaring the
/// payout amount (the spec's custom melt request has no amount field). The
/// mint requires the wallet to lock proofs covering this amount, so the
/// wallet cannot profit by misdeclaring it.
pub const MELT_AMOUNT_FIELD: &str = "amount";

/// Single-method, multi-unit payment backend. Unit lifecycle gates mint and
/// melt independently so a unit can remain redeemable while new issuance is
/// disabled.
pub struct BranchBackend {
    state: BranchState,
    units: HashMap<CurrencyUnit, UnitLifecycle>,
    /// None until the operator adds the first unit on a fresh install.
    primary_unit: Option<CurrencyUnit>,
    method: String,
    stream_active: AtomicBool,
}

impl std::fmt::Debug for BranchBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchBackend")
            .field("units", &self.units)
            .field("method", &self.method)
            .finish()
    }
}

impl BranchBackend {
    pub fn new(
        state: BranchState,
        units: HashMap<CurrencyUnit, UnitLifecycle>,
        primary_unit: Option<CurrencyUnit>,
        method: String,
    ) -> Self {
        Self {
            state,
            units,
            primary_unit,
            method,
            stream_active: AtomicBool::new(false),
        }
    }

    fn lifecycle(&self, unit: &CurrencyUnit) -> Result<UnitLifecycle, Error> {
        let Some(lifecycle) = self.units.get(unit).copied() else {
            tracing::warn!(
                "rejecting request for unmanaged unit {unit:?}; managed units are {:?}",
                self.units.keys().collect::<Vec<_>>()
            );
            return Err(Error::UnsupportedUnit);
        };
        Ok(lifecycle)
    }

    fn check_mint_unit(&self, unit: &CurrencyUnit) -> Result<(), Error> {
        if !self.lifecycle(unit)?.can_mint() {
            return Err(Error::UnsupportedPaymentOption);
        }
        Ok(())
    }

    fn check_melt_unit(&self, unit: &CurrencyUnit) -> Result<(), Error> {
        if !self.lifecycle(unit)?.can_melt() {
            return Err(Error::UnsupportedPaymentOption);
        }
        Ok(())
    }
}

/// Parse the flattened extra fields of a quote request into a JSON object.
/// Absent or null extras become an empty object.
fn extra_object(extra_json: Option<&str>) -> Result<serde_json::Map<String, Value>, Error> {
    let Some(raw) = extra_json else {
        return Ok(serde_json::Map::new());
    };
    let value: Value = serde_json::from_str(raw)
        .map_err(|e| Error::Custom(format!("quote request metadata is invalid JSON: {e}")))?;
    match value {
        Value::Object(map) => Ok(map),
        Value::Null => Ok(serde_json::Map::new()),
        _ => Err(Error::Custom(
            "quote request metadata must be a JSON object".into(),
        )),
    }
}

/// Extract the mint-injected quote id and NUT-20 pubkey for a mint quote.
///
/// A missing quote id means cdk-mintd was built without
/// cdk-managed-units.patch (or a wallet is talking to us through an unpatched
/// mint) — refuse loudly rather than register an unmatchable ticket.
fn incoming_meta(extra: &serde_json::Map<String, Value>) -> Result<(String, String), Error> {
    let quote_id = extra
        .get(QUOTE_ID_FIELD)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::Custom(
                "branch quote request carries no mint quote id; the mint build is missing \
                 cdk-managed-units.patch"
                    .into(),
            )
        })?;
    if uuid::Uuid::parse_str(quote_id).is_err() {
        return Err(Error::Custom(format!(
            "unexpected mint quote id format: {quote_id}"
        )));
    }
    let pubkey = extra
        .get(PUBKEY_FIELD)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::Custom(
                "branch mint quotes must be locked to a wallet key (NUT-20): create the \
                 quote with a pubkey"
                    .into(),
            )
        })?;
    Ok((quote_id.to_string(), pubkey.to_string()))
}

#[async_trait]
impl MintPayment for BranchBackend {
    type Err = Error;

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        let mut custom = std::collections::HashMap::new();
        custom.insert(self.method.clone(), "{}".to_string());
        Ok(SettingsResponse {
            // The pinned CDK gRPC settings message has a legacy singleton unit.
            // cdk-mintd is patched at build time to register this backend for
            // every configured [[ln]] unit while requests remain unit-checked.
            // With zero units configured the mint has no [[ln]] entries and
            // never calls this; the empty string is just wire filler.
            unit: self
                .primary_unit
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_default(),
            // Mint requires either bolt11 or bolt12 settings in some code paths;
            // advertising None for both is intentional — bolt is not a valid rail here.
            bolt11: None::<Bolt11Settings>,
            bolt12: None::<Bolt12Settings>,
            onchain: None,
            custom,
        })
    }

    async fn create_incoming_payment_request(
        &self,
        options: IncomingPaymentOptions,
    ) -> Result<CreateIncomingPaymentResponse, Self::Err> {
        match options {
            IncomingPaymentOptions::Custom(opts) => {
                // The gRPC proto for CustomIncomingPaymentOptions does not carry the method
                // name (server-side sets it to ""), so we can't verify it here. Whatever
                // method the mint advertises to wallets that points at us IS our method
                // — see `get_settings` above where we declare it.
                self.check_mint_unit(opts.amount.unit())?;
                if opts.amount.value() == 0 {
                    return Err(Error::Custom("amount must be greater than zero".into()));
                }
                let extra = extra_object(opts.extra_json.as_deref())?;
                let (quote_id, _pubkey) = incoming_meta(&extra)?;
                let unit = opts.amount.unit().to_string();
                let ticket = Ticket::new_incoming(
                    quote_id,
                    opts.amount.value(),
                    unit,
                    opts.description.clone(),
                    opts.unix_expiry,
                );
                let ticket = self
                    .state
                    .insert_open(ticket)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                Ok(CreateIncomingPaymentResponse {
                    request_lookup_id: PaymentIdentifier::CustomId(ticket.id.clone()),
                    // The "payment request" the wallet displays; handing its tail
                    // (or the quote id it embeds) to the teller IS the payment.
                    request: ticket.id,
                    expiry: opts.unix_expiry,
                    extra_json: None,
                })
            }
            IncomingPaymentOptions::Bolt11(_)
            | IncomingPaymentOptions::Bolt12(_)
            | IncomingPaymentOptions::Onchain(_) => Err(Error::UnsupportedPaymentOption),
        }
    }

    async fn get_payment_quote(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Self::Err> {
        self.check_melt_unit(unit)?;
        match options {
            OutgoingPaymentOptions::Custom(opts) => {
                // See note in create_incoming_payment_request — method not on the wire.
                // The wallet declares the payout amount as a flattened extra field;
                // the mint will require proofs covering exactly what we echo back.
                let extra = extra_object(opts.extra_json.as_deref())?;
                let amount = extra
                    .get(MELT_AMOUNT_FIELD)
                    .and_then(Value::as_u64)
                    .filter(|amount| *amount > 0)
                    .ok_or_else(|| {
                        Error::Custom(
                            "branch melt quotes must declare a positive integer `amount` field"
                                .into(),
                        )
                    })?;
                let memo = match opts.request.trim() {
                    "" => None,
                    s => Some(s.to_string()),
                };
                let ticket = Ticket::new_outgoing(
                    opts.quote_id.to_string(),
                    amount,
                    unit.to_string(),
                    memo,
                    Some(unix_now() + MELT_QUOTE_TTL_SECS),
                );
                let ticket = self
                    .state
                    .insert_open(ticket)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                Ok(PaymentQuoteResponse {
                    request_lookup_id: Some(PaymentIdentifier::CustomId(ticket.id)),
                    amount: Amount::new(amount, unit.clone()),
                    fee: Amount::new(0, unit.clone()),
                    state: MeltQuoteState::Unpaid,
                    extra_json: None,
                    estimated_blocks: None,
                    fee_options: None,
                })
            }
            OutgoingPaymentOptions::Bolt11(_)
            | OutgoingPaymentOptions::Bolt12(_)
            | OutgoingPaymentOptions::Onchain(_) => Err(Error::UnsupportedPaymentOption),
        }
    }

    async fn make_payment(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Self::Err> {
        self.check_melt_unit(unit)?;
        match options {
            OutgoingPaymentOptions::Custom(opts) => {
                // The wallet has locked its proofs at the mint; flip the ticket
                // to Pending so the operator may dispense cash. The quote id is
                // the correlation key set during get_payment_quote.
                let quote_id = opts.quote_id.to_string();
                let ticket = self
                    .state
                    .outgoing_by_quote_id(&quote_id)
                    .await
                    .ok_or_else(|| {
                        Error::Custom(format!(
                            "unknown branch melt quote {quote_id}; it may have expired unfunded"
                        ))
                    })?;
                let ticket = self
                    .state
                    .mark_outgoing_submitted(&ticket.id)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                let status = match ticket.status {
                    crate::state::TicketStatus::Paid => MeltQuoteState::Paid,
                    crate::state::TicketStatus::Failed => MeltQuoteState::Failed,
                    _ => MeltQuoteState::Pending,
                };
                Ok(MakePaymentResponse {
                    payment_lookup_id: PaymentIdentifier::CustomId(ticket.id.clone()),
                    payment_proof: ticket.notes.clone(),
                    // The mint keeps the melt pending (and polls
                    // check_outgoing_payment) until the operator confirms the
                    // cash handover in the teller UI.
                    status,
                    total_spent: Amount::new(ticket.amount, unit.clone()),
                })
            }
            OutgoingPaymentOptions::Bolt11(_)
            | OutgoingPaymentOptions::Bolt12(_)
            | OutgoingPaymentOptions::Onchain(_) => Err(Error::UnsupportedPaymentOption),
        }
    }

    async fn wait_payment_event(
        &self,
    ) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, Self::Err> {
        let rx = self.state.subscribe_events();
        self.stream_active.store(true, Ordering::SeqCst);
        // Drop Lagged errors silently; mint will catch up via check_incoming_payment_status if needed.
        Ok(Box::pin(BroadcastStream::new(rx).filter_map(|r| r.ok())))
    }

    fn is_payment_event_stream_active(&self) -> bool {
        self.stream_active.load(Ordering::SeqCst)
    }

    fn cancel_payment_event_stream(&self) {
        self.stream_active.store(false, Ordering::SeqCst);
    }

    async fn check_incoming_payment_status(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<Vec<WaitPaymentResponse>, Self::Err> {
        Ok(self.state.lookup_incoming(payment_identifier).await)
    }

    async fn check_outgoing_payment(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        match self.state.lookup_outgoing(payment_identifier).await {
            Some(r) => Ok(r),
            None => Err(Error::Custom(format!(
                "outgoing payment {payment_identifier:?} not found"
            ))),
        }
    }
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
