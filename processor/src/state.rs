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
    /// Ticket registered and its offer displayed; no wallet has claimed it yet.
    Offered,
    /// Outgoing only: a wallet claimed the offer (melt quote exists) but has not
    /// committed funds yet — the operator must NOT pay out in this state.
    Waiting,
    /// Incoming: claimed by a wallet, awaiting cash handover.
    /// Outgoing: funded by the wallet (proofs locked at the mint), safe to pay out.
    Pending,
    Paid,
    Failed,
}

impl TicketStatus {
    pub fn is_active(self) -> bool {
        matches!(
            self,
            TicketStatus::Offered | TicketStatus::Waiting | TicketStatus::Pending
        )
    }
}

/// Why a claim attempt was rejected. The display strings carry the NUT-XX
/// error-code semantics (20010 unknown/expired, 20011 already claimed) even
/// though stock cdk flattens processor errors before they reach the wallet.
#[derive(Debug)]
pub enum ClaimError {
    Unknown,
    Expired,
    AlreadyClaimed,
    Mismatch(String),
}

impl std::fmt::Display for ClaimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaimError::Unknown => write!(f, "20010: offer ticket is unknown or expired"),
            ClaimError::Expired => write!(f, "20010: offer ticket is unknown or expired (expired)"),
            ClaimError::AlreadyClaimed => write!(f, "20011: offer ticket has already been claimed"),
            ClaimError::Mismatch(detail) => {
                write!(f, "quote request does not match the ticket: {detail}")
            }
        }
    }
}

impl std::error::Error for ClaimError {}

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
    /// The serialized NUT-XX quote offer (`cquoteA...`) displayed to the wallet.
    #[serde(default)]
    pub offer: Option<String>,
    /// Unix timestamp until which the offer can be claimed.
    #[serde(default)]
    pub expires_at: Option<u64>,
}

impl Ticket {
    /// A freshly registered teller offer; the serialized offer string is attached
    /// by the caller once it exists (it embeds this ticket's id).
    pub fn new_offer(
        kind: TicketKind,
        amount: u64,
        unit: String,
        description: Option<String>,
        expires_at: Option<u64>,
    ) -> Self {
        let prefix = match kind {
            TicketKind::Incoming => "MINT",
            TicketKind::Outgoing => "MELT",
        };
        Self {
            id: format!("{prefix}-{}", uuid::Uuid::new_v4()),
            quote_id: None,
            kind,
            amount,
            unit,
            status: TicketStatus::Offered,
            created_at: unix_now(),
            paid_at: None,
            description,
            notes: None,
            offer: None,
            expires_at,
        }
    }

    pub fn claim_expired(&self, now: u64) -> bool {
        self.expires_at.is_some_and(|e| now > e)
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

    /// First-claim-wins for an incoming (mint) offer. Atomically transitions
    /// `Offered` → `Pending` after checking that the wallet's quote request
    /// matches the registered ticket. Subsequent claims are rejected.
    pub async fn claim_incoming(
        &self,
        ticket_id: &str,
        amount: u64,
        unit: &str,
    ) -> Result<Ticket, ClaimError> {
        let updated = {
            let mut t = self.inner.tickets.write().await;
            let ticket = t.get_mut(ticket_id).ok_or(ClaimError::Unknown)?;
            if ticket.kind != TicketKind::Incoming {
                return Err(ClaimError::Unknown);
            }
            match ticket.status {
                TicketStatus::Offered => {}
                TicketStatus::Pending | TicketStatus::Waiting | TicketStatus::Paid => {
                    return Err(ClaimError::AlreadyClaimed)
                }
                TicketStatus::Failed => return Err(ClaimError::Unknown),
            }
            if ticket.claim_expired(unix_now()) {
                return Err(ClaimError::Expired);
            }
            if ticket.amount != amount {
                return Err(ClaimError::Mismatch(format!(
                    "amount {amount} does not match ticket amount {}",
                    ticket.amount
                )));
            }
            if ticket.unit != unit {
                return Err(ClaimError::Mismatch(format!(
                    "unit {unit} does not match ticket unit {}",
                    ticket.unit
                )));
            }
            ticket.status = TicketStatus::Pending;
            ticket.clone()
        };
        if let Err(e) = self.persist().await {
            tracing::error!("persist after claim_incoming: {e}");
        }
        self.notify_ui_change();
        Ok(updated)
    }

    /// First-claim-wins for an outgoing (melt) offer. Atomically transitions
    /// `Offered` → `Waiting` and records the mint's melt quote id (used for the
    /// operator's payout verification code).
    pub async fn claim_outgoing(
        &self,
        ticket_id: &str,
        unit: &str,
        quote_id: String,
    ) -> Result<Ticket, ClaimError> {
        let updated = {
            let mut t = self.inner.tickets.write().await;
            let ticket = t.get_mut(ticket_id).ok_or(ClaimError::Unknown)?;
            if ticket.kind != TicketKind::Outgoing {
                return Err(ClaimError::Unknown);
            }
            match ticket.status {
                TicketStatus::Offered => {}
                TicketStatus::Waiting | TicketStatus::Pending | TicketStatus::Paid => {
                    return Err(ClaimError::AlreadyClaimed)
                }
                TicketStatus::Failed => return Err(ClaimError::Unknown),
            }
            if ticket.claim_expired(unix_now()) {
                return Err(ClaimError::Expired);
            }
            if ticket.unit != unit {
                return Err(ClaimError::Mismatch(format!(
                    "unit {unit} does not match ticket unit {}",
                    ticket.unit
                )));
            }
            ticket.quote_id = Some(quote_id);
            ticket.status = TicketStatus::Waiting;
            ticket.clone()
        };
        if let Err(e) = self.persist().await {
            tracing::error!("persist after claim_outgoing: {e}");
        }
        self.notify_ui_change();
        Ok(updated)
    }

    /// Find the outgoing ticket a melt quote id was attached to during claiming.
    pub async fn outgoing_by_quote_id(&self, quote_id: &str) -> Option<Ticket> {
        self.inner
            .tickets
            .read()
            .await
            .values()
            .find(|t| t.kind == TicketKind::Outgoing && t.quote_id.as_deref() == Some(quote_id))
            .cloned()
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
            if ticket.status == TicketStatus::Offered {
                bail!("ticket {id} has not been claimed by a wallet");
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
            if ticket.status == TicketStatus::Offered {
                bail!("ticket {id} has not been claimed by a wallet");
            }
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
            TicketStatus::Offered | TicketStatus::Waiting => MeltQuoteState::Unpaid,
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_state() -> BranchState {
        let path = std::env::temp_dir().join(format!("branch-state-test-{}.json", uuid::Uuid::new_v4()));
        BranchState::load(path).await.expect("load state")
    }

    fn offered(kind: TicketKind, amount: u64, expires_at: Option<u64>) -> Ticket {
        Ticket::new_offer(kind, amount, "ora".to_string(), None, expires_at)
    }

    #[tokio::test]
    async fn incoming_claim_is_single_use() {
        let state = fresh_state().await;
        let ticket = offered(TicketKind::Incoming, 500, None);
        let id = ticket.id.clone();
        state.insert_active(ticket).await.unwrap();

        let claimed = state.claim_incoming(&id, 500, "ora").await.unwrap();
        assert_eq!(claimed.status, TicketStatus::Pending);

        // second claim loses
        assert!(matches!(
            state.claim_incoming(&id, 500, "ora").await,
            Err(ClaimError::AlreadyClaimed)
        ));
    }

    #[tokio::test]
    async fn incoming_claim_rejects_mismatch_and_stays_claimable() {
        let state = fresh_state().await;
        let ticket = offered(TicketKind::Incoming, 500, None);
        let id = ticket.id.clone();
        state.insert_active(ticket).await.unwrap();

        assert!(matches!(
            state.claim_incoming(&id, 400, "ora").await,
            Err(ClaimError::Mismatch(_))
        ));
        assert!(matches!(
            state.claim_incoming(&id, 500, "usd").await,
            Err(ClaimError::Mismatch(_))
        ));
        // a rejected mismatch does not burn the ticket
        assert!(state.claim_incoming(&id, 500, "ora").await.is_ok());
    }

    #[tokio::test]
    async fn expired_offer_cannot_be_claimed() {
        let state = fresh_state().await;
        let ticket = offered(TicketKind::Incoming, 500, Some(unix_now() - 1));
        let id = ticket.id.clone();
        state.insert_active(ticket).await.unwrap();

        assert!(matches!(
            state.claim_incoming(&id, 500, "ora").await,
            Err(ClaimError::Expired)
        ));
    }

    #[tokio::test]
    async fn unknown_ticket_is_rejected() {
        let state = fresh_state().await;
        assert!(matches!(
            state.claim_incoming("MINT-nope", 1, "ora").await,
            Err(ClaimError::Unknown)
        ));
        assert!(matches!(
            state.claim_outgoing("MELT-nope", "ora", "q".into()).await,
            Err(ClaimError::Unknown)
        ));
    }

    #[tokio::test]
    async fn outgoing_lifecycle_gates_payout() {
        let state = fresh_state().await;
        let ticket = offered(TicketKind::Outgoing, 700, None);
        let id = ticket.id.clone();
        state.insert_active(ticket).await.unwrap();

        // teller cannot pay out an unclaimed or unfunded ticket
        assert!(state.mark_paid(&id, None).await.is_err());

        let claimed = state
            .claim_outgoing(&id, "ora", "quote-abc123".to_string())
            .await
            .unwrap();
        assert_eq!(claimed.status, TicketStatus::Waiting);
        assert_eq!(claimed.quote_id.as_deref(), Some("quote-abc123"));

        // still unfunded → still no payout
        assert!(state.mark_paid(&id, None).await.is_err());

        // second claim loses
        assert!(matches!(
            state.claim_outgoing(&id, "ora", "quote-other".to_string()).await,
            Err(ClaimError::AlreadyClaimed)
        ));

        // wallet funds the melt → Pending, payout allowed
        let funded = state.mark_outgoing_submitted(&id).await.unwrap();
        assert_eq!(funded.status, TicketStatus::Pending);
        assert!(state
            .outgoing_by_quote_id("quote-abc123")
            .await
            .is_some_and(|t| t.id == id));
        let paid = state.mark_paid(&id, None).await.unwrap();
        assert_eq!(paid.status, TicketStatus::Paid);
    }
}
