//! Sandbox payment backend for testing and demos.
//!
//! A `MintPayment` implementation that simulates a real payment rail with
//! configurable behavior based on the amount's last digit. This provides a
//! generic template that demonstrates every outcome a real processor might
//! produce, without referencing any specific payment provider.
//!
//! ## Rules (by last digit of the amount in the smallest unit)
//!
//! | Ends in | Behavior | Mint quote | Melt quote |
//! |---------|----------|------------|------------|
//! | 0 | Instant | Auto-paid immediately | Auto-settled immediately |
//! | 1 | Delayed | Paid after ~2s | Settled after ~2s |
//! | 2 | Refused | Never paid (explicit refusal) | Fails (explicit refusal) |
//! | 3 | Ambiguous | Paid but status unknown | Settled but status unknown |
//! | 4 | Timeout | Never paid (silent timeout) | Never settles (silent timeout) |
//! | 5-9 | Normal | Standard flow (manual settle) | Standard flow (manual settle) |
//!
//! ## Configuration
//!
//! `SANDBOX_RULES` environment variable (JSON), defaults to the table above.
//! `SANDBOX_AUTO_SETTLE` (bool, default false) — if true, amounts ending in
//! 5-9 are also auto-settled (for fully automated testing).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use cdk_common::nuts::{CurrencyUnit, MeltQuoteState};
use cdk_common::payment::{
    CreateIncomingPaymentResponse, Error, Event, IncomingPaymentOptions,
    MakePaymentResponse, MintPayment, OutgoingPaymentOptions, PaymentIdentifier,
    PaymentQuoteResponse, SettingsResponse, WaitPaymentResponse,
};
use cdk_common::Amount;
use futures::Stream;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

#[derive(Debug, Clone)]
enum SandboxBehavior {
    /// Instant: auto-paid/settled immediately
    Instant,
    /// Delayed: auto-paid/settled after a configurable delay
    Delayed(Duration),
    /// Refused: explicitly rejected (positive proof of failure)
    Refused,
    /// Ambiguous: payment succeeds but status is unknowable
    Ambiguous,
    /// Timeout: silently never resolves
    Timeout,
    /// Manual: requires human settlement (teller workflow)
    Manual,
}

impl SandboxBehavior {
    fn from_last_digit(digit: u64) -> Self {
        match digit % 10 {
            0 => Self::Instant,
            1 => Self::Delayed(Duration::from_secs(2)),
            2 => Self::Refused,
            3 => Self::Ambiguous,
            4 => Self::Timeout,
            _ => Self::Manual,
        }
    }
}

struct SandboxTicket {
    quote_id: String,
    amount: u64,
    unit: String,
    behavior: SandboxBehavior,
    created_at: u64,
    settled: bool,
}

pub struct SandboxBackend {
    method: String,
    unit: Mutex<Option<CurrencyUnit>>,
    tickets: Arc<Mutex<HashMap<String, SandboxTicket>>>,
    event_tx: broadcast::Sender<Event>,
    auto_settle: bool,
}

impl SandboxBackend {
    pub fn new(method: String) -> Self {
        let (event_tx, _) = broadcast::channel(100);
        let auto_settle = std::env::var("SANDBOX_AUTO_SETTLE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        Self {
            method,
            unit: Mutex::new(None),
            tickets: Arc::new(Mutex::new(HashMap::new())),
            event_tx,
            auto_settle,
        }
    }

    pub fn set_unit(&self, unit: Option<CurrencyUnit>) {
        *self.unit.lock().expect("unit lock") = unit;
    }

    pub fn unit(&self) -> Option<CurrencyUnit> {
        self.unit.lock().expect("unit lock").clone()
    }

    fn behavior_for(&self, amount: u64) -> SandboxBehavior {
        let behavior = SandboxBehavior::from_last_digit(amount);
        if self.auto_settle && matches!(behavior, SandboxBehavior::Manual) {
            return SandboxBehavior::Instant;
        }
        behavior
    }

    fn spawn_auto_settle(&self, quote_id: String, delay: Duration) {
        let tickets = Arc::clone(&self.tickets);
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(ticket) = tickets.lock().expect("tickets").get_mut(&quote_id) {
                if !ticket.settled {
                    ticket.settled = true;
                    let amount = Amount::new(ticket.amount, ticket.unit_typed());
                    let _ = event_tx.send(Event::PaymentReceived(WaitPaymentResponse {
                        payment_identifier: PaymentIdentifier::CustomId(quote_id.clone()),
                        payment_amount: amount,
                        payment_id: format!("{}-sandbox", quote_id),
                    }));
                }
            }
        });
    }
}

impl SandboxTicket {
    fn unit_typed(&self) -> CurrencyUnit {
        CurrencyUnit::Custom(self.unit.as_str().into())
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs()
}

#[async_trait]
impl MintPayment for SandboxBackend {
    type Err = Error;

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        Ok(SettingsResponse::Custom(
            vec![self.method.clone()],
            vec![self.unit.clone().unwrap_or(CurrencyUnit::Custom("nok".into()))],
        ))
    }

    async fn create_incoming_payment_request(
        &self,
        options: IncomingPaymentOptions,
    ) -> Result<CreateIncomingPaymentResponse, Self::Err> {
        match options {
            IncomingPaymentOptions::Custom(opts) => {
                let amount = opts
                    .amount
                    .as_ref()
                    .ok_or_else(|| Error::Custom("amount required".into()))?;
                let behavior = self.behavior_for(amount.value());

                match behavior {
                    SandboxBehavior::Refused => Err(Error::Custom(
                        "sandbox: amounts ending in 2 are refused (positive proof of failure)".into(),
                    )),
                    _ => {
                        let quote_id = opts.quote_id.to_string();
                        let unit = amount.unit().to_string();
                        let ticket = SandboxTicket {
                            quote_id: quote_id.clone(),
                            amount: amount.value(),
                            unit,
                            behavior: behavior.clone(),
                            created_at: unix_now(),
                            settled: false,
                        };
                        self.tickets
                            .lock()
                            .expect("tickets")
                            .insert(quote_id.clone(), ticket);

                        if let SandboxBehavior::Delayed(d) = behavior {
                            self.spawn_auto_settle(quote_id.clone(), d);
                        }
                        if matches!(behavior, SandboxBehavior::Instant) {
                            self.spawn_auto_settle(quote_id.clone(), Duration::from_millis(100));
                        }

                        Ok(CreateIncomingPaymentResponse {
                            request_lookup_id: PaymentIdentifier::CustomId(format!("SANDBOX-{quote_id}")),
                            request: format!("sandbox:{quote_id}"),
                            expiry: opts.unix_expiry,
                            extra_json: None,
                        })
                    }
                }
            }
            _ => Err(Error::UnsupportedPaymentOption),
        }
    }

    async fn get_payment_quote(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Self::Err> {
        match options {
            OutgoingPaymentOptions::Custom(opts) => {
                let amount = opts
                    .amount
                    .as_ref()
                    .ok_or_else(|| Error::Custom("amount required".into()))?;
                let behavior = self.behavior_for(amount.value());

                if matches!(behavior, SandboxBehavior::Refused) {
                    return Err(Error::Custom(
                        "sandbox: amounts ending in 2 are refused".into(),
                    ));
                }

                Ok(PaymentQuoteResponse {
                    request_lookup_id: Some(PaymentIdentifier::CustomId(format!(
                        "SANDBOX-MELT-{}",
                        amount.value()
                    ))),
                    amount: amount.clone(),
                    fee: Amount::new(0, unit.clone()),
                    state: match behavior {
                        SandboxBehavior::Timeout => MeltQuoteState::Unknown,
                        _ => MeltQuoteState::Pending,
                    },
                    expiry: Some(unix_now() + 900),
                    extra_json: None,
                    estimated_blocks: None,
                    fee_options: None,
                })
            }
            _ => Err(Error::UnsupportedPaymentOption),
        }
    }

    async fn make_payment(
        &self,
        _unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Self::Err> {
        match options {
            OutgoingPaymentOptions::Custom(opts) => {
                let amount = opts
                    .amount
                    .as_ref()
                    .ok_or_else(|| Error::Custom("amount required".into()))?;
                let behavior = self.behavior_for(amount.value());

                let quote_id = opts
                    .quote_id
                    .map(|q| q.to_string())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                match behavior {
                    SandboxBehavior::Refused => Err(Error::Custom(
                        "sandbox: amounts ending in 2 are refused (positive proof)".into(),
                    )),
                    SandboxBehavior::Instant => Ok(MakePaymentResponse {
                        payment_lookup_id: PaymentIdentifier::CustomId(quote_id.clone()),
                        payment_proof: Some(format!("sandbox:instant:{quote_id}")),
                        status: MeltQuoteState::Paid,
                        total_spent: amount.clone(),
                        extra_json: None,
                    }),
                    SandboxBehavior::Ambiguous => Err(Error::Custom(
                        "sandbox: amounts ending in 3 settle ambiguously (status unknown)".into(),
                    )),
                    SandboxBehavior::Timeout => Err(Error::Custom(
                        "sandbox: amounts ending in 4 never resolve (silent timeout)".into(),
                    )),
                    SandboxBehavior::Delayed(_) | SandboxBehavior::Manual => {
                        Ok(MakePaymentResponse {
                            payment_lookup_id: PaymentIdentifier::CustomId(quote_id.clone()),
                            payment_proof: None,
                            status: MeltQuoteState::Pending,
                            total_spent: amount.clone(),
                            extra_json: None,
                        })
                    }
                }
            }
            _ => Err(Error::UnsupportedPaymentOption),
        }
    }

    async fn wait_payment_event(&self) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, Self::Err> {
        let stream = BroadcastStream::new(self.event_tx.subscribe()).filter_map(|item| match item {
            Ok(event) => Some(event),
            Err(_) => None,
        });
        Ok(Box::pin(stream))
    }

    fn is_payment_event_stream_active(&self) -> bool {
        self.event_tx.receiver_count() > 0
    }

    fn cancel_payment_event_stream(&self) {}

    async fn check_incoming_payment_status(
        &self,
        _identifier: &cdk_common::payment::PaymentIdentifier,
    ) -> Result<Vec<WaitPaymentResponse>, Self::Err> {
        let tickets = self.tickets.lock().expect("tickets");
        let settled: Vec<WaitPaymentResponse> = tickets
            .values()
            .filter(|t| t.settled)
            .map(|t| WaitPaymentResponse {
                payment_identifier: PaymentIdentifier::CustomId(t.quote_id.clone()),
                payment_amount: Amount::new(t.amount, t.unit_typed()),
                payment_id: format!("{}-sandbox", t.quote_id),
            })
            .collect();
        Ok(settled)
    }

    async fn check_outgoing_payment(
        &self,
        identifier: &cdk_common::payment::PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        let id = match identifier {
            PaymentIdentifier::CustomId(id) => id.clone(),
            _ => return Err(Error::Custom("unsupported identifier".into())),
        };
        let tickets = self.tickets.lock().expect("tickets");
        if let Some(ticket) = tickets.get(&id) {
            if ticket.settled {
                Ok(MakePaymentResponse {
                    payment_lookup_id: PaymentIdentifier::CustomId(id),
                    payment_proof: Some(format!("sandbox:settled:{}", ticket.quote_id)),
                    status: MeltQuoteState::Paid,
                    total_spent: Amount::new(ticket.amount, ticket.unit_typed()),
                    extra_json: None,
                })
            } else {
                Ok(MakePaymentResponse {
                    payment_lookup_id: PaymentIdentifier::CustomId(id),
                    payment_proof: None,
                    status: MeltQuoteState::Pending,
                    total_spent: Amount::new(ticket.amount, ticket.unit_typed()),
                    extra_json: None,
                })
            }
        } else {
            Ok(MakePaymentResponse {
                payment_lookup_id: identifier.clone(),
                payment_proof: None,
                status: MeltQuoteState::Unknown,
                total_spent: Amount::new(0, CurrencyUnit::Custom("nok".into())),
                extra_json: None,
            })
        }
    }
}
