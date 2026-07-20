//! `MintPayment` implementation for the "branch" custom payment method.
//!
//! Branch quotes are created by the operator UI. The UI sends a teller marker
//! and amount metadata to cdk-mintd, which forwards that metadata here over the
//! payment-processor interface. Wallets fetch existing quote ids instead of
//! creating branch quotes themselves.

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

use crate::state::{BranchState, Ticket, TicketStatus};

pub const TELLER_QUOTE_MARKER: &str = "branch_teller_quote";
pub const TELLER_AMOUNT_FIELD: &str = "amount";
pub const TELLER_MELT_REQUEST: &str = "teller";

/// Single-method, single-unit payment backend. Everything not matching the
/// configured `method` is rejected with `UnsupportedPaymentOption`.
pub struct BranchBackend {
    state: BranchState,
    unit: CurrencyUnit,
    method: String,
    stream_active: AtomicBool,
}

impl std::fmt::Debug for BranchBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchBackend")
            .field("unit", &self.unit)
            .field("method", &self.method)
            .finish()
    }
}

impl BranchBackend {
    pub fn new(state: BranchState, unit: CurrencyUnit, method: String) -> Self {
        Self {
            state,
            unit,
            method,
            stream_active: AtomicBool::new(false),
        }
    }

    fn check_unit(&self, unit: &CurrencyUnit) -> Result<(), Error> {
        if unit != &self.unit {
            tracing::warn!(
                "rejecting request for unit {unit:?}, this backend serves only {:?}",
                self.unit
            );
            return Err(Error::UnsupportedUnit);
        }
        Ok(())
    }

    fn teller_extra(&self, extra_json: Option<&str>) -> Result<Value, Error> {
        let raw = extra_json.ok_or_else(|| {
            Error::Custom("branch quotes must be created by the teller UI".into())
        })?;
        let value: Value = serde_json::from_str(raw)
            .map_err(|e| Error::Custom(format!("branch quote metadata is invalid JSON: {e}")))?;
        if value.get(TELLER_QUOTE_MARKER).and_then(Value::as_bool) != Some(true) {
            return Err(Error::Custom(
                "branch quotes must be created by the teller UI".into(),
            ));
        }
        Ok(value)
    }

    fn teller_outgoing_amount(&self, extra_json: Option<&str>) -> Result<u64, Error> {
        let value = self.teller_extra(extra_json)?;
        let amount = value
            .get(TELLER_AMOUNT_FIELD)
            .and_then(Value::as_u64)
            .filter(|amount| *amount > 0)
            .ok_or_else(|| {
                Error::Custom("branch melt quote metadata must include a positive amount".into())
            })?;
        Ok(amount)
    }

    /// Derive a stable ticket id from the mint's quote id. The same quote_id
    /// is supplied in `get_payment_quote` and `make_payment` (proto >= 3.0.0,
    /// see cdk PR adding `quote_id` to `*OutgoingPaymentOptions`), so the
    /// resulting ticket id is identical across both calls. No wallet-side
    /// uniqueness in `request` is required.
    fn derive_melt_ticket_id(&self, quote_id: &cdk_common::QuoteId) -> String {
        format!("MELT-{}", quote_id)
    }
}

#[async_trait]
impl MintPayment for BranchBackend {
    type Err = Error;

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        let mut custom = std::collections::HashMap::new();
        custom.insert(self.method.clone(), "{}".to_string());
        Ok(SettingsResponse {
            unit: self.unit.to_string(),
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
                // — see `get_settings` below where we declare it.
                let _extra = self.teller_extra(opts.extra_json.as_deref())?;
                self.check_unit(opts.amount.unit())?;
                let ticket = Ticket::new_incoming(
                    opts.amount.value(),
                    self.unit.to_string(),
                    opts.description.clone(),
                );
                let id = ticket.id.clone();
                let expiry = opts.unix_expiry;
                self.state
                    .insert_active(ticket)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                Ok(CreateIncomingPaymentResponse {
                    request_lookup_id: PaymentIdentifier::CustomId(id.clone()),
                    // The "payment request" the wallet displays. For branch this is just
                    // a human-readable ticket identifier — the customer takes this to the
                    // branch and the operator marks it paid against this ID.
                    request: id,
                    expiry,
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
                // See note in create_incoming_payment_request — method not on the wire.
                let amount = self.teller_outgoing_amount(opts.extra_json.as_deref())?;
                // Use the mint's quote_id as the stable correlation key — it's
                // identical in `make_payment` for this same melt.
                let ticket_id = self.derive_melt_ticket_id(&opts.quote_id);
                let ticket = Ticket::new_outgoing_quote(
                    ticket_id.clone(),
                    opts.quote_id.to_string(),
                    amount,
                    self.unit.to_string(),
                    Some(opts.request.clone()),
                );
                let ticket = self
                    .state
                    .insert_active(ticket)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                Ok(PaymentQuoteResponse {
                    request_lookup_id: Some(PaymentIdentifier::CustomId(ticket_id)),
                    amount: Amount::new(ticket.amount, self.unit.clone()),
                    fee: Amount::new(0, self.unit.clone()),
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
                // See note in create_incoming_payment_request — method not on the wire.
                // Same id `get_payment_quote` returned (derived from the same
                // quote_id). The amount was captured when the teller created
                // the quote, so the wallet's request string is not parsed here.
                let ticket_id = self.derive_melt_ticket_id(&opts.quote_id);
                let ticket = self
                    .state
                    .mark_outgoing_submitted(&ticket_id)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                let status = match ticket.status {
                    TicketStatus::Paid => MeltQuoteState::Paid,
                    TicketStatus::Pending | TicketStatus::Waiting => MeltQuoteState::Pending,
                    TicketStatus::Failed => MeltQuoteState::Failed,
                };
                Ok(MakePaymentResponse {
                    payment_lookup_id: PaymentIdentifier::CustomId(ticket_id),
                    payment_proof: ticket.notes.clone(),
                    // The mint will poll check_outgoing_payment until the operator
                    // confirms cash handover via the UI.
                    status,
                    total_spent: Amount::new(ticket.amount, self.unit.clone()),
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
