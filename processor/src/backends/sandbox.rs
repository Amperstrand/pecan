//! Sandbox payment backend — a generic template for testing payment flows.
//!
//! Implements the same `MintPayment` trait as the branch/teller backend,
//! with configurable behavior based on the amount's last digit. This
//! demonstrates every outcome a real payment processor might produce,
//! without referencing any specific payment provider.
//!
//! Rules (by last digit of amount in smallest unit):
//!   0 → instant auto-settle     3 → ambiguous (unknown status)
//!   1 → delayed auto-settle    4 → timeout (never resolves)
//!   2 → refused                5-9 → manual (teller workflow)
//!
//! SANDBOX_AUTO_SETTLE=true makes 5-9 also auto-settle (for CI).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use cdk_common::nuts::{CurrencyUnit, MeltQuoteState};
use cdk_common::payment::{
    Bolt11Settings, Bolt12Settings, CreateIncomingPaymentResponse, Error, Event,
    IncomingPaymentOptions, MakePaymentResponse, MintPayment, OutgoingPaymentOptions,
    PaymentIdentifier, PaymentQuoteResponse, SettingsResponse, WaitPaymentResponse,
};
use cdk_common::Amount;
use futures::Stream;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

#[derive(Debug, Clone)]
pub enum SandboxBehavior {
    Instant,
    Delayed(Duration),
    Refused,
    Ambiguous,
    Timeout,
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
    settled: bool,
}

pub struct SandboxBackend {
    method: String,
    unit: Mutex<Option<CurrencyUnit>>,
    tickets: Arc<Mutex<HashMap<String, SandboxTicket>>>,
    event_tx: broadcast::Sender<Event>,
    auto_settle: bool,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs()
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

    fn configured_unit(&self) -> Result<CurrencyUnit, Error> {
        self.unit()
            .ok_or_else(|| Error::Custom("sandbox unit not configured".into()))
    }

    fn behavior_for(&self, amount: u64) -> SandboxBehavior {
        let behavior = SandboxBehavior::from_last_digit(amount);
        if self.auto_settle && matches!(behavior, SandboxBehavior::Manual) {
            return SandboxBehavior::Instant;
        }
        behavior
    }

    fn spawn_auto_settle(&self, quote_id: String, amount: u64, unit: String, delay: Duration) {
        let tickets = Arc::clone(&self.tickets);
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(ticket) = tickets.lock().expect("tickets").get_mut(&quote_id) {
                if !ticket.settled {
                    ticket.settled = true;
                    let unit_typed = CurrencyUnit::Custom(unit.as_str().into());
                    let _ = event_tx.send(Event::PaymentReceived(WaitPaymentResponse {
                        payment_identifier: PaymentIdentifier::CustomId(quote_id.clone()),
                        payment_amount: Amount::new(amount, unit_typed),
                        payment_id: format!("sandbox-{quote_id}"),
                    }));
                }
            }
        });
    }
}

#[async_trait]
impl MintPayment for SandboxBackend {
    type Err = Error;

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        let unit = self.configured_unit()?;
        let mut custom = HashMap::new();
        custom.insert(self.method.clone(), "{}".to_string());
        Ok(SettingsResponse {
            unit: unit.to_string(),
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
                let amount = opts
                    .amount
                    .as_ref()
                    .ok_or_else(|| Error::Custom("amount required".into()))?;
                let behavior = self.behavior_for(amount.value());

                match behavior {
                    SandboxBehavior::Refused => Err(Error::Custom(
                        "sandbox: amounts ending in 2 are refused".into(),
                    )),
                    _ => {
                        let quote_id = opts.quote_id.to_string();
                        let unit = amount.unit().to_string();
                        let amt = amount.value();

                        self.tickets.lock().expect("tickets").insert(
                            quote_id.clone(),
                            SandboxTicket {
                                quote_id: quote_id.clone(),
                                amount: amt,
                                unit: unit.clone(),
                                behavior: behavior.clone(),
                                settled: false,
                            },
                        );

                        match behavior {
                            SandboxBehavior::Instant => {
                                self.spawn_auto_settle(quote_id.clone(), amt, unit, Duration::from_millis(100));
                            }
                            SandboxBehavior::Delayed(d) => {
                                self.spawn_auto_settle(quote_id.clone(), amt, unit, d);
                            }
                            _ => {}
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
        _unit: &CurrencyUnit,
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

                let unit = self.configured_unit()?;
                let state = match behavior {
                    SandboxBehavior::Timeout => MeltQuoteState::Unknown,
                    _ => MeltQuoteState::Unpaid,
                };

                Ok(PaymentQuoteResponse {
                    request_lookup_id: Some(PaymentIdentifier::CustomId(format!(
                        "SANDBOX-MELT-{}",
                        amount.value()
                    ))),
                    amount: amount.clone(),
                    fee: Amount::new(0, unit),
                    state,
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
                let unit = self.configured_unit()?;

                let quote_id = opts.quote_id.to_string();

                match behavior {
                    SandboxBehavior::Refused => Err(Error::Custom(
                        "sandbox: amounts ending in 2 are refused".into(),
                    )),
                    SandboxBehavior::Ambiguous => Err(Error::Custom(
                        "sandbox: amounts ending in 3 settle ambiguously".into(),
                    )),
                    SandboxBehavior::Timeout => Err(Error::Custom(
                        "sandbox: amounts ending in 4 never resolve".into(),
                    )),
                    SandboxBehavior::Instant => Ok(MakePaymentResponse {
                        payment_lookup_id: PaymentIdentifier::CustomId(quote_id.clone()),
                        payment_proof: Some(format!("sandbox:instant:{quote_id}")),
                        status: MeltQuoteState::Paid,
                        total_spent: Amount::new(amount.value(), unit),
                    }),
                    SandboxBehavior::Delayed(_) | SandboxBehavior::Manual => {
                        Ok(MakePaymentResponse {
                            payment_lookup_id: PaymentIdentifier::CustomId(quote_id.clone()),
                            payment_proof: None,
                            status: MeltQuoteState::Pending,
                            total_spent: Amount::new(amount.value(), unit),
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
        Ok(tickets
            .values()
            .filter(|t| t.settled)
            .map(|t| {
                let unit_typed = CurrencyUnit::Custom(t.unit.as_str().into());
                WaitPaymentResponse {
                    payment_identifier: PaymentIdentifier::CustomId(t.quote_id.clone()),
                    payment_amount: Amount::new(t.amount, unit_typed),
                    payment_id: format!("sandbox-{}", t.quote_id),
                }
            })
            .collect())
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
        let unit = self.configured_unit()?;

        if let Some(ticket) = tickets.get(&id) {
            let status = if ticket.settled {
                MeltQuoteState::Paid
            } else {
                MeltQuoteState::Pending
            };
            Ok(MakePaymentResponse {
                payment_lookup_id: PaymentIdentifier::CustomId(id),
                payment_proof: if ticket.settled {
                    Some(format!("sandbox:settled:{}", ticket.quote_id))
                } else {
                    None
                },
                status,
                total_spent: Amount::new(ticket.amount, unit),
            })
        } else {
            Ok(MakePaymentResponse {
                payment_lookup_id: identifier.clone(),
                payment_proof: None,
                status: MeltQuoteState::Unknown,
                total_spent: Amount::new(0, unit),
            })
        }
    }
}
