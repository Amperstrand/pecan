//! The `btc` rail: mint NOK ecash by sending real on-chain sats (signet) to
//! a per-quote address, alongside the teller (`branch`) and lightning (`ln`)
//! rails. Same one-way rule: onchain melting is refused; the only exit is
//! the teller.
//!
//! Each quote gets a fresh bech32 address from the CLN node (`newaddr`);
//! the poller watches for payments via a public esplora API rather than the
//! node's own wallet tracking — the lab nodes use esplora chain mode, which
//! does not surface mempool outputs through `listfunds`, and direct esplora
//! makes detection independent of any node's chain backend. Settlement
//! after the configured confirmations; 0 = mempool visibility (simulated
//! mint tradeoff, docs/lightning-mint.md).
//!
//! The quote response carries `expected_sat` (flattened extra field) so the
//! wallet can show exactly how many sats to send; payments below the
//! expectation never settle, overpayments settle the quoted NOK amount
//! (the difference is a tip to the mint).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cdk_common::nuts::CurrencyUnit;
use cdk_common::payment::{Error, Event, PaymentIdentifier, WaitPaymentResponse};
use cdk_common::Amount;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::ln::{ClnClient, Fx};

const POLL_INTERVAL_SECS: u64 = 5;
const DEFAULT_ESPLORA_URL: &str = "https://mempool.space/signet/api";

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
enum AddressState {
    Watching,
    Settled,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct AddressRecord {
    address: String,
    expected_sat: u64,
    received_msat: u64,
    confirmations: u32,
    amount_ore: u64,
    unit: CurrencyUnit,
    state: AddressState,
}

pub struct OnchainRail {
    cln: Arc<ClnClient>,
    fx: Arc<Fx>,
    confirmations: u32,
    esplora: String,
    http: reqwest::Client,
    addresses: Arc<tokio::sync::RwLock<HashMap<String, AddressRecord>>>,
    store: Option<std::path::PathBuf>,
    events: broadcast::Sender<Event>,
}

#[derive(Deserialize)]
struct NewAddrResult {
    bech32: String,
}

#[derive(Deserialize)]
struct AddressUtxo {
    value: u64,
    status: AddressUtxoStatus,
}

#[derive(Deserialize)]
struct AddressUtxoStatus {
    confirmed: bool,
    block_height: Option<u64>,
}

/// Total received (msat) and best confirmations across an address's utxos.
/// Unconfirmed (mempool) outputs count toward the amount with 0 confirmations.
fn received_and_confirmations(utxos: &[AddressUtxo], tip: u64) -> (u64, u32) {
    utxos.iter().fold((0u64, 0u32), |(sum, confs), u| {
        let c = match (u.status.confirmed, u.status.block_height) {
            (true, Some(h)) if tip >= h => (tip - h + 1) as u32,
            _ => 0,
        };
        (sum + u.value * 1000, confs.max(c))
    })
}

/// A watching address settles once the payment covers the quoted expectation
/// and carries the required confirmations (0 = mempool acceptance).
fn settles(received_msat: u64, expected_sat: u64, confs: u32, required: u32) -> bool {
    received_msat >= expected_sat * 1000 && confs >= required
}

impl OnchainRail {
    pub async fn start(
        cln: Arc<ClnClient>,
        fx: Arc<Fx>,
        confirmations: u32,
        esplora: String,
        store: Option<std::path::PathBuf>,
        events: broadcast::Sender<Event>,
    ) -> Arc<Self> {
        let addresses = Arc::new(tokio::sync::RwLock::new(load_store(&store).await));
        let rail = Arc::new(Self {
            cln,
            fx,
            confirmations,
            esplora,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            addresses,
            store,
            events,
        });
        rail.spawn_poller();
        rail
    }

    fn spawn_poller(&self) {
        let http = self.http.clone();
        let esplora = self.esplora.clone();
        let addresses = self.addresses.clone();
        let store = self.store.clone();
        let events = self.events.clone();
        let required = self.confirmations;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
            loop {
                tick.tick().await;
                let watching: Vec<String> = {
                    let guard = addresses.read().await;
                    guard
                        .iter()
                        .filter(|(_, r)| r.state == AddressState::Watching)
                        .map(|(id, _)| id.clone())
                        .collect()
                };
                if watching.is_empty() {
                    continue;
                }
                let tip: u64 = match http
                    .get(format!("{esplora}/blocks/tip/height"))
                    .send()
                    .await
                {
                    Ok(r) => match r.error_for_status() {
                        Ok(r) => r
                            .text()
                            .await
                            .ok()
                            .and_then(|t| t.trim().parse().ok())
                            .unwrap_or(0),
                        Err(_) => 0,
                    },
                    Err(_) => 0,
                };
                for quote_id in watching {
                    let address = {
                        let guard = addresses.read().await;
                        guard.get(&quote_id).map(|r| r.address.clone())
                    };
                    let Some(address) = address else { continue };
                    let Ok(resp) = http
                        .get(format!("{esplora}/address/{address}/utxo"))
                        .send()
                        .await
                    else {
                        continue;
                    };
                    let Ok(utxos) = resp.json::<Vec<AddressUtxo>>().await else {
                        continue;
                    };
                    let (msat, confs) = received_and_confirmations(&utxos, tip);
                    let mut settled: Option<(u64, CurrencyUnit)> = None;
                    {
                        let mut guard = addresses.write().await;
                        if let Some(rec) = guard.get_mut(&quote_id) {
                            rec.received_msat = msat;
                            rec.confirmations = confs;
                            if rec.state == AddressState::Watching
                                && settles(msat, rec.expected_sat, confs, required)
                            {
                                rec.state = AddressState::Settled;
                                settled = Some((rec.amount_ore, rec.unit.clone()));
                                persist(&store, &guard).await;
                            }
                        }
                    }
                    if let Some((ore, unit)) = settled {
                        tracing::info!("onchain deposit settled: {quote_id} ({ore} cents)");
                        let _ = events.send(Event::PaymentReceived(WaitPaymentResponse {
                            payment_identifier: PaymentIdentifier::CustomId(quote_id.clone()),
                            payment_amount: Amount::new(ore, unit),
                            payment_id: quote_id.clone(),
                        }));
                    }
                }
            }
        });
    }

    /// Fresh bech32 address for the quote plus the sat amount the payer
    /// must send (rate + markup at quote time).
    pub async fn new_address(
        &self,
        quote_id: &str,
        amount_ore: u64,
        unit: &CurrencyUnit,
    ) -> Result<(String, u64), Error> {
        let expected_sat = self.fx.quote_sat(amount_ore).await?;
        let addr: NewAddrResult = self
            .cln
            .call("newaddr", serde_json::json!({"addresstype": "bech32"}))
            .await?;
        let mut addresses = self.addresses.write().await;
        addresses.insert(
            quote_id.to_string(),
            AddressRecord {
                address: addr.bech32.clone(),
                expected_sat,
                received_msat: 0,
                confirmations: 0,
                amount_ore,
                unit: unit.clone(),
                state: AddressState::Watching,
            },
        );
        persist(&self.store, &addresses).await;
        tracing::info!(
            "onchain address {quote_id} for {amount_ore} cents (expect {expected_sat} sat \
             to {})",
            addr.bech32
        );
        Ok((addr.bech32, expected_sat))
    }

    /// Settled NOK amount for a quote, if this rail observed it.
    pub async fn paid_amount(&self, quote_id: &str) -> Option<(u64, CurrencyUnit)> {
        let addresses = self.addresses.read().await;
        let rec = addresses.get(quote_id)?;
        (rec.state == AddressState::Settled).then_some((rec.amount_ore, rec.unit.clone()))
    }
}

/// Re-exported so main can build one shared socket client for both rails.
pub fn cln_client(socket: PathBuf) -> Arc<ClnClient> {
    Arc::new(ClnClient::new(socket))
}

async fn load_store(store: &Option<std::path::PathBuf>) -> HashMap<String, AddressRecord> {
    let Some(path) = store else { return HashMap::new() };
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::warn!("onchain rail store unreadable ({}), starting empty", e);
            HashMap::new()
        }),
        Err(_) => HashMap::new(),
    }
}

async fn persist(
    store: &Option<std::path::PathBuf>,
    addresses: &HashMap<String, AddressRecord>,
) {
    let Some(path) = store else { return };
    let trimmed: HashMap<_, _> = addresses
        .iter()
        .filter(|(_, r)| r.state != AddressState::Settled)
        .collect();
    if let Ok(bytes) = serde_json::to_vec(&trimmed) {
        if let Err(e) = tokio::fs::write(path, bytes).await {
            tracing::warn!("onchain rail store write failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utxo(value_sat: u64, confirmed: bool, height: Option<u64>) -> AddressUtxo {
        AddressUtxo {
            value: value_sat,
            status: AddressUtxoStatus {
                confirmed,
                block_height: height,
            },
        }
    }

    #[test]
    fn mempool_utxo_counts_amount_with_zero_confirmations() {
        let (msat, confs) = received_and_confirmations(&[utxo(1000, false, None)], 100);
        assert_eq!((msat, confs), (1_000_000, 0));
    }

    #[test]
    fn confirmed_utxo_confirmations_from_tip_height() {
        let (msat, confs) = received_and_confirmations(&[utxo(1000, true, Some(98))], 100);
        assert_eq!((msat, confs), (1_000_000, 3));
    }

    #[test]
    fn height_above_tip_is_treated_as_unconfirmed() {
        // Reorg edge: an esplora utxo whose height exceeds the tip we fetched
        let (_, confs) = received_and_confirmations(&[utxo(1000, true, Some(101))], 100);
        assert_eq!(confs, 0);
    }

    #[test]
    fn multiple_utxos_sum_amounts_and_take_best_confs() {
        let utxos = [utxo(400, false, None), utxo(600, true, Some(99))];
        let (msat, confs) = received_and_confirmations(&utxos, 100);
        assert_eq!((msat, confs), (1_000_000, 2));
    }

    #[test]
    fn zero_required_settles_on_mempool_acceptance() {
        assert!(settles(1_000_000, 1000, 0, 0));
    }

    #[test]
    fn one_required_waits_for_a_confirmation() {
        assert!(!settles(1_000_000, 1000, 0, 1));
        assert!(settles(1_000_000, 1000, 1, 1));
        assert!(settles(1_000_000, 1000, 6, 1));
    }

    #[test]
    fn underpayment_never_settles_regardless_of_confirmations() {
        assert!(!settles(999_999, 1000, 6, 0));
        assert!(!settles(999_999, 1000, 6, 1));
    }
}
