//! `MintPayment` implementation for the "branch" custom payment method.
//!
//! Quote creation follows NUT-XX quote offers: the operator registers a ticket
//! and hands the wallet a serialized offer; the wallet then requests a mint or
//! melt quote referencing the ticket. The first quote request claiming a ticket
//! wins, all subsequent ones are rejected, and requests whose parameters do not
//! match the ticket are rejected. Requests without a valid ticket are rejected
//! outright, preserving the operator-initiated-only property of this backend.

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

use crate::state::{BranchState, TicketStatus};

/// Top-level field of the wallet's NUT-04 quote request (flattened into
/// `extra_json` by cdk) that carries the NUT-XX offer ticket.
pub const TICKET_FIELD: &str = "ticket";

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

    /// Extract the NUT-XX offer ticket from the flattened extra fields of the
    /// wallet's mint quote request. A branch mint quote without a ticket is
    /// rejected — quotes exist only by claiming a teller-issued offer.
    fn ticket_from_extra(&self, extra_json: Option<&str>) -> Result<String, Error> {
        let raw = extra_json.ok_or_else(|| {
            Error::Custom("20010: branch quotes are claimed from a teller offer; missing ticket".into())
        })?;
        let value: Value = serde_json::from_str(raw)
            .map_err(|e| Error::Custom(format!("quote request metadata is invalid JSON: {e}")))?;
        value
            .get(TICKET_FIELD)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                Error::Custom(
                    "20010: branch quotes are claimed from a teller offer; missing ticket".into(),
                )
            })
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
                //
                // NOTE: the wallet's NUT-20 `pubkey` is consumed by cdk before this call,
                // so the spec's "MUST NOT create a quote for a ticket without a pubkey"
                // cannot be enforced here with a stock mint.
                self.check_unit(opts.amount.unit())?;
                let ticket_id = self.ticket_from_extra(opts.extra_json.as_deref())?;
                let ticket = self
                    .state
                    .claim_incoming(&ticket_id, opts.amount.value(), &self.unit.to_string())
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                Ok(CreateIncomingPaymentResponse {
                    request_lookup_id: PaymentIdentifier::CustomId(ticket.id.clone()),
                    // The "payment request" the wallet displays; for branch it simply
                    // echoes the claimed ticket.
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
                // See note in create_incoming_payment_request — method not on the wire.
                // NUT-XX melt claim: the NUT-05 `request` string IS the offer ticket.
                // The payout amount is authoritative from the registered ticket — the
                // wallet cannot choose it.
                let ticket_id = opts.request.trim().to_string();
                let ticket = self
                    .state
                    .claim_outgoing(&ticket_id, &self.unit.to_string(), opts.quote_id.to_string())
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                Ok(PaymentQuoteResponse {
                    request_lookup_id: Some(PaymentIdentifier::CustomId(ticket.id)),
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
                // Resolve the ticket the quote id was attached to during claiming;
                // fall back to the request string (the ticket id) for robustness.
                let ticket_id = match self
                    .state
                    .outgoing_by_quote_id(&opts.quote_id.to_string())
                    .await
                {
                    Some(t) => t.id,
                    None => opts.request.trim().to_string(),
                };
                let ticket = self
                    .state
                    .mark_outgoing_submitted(&ticket_id)
                    .await
                    .map_err(|e| Error::Custom(e.to_string()))?;
                let status = match ticket.status {
                    TicketStatus::Paid => MeltQuoteState::Paid,
                    TicketStatus::Pending | TicketStatus::Waiting => MeltQuoteState::Pending,
                    TicketStatus::Offered => MeltQuoteState::Unpaid,
                    TicketStatus::Failed => MeltQuoteState::Failed,
                };
                Ok(MakePaymentResponse {
                    payment_lookup_id: PaymentIdentifier::CustomId(ticket.id.clone()),
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
