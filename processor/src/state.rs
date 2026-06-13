//! Persistent ticket state for the branch processor.
//!
//! All pending and settled mint/melt tickets are stored in a single JSON file on
//! disk. The file is fully rewritten on every mutation (atomic rename), which is
//! more than fine at the scale this is built for (manual branch ops, dozens of
//! tickets per day at most).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use cdk_common::nuts::{CurrencyUnit, MeltQuoteState};
use cdk_common::payment::{Event, MakePaymentResponse, PaymentIdentifier, WaitPaymentResponse};
use cdk_common::Amount;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketKind {
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketStatus {
    Waiting,
    Pending,
    Paid,
    Failed,
}

impl TicketStatus {
    pub fn is_active(self) -> bool {
        matches!(self, TicketStatus::Waiting | TicketStatus::Pending)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    #[serde(default)]
    pub quote_id: Option<String>,
    pub kind: TicketKind,
    pub amount: u64,
    pub unit: String,
    pub status: TicketStatus,
    pub created_at: u64,
    pub paid_at: Option<u64>,
    pub description: Option<String>,
    /// Free-form notes added by the operator.
    pub notes: Option<String>,
}

impl Ticket {
    pub fn new_incoming(amount: u64, unit: String, description: Option<String>) -> Self {
        Self {
            id: format!("MINT-{}", uuid::Uuid::new_v4()),
            quote_id: None,
            kind: TicketKind::Incoming,
            amount,
            unit,
            status: TicketStatus::Pending,
            created_at: unix_now(),
            paid_at: None,
            description,
            notes: None,
        }
    }

    pub fn new_outgoing_quote(
        id: String,
        quote_id: String,
        amount: u64,
        unit: String,
        description: Option<String>,
    ) -> Self {
        Self {
            id,
            quote_id: Some(quote_id),
            kind: TicketKind::Outgoing,
            amount,
            unit,
            status: TicketStatus::Waiting,
            created_at: unix_now(),
            paid_at: None,
            description,
            notes: None,
        }
    }

    pub fn unit_typed(&self) -> CurrencyUnit {
        self.unit
            .parse()
            .unwrap_or(CurrencyUnit::Custom(self.unit.clone()))
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    tickets: BTreeMap<String, Ticket>,
}

/// Shared, mutable state of the branch processor.
#[derive(Clone)]
pub struct BranchState {
    inner: Arc<Inner>,
}

struct Inner {
    tickets: RwLock<BTreeMap<String, Ticket>>,
    path: PathBuf,
    /// Broadcast so the mint can reconnect (`wait_payment_event` again) without
    /// us having to coordinate "stream already taken" semantics.
    event_tx: broadcast::Sender<Event>,
    /// Coarse "something changed" notifier for the web UI's SSE stream.
    ui_changed_tx: broadcast::Sender<()>,
}

impl std::fmt::Debug for BranchState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BranchState").finish_non_exhaustive()
    }
}

impl BranchState {
    pub async fn load(path: PathBuf) -> Result<Self> {
        let tickets = if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            let raw = tokio::fs::read(&path)
                .await
                .with_context(|| format!("read {}", path.display()))?;
            let file: StateFile = serde_json::from_slice(&raw).unwrap_or_default();
            file.tickets
        } else {
            BTreeMap::new()
        };
        let (tx, _rx) = broadcast::channel(256);
        let (ui_tx, _ui_rx) = broadcast::channel(256);
        Ok(Self {
            inner: Arc::new(Inner {
                tickets: RwLock::new(tickets),
                path,
                event_tx: tx,
                ui_changed_tx: ui_tx,
            }),
        })
    }

    pub async fn list_all(&self) -> Vec<Ticket> {
        self.inner.tickets.read().await.values().cloned().collect()
    }

    pub async fn active_tickets(&self) -> Vec<Ticket> {
        self.inner
            .tickets
            .read()
            .await
            .values()
            .filter(|t| t.status.is_active())
            .cloned()
            .collect()
    }

    /// Insert a new active teller quote only if no other active quote exists.
    /// This is the server-side guard that keeps branch settlement one-at-a-time.
    pub async fn insert_active(&self, ticket: Ticket) -> Result<Ticket> {
        let updated = {
            let mut t = self.inner.tickets.write().await;
            if let Some(existing) = t.get(&ticket.id) {
                return Ok(existing.clone());
            }
            if let Some(active) = t
                .values()
                .find(|existing| existing.status.is_active() && existing.id != ticket.id)
            {
                bail!("finish active quote {} before creating another", active.id);
            }
            t.insert(ticket.id.clone(), ticket.clone());
            ticket
        };
        self.persist().await?;
        self.notify_ui_change();
        Ok(updated)
    }

    pub async fn attach_quote_id(&self, id: &str, quote_id: String) -> Result<Ticket> {
        let updated = {
            let mut t = self.inner.tickets.write().await;
            let ticket = t
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("ticket {id} not found"))?;
            ticket.quote_id = Some(quote_id);
            ticket.clone()
        };
        self.persist().await?;
        self.notify_ui_change();
        Ok(updated)
    }

    /// Move a pre-created outgoing quote into the state where customer proofs
    /// are locked by the mint and the operator can safely dispense cash.
    pub async fn mark_outgoing_submitted(&self, id: &str) -> Result<Ticket> {
        let mut changed = false;
        let updated = {
            let mut t = self.inner.tickets.write().await;
            let ticket = t.get_mut(id).ok_or_else(|| {
                anyhow::anyhow!("outgoing quote {id} was not created by the teller UI")
            })?;
            if ticket.kind != TicketKind::Outgoing {
                bail!("ticket {id} is not an outgoing quote");
            }
            if ticket.status == TicketStatus::Waiting {
                ticket.status = TicketStatus::Pending;
                changed = true;
            }
            ticket.clone()
        };
        if changed {
            self.persist().await?;
            self.notify_ui_change();
        }
        Ok(updated)
    }

    /// Mark a ticket as paid. For incoming tickets, also pushes a
    /// `PaymentReceived` event into the mint's `wait_payment_event` stream so
    /// the mint flips the mint-quote to PAID without polling.
    ///
    /// Returns the updated ticket. Errors if the ticket doesn't exist.
    pub async fn mark_paid(&self, id: &str, notes: Option<String>) -> Result<Ticket> {
        let updated = {
            let mut t = self.inner.tickets.write().await;
            let ticket = t
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("ticket {id} not found"))?;
            if ticket.status == TicketStatus::Waiting {
                bail!("ticket {id} is waiting for the wallet");
            }
            if ticket.status == TicketStatus::Pending {
                ticket.status = TicketStatus::Paid;
                ticket.paid_at = Some(unix_now());
                if let Some(n) = notes {
                    ticket.notes = Some(n);
                }
            }
            ticket.clone()
        };
        self.persist().await?;

        if updated.kind == TicketKind::Incoming {
            let amount = Amount::new(updated.amount, updated.unit_typed());
            let event = Event::PaymentReceived(WaitPaymentResponse {
                payment_identifier: PaymentIdentifier::CustomId(updated.id.clone()),
                payment_amount: amount,
                payment_id: format!("{}-receipt", updated.id),
            });
            // best-effort — if no subscriber, mint will pick up on next reconnect via check_incoming_payment_status
            let _ = self.inner.event_tx.send(event);
        }

        self.notify_ui_change();
        Ok(updated)
    }

    pub async fn mark_failed(&self, id: &str, notes: Option<String>) -> Result<Ticket> {
        let updated = {
            let mut t = self.inner.tickets.write().await;
            let ticket = t
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("ticket {id} not found"))?;
            if ticket.status != TicketStatus::Paid {
                ticket.status = TicketStatus::Failed;
                if let Some(n) = notes {
                    ticket.notes = Some(n);
                }
            }
            ticket.clone()
        };
        self.persist().await?;
        self.notify_ui_change();
        Ok(updated)
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<Event> {
        self.inner.event_tx.subscribe()
    }

    pub fn subscribe_ui_changes(&self) -> broadcast::Receiver<()> {
        self.inner.ui_changed_tx.subscribe()
    }

    pub fn notify_ui_change(&self) {
        let _ = self.inner.ui_changed_tx.send(());
    }

    /// Look up an incoming ticket by its payment identifier and translate to
    /// the WaitPaymentResponse the mint expects from `check_incoming_payment_status`.
    pub async fn lookup_incoming(&self, id: &PaymentIdentifier) -> Vec<WaitPaymentResponse> {
        let ticket_id = match id {
            PaymentIdentifier::CustomId(s) => s.clone(),
            _ => return Vec::new(),
        };
        let tickets = self.inner.tickets.read().await;
        let Some(t) = tickets.get(&ticket_id) else {
            return Vec::new();
        };
        if t.kind != TicketKind::Incoming || t.status != TicketStatus::Paid {
            return Vec::new();
        }
        vec![WaitPaymentResponse {
            payment_identifier: PaymentIdentifier::CustomId(t.id.clone()),
            payment_amount: Amount::new(t.amount, t.unit_typed()),
            payment_id: format!("{}-receipt", t.id),
        }]
    }

    /// Same as `lookup_incoming` but for outgoing (melt) tickets — returns a
    /// MakePaymentResponse the mint uses to advance the melt quote.
    pub async fn lookup_outgoing(&self, id: &PaymentIdentifier) -> Option<MakePaymentResponse> {
        let ticket_id = match id {
            PaymentIdentifier::CustomId(s) => s.clone(),
            _ => return None,
        };
        let tickets = self.inner.tickets.read().await;
        let t = tickets.get(&ticket_id)?;
        if t.kind != TicketKind::Outgoing {
            return None;
        }
        let status = match t.status {
            TicketStatus::Paid => MeltQuoteState::Paid,
            TicketStatus::Pending => MeltQuoteState::Pending,
            TicketStatus::Waiting => MeltQuoteState::Unpaid,
            TicketStatus::Failed => MeltQuoteState::Failed,
        };
        Some(MakePaymentResponse {
            payment_lookup_id: PaymentIdentifier::CustomId(t.id.clone()),
            payment_proof: t.notes.clone(),
            status,
            total_spent: Amount::new(t.amount, t.unit_typed()),
        })
    }

    async fn persist(&self) -> Result<()> {
        let tickets = self.inner.tickets.read().await.clone();
        let file = StateFile { tickets };
        let bytes = serde_json::to_vec_pretty(&file)?;
        let tmp = self.inner.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, &self.inner.path).await?;
        Ok(())
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
