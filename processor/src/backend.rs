//! `MintPayment` implementation for the "branch" custom payment method.
//!
//! Wallets create mint and melt quotes directly at the attached mint; every
//! quote is mirrored here as a ticket keyed by the mint's quote id. The
//! operator later matches a ticket in the teller UI by the quote id read off
//! the customer's wallet (last characters typed, or the full id scanned) and
//! confirms the cash movement, which settles the quote at the mint.
//!
//! Mint quotes must be NUT-20 locked: cdk (since PR #2295) passes the
//! mint-generated `quote_id` and the wallet's `pubkey` as first-class fields
//! on `CustomIncomingPaymentOptions`, and quote creation is refused when the
//! pubkey is missing. Melt quotes carry the quote id natively; the wallet
//! declares the payout amount in the melt quote request's `amount` field.
//!
//! The backend serves exactly one unit — the stock cdk-mintd boot handshake
//! compares its `[[payment_backend]] unit` against the single unit reported
//! by `get_settings`. The unit is set (and can change, until locked) from the
//! console without a restart.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::RwLock;

use async_trait::async_trait;
use cdk_common::nuts::{CurrencyUnit, MeltQuoteState};
use cdk_common::payment::{
    Bolt11Settings, Bolt12Settings, CreateIncomingPaymentResponse, Error, Event,
    IncomingPaymentOptions, MakePaymentResponse, MintPayment, OutgoingPaymentOptions,
    PaymentIdentifier, PaymentQuoteResponse, SettingsResponse, WaitPaymentResponse,
};
use cdk_common::Amount;
use futures::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::config::MELT_TICKET_TTL_SECS;
use crate::state::{BranchState, Ticket};

/// Single-method, single-unit payment backend for one attached mint.
pub struct BranchBackend {
    state: BranchState,
    /// The one unit this install serves. `None` until the operator completes
    /// setup in the console; updated live (no restart) when setup changes.
    unit: RwLock<Option<CurrencyUnit>>,
    method: String,
    stream_active: AtomicBool,
    /// Unix seconds of the first `wait_payment_event` attach since this
    /// process started; 0 = never. Never cleared on client disconnect — it
    /// means "the mint found this backend", not "the mint is up right now".
    stream_attached_at: AtomicU64,
    /// Unix seconds of the most recent `get_settings` call (cdk-mintd calls
    /// it while booting its `[[payment_backend]]` entry); 0 = never.
    last_settings_at: AtomicU64,
}

impl std::fmt::Debug for BranchBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchBackend")
            .field("unit", &self.unit())
            .field("method", &self.method)
            .finish()
    }
}

impl BranchBackend {
    pub fn new(state: BranchState, unit: Option<CurrencyUnit>, method: String) -> Self {
        Self {
            state,
            unit: RwLock::new(unit),
            method,
            stream_active: AtomicBool::new(false),
            stream_attached_at: AtomicU64::new(0),
            last_settings_at: AtomicU64::new(0),
        }
    }

    pub fn unit(&self) -> Option<CurrencyUnit> {
        self.unit.read().expect("unit lock").clone()
    }

    /// Live-apply a setup change from the console. The attached mint picks
    /// the new value up on its next start (it reads `get_settings` at boot).
    pub fn set_unit(&self, unit: Option<CurrencyUnit>) {
        *self.unit.write().expect("unit lock") = unit;
    }

    /// Unix seconds of the first payment-stream attach since process start.
    pub fn stream_attached_at(&self) -> Option<u64> {
        match self.stream_attached_at.load(Ordering::SeqCst) {
            0 => None,
            ts => Some(ts),
        }
    }

    /// Unix seconds of the most recent `get_settings` call.
    pub fn last_settings_at(&self) -> Option<u64> {
        match self.last_settings_at.load(Ordering::SeqCst) {
            0 => None,
            ts => Some(ts),
        }
    }

    fn configured_unit(&self) -> Result<CurrencyUnit, Error> {
        self.unit().ok_or_else(|| {
            Error::Custom(
                "branch processor is not set up yet — open its console and complete setup \
                 before pointing a mint at it"
                    .into(),
            )
        })
    }

    fn check_unit(&self, unit: &CurrencyUnit) -> Result<(), Error> {
        let configured = self.configured_unit()?;
        if *unit != configured {
            tracing::warn!(
                "rejecting request for unit {unit:?}; this processor serves {configured:?}"
            );
            return Err(Error::UnsupportedUnit);
        }
        Ok(())
    }
}

#[async_trait]
impl MintPayment for BranchBackend {
    type Err = Error;

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        let first = self
            .last_settings_at
            .swap(unix_now(), Ordering::SeqCst)
            == 0;
        if first {
            // Settle open consoles' checklist without a manual refresh.
            self.state.notify_ui_change();
        }
        // Erroring here (instead of reporting an empty unit) makes a mint
        // pointed at an unconfigured processor fail its boot with a message
        // that says what to do, rather than a unit-mismatch riddle.
        let unit = self.configured_unit()?;
        let mut custom = std::collections::HashMap::new();
        custom.insert(self.method.clone(), "{}".to_string());
        Ok(SettingsResponse {
            // The stock boot handshake compares this against the mint's
            // `[[payment_backend]] unit` (strict, modulo sat/msat) — one unit
            // per install.
            unit: unit.to_string(),
            // bolt is not a valid rail here; advertising None for both is intentional.
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
                // The proto still omits the method name (server-side sets "").
                // Whatever method the mint advertises that points at us IS our
                // method — see `get_settings` where we declare it.
                let amount = opts
                    .amount
                    .as_ref()
                    .ok_or_else(|| Error::Custom("an amount is required".into()))?;
                self.check_unit(amount.unit())?;
                if amount.value() == 0 {
                    return Err(Error::Custom("amount must be greater than zero".into()));
                }
                // NUT-20 lock policy: cash over the counter is only safe when
                // the customer's wallet alone can mint the paid quote. The
                // mint verifies signatures at mint time; we require the lock
                // to exist at creation time.
                if opts.pubkey.is_none() {
                    return Err(Error::Custom(
                        "branch mint quotes must be locked to a wallet key (NUT-20): create \
                         the quote with a pubkey"
                            .into(),
                    ));
                }
                let quote_id = opts.quote_id.to_string();
                let unit = amount.unit().to_string();
                let ticket = Ticket::new_incoming(
                    quote_id,
                    amount.value(),
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
        self.check_unit(unit)?;
        match options {
            OutgoingPaymentOptions::Custom(opts) => {
                // The wallet declares the payout amount in the melt quote
                // request's `amount` field; the mint requires proofs covering
                // exactly what we echo back, so misdeclaring cannot profit.
                let amount = opts
                    .amount
                    .as_ref()
                    .map(|amount| amount.value())
                    .filter(|value| *value > 0)
                    .ok_or_else(|| {
                        Error::Custom(
                            "branch melt quotes must declare a positive `amount`".into(),
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
                    Some(unix_now() + MELT_TICKET_TTL_SECS),
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
        self.check_unit(unit)?;
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
        let first = self
            .stream_attached_at
            .compare_exchange(0, unix_now(), Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if first {
            // The "mint is linked" checklist row just turned green — settle
            // open consoles without a manual refresh.
            self.state.notify_ui_change();
        }
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
