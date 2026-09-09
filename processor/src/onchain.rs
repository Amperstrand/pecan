//! The `btc` rail: mint ecash by sending real on-chain sats (signet) to
//! a per-quote address, alongside the teller (`branch`) and lightning
//! (`ln`) rails. Same one-way rule: onchain melting is refused; the only
//! exit is the teller.
//!
//! Each quote gets a fresh bech32 address from the CLN node (`newaddr`).
//! Payment detection watches the OWNED bitcoind (watch-only wallet:
//! `importaddress` per quote, `listunspent` with minconf=0 so mempool
//! payments count) — no third-party explorer involved. Earlier designs
//! polled mempool.space (which banned the host IP for 26-address/5s
//! polling, 2026-09-09) and considered the node's own `listfunds`
//! (rejected: the lab CLN nodes run esplora chain mode, which does not
//! surface mempool outputs). Settlement after the configured
//! confirmations; 0 = mempool visibility.
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
/// Watch-only wallet on the owned bitcoind; every quote address is
/// imported here and polled with minconf=0 (mempool included).
const WATCH_WALLET: &str = "pecan-watch";
/// Quotes below this expected amount are refused: outputs under dust
/// cannot be mined, so the deposit would never settle.
const DUST_SAT: u64 = 330;

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
    rpc_url: String,
    rpc_user: String,
    rpc_pass: String,
    http: reqwest::Client,
    addresses: Arc<tokio::sync::RwLock<HashMap<String, AddressRecord>>>,
    store: Option<std::path::PathBuf>,
    events: broadcast::Sender<Event>,
}

#[derive(Deserialize)]
struct NewAddrResult {
    bech32: String,
}

/// One `listunspent` entry from the watch wallet.
#[derive(Debug, Clone, Deserialize)]
pub struct UnspentEntry {
    pub address: String,
    /// BTC as decimal; exact for msat-range values (f64 integers < 2^53).
    pub amount: f64,
    pub confirmations: i64,
}

/// Total received (msat) and best confirmations across an address's
/// entries. Mempool outputs count toward the amount with 0 confirmations.
fn received_and_confirmations(entries: &[UnspentEntry]) -> (u64, u32) {
    entries.iter().fold((0u64, 0u32), |(sum, confs), e| {
        let msat = (e.amount * 100_000_000_000.0).round() as u64;
        (sum + msat, confs.max(e.confirmations.max(0) as u32))
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
        rpc_url: String,
        rpc_user: String,
        rpc_pass: String,
        store: Option<std::path::PathBuf>,
        events: broadcast::Sender<Event>,
    ) -> Arc<Self> {
        let addresses = Arc::new(tokio::sync::RwLock::new(load_store(&store).await));
        let rail = Arc::new(Self {
            cln,
            fx,
            confirmations,
            rpc_url,
            rpc_user,
            rpc_pass,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            addresses,
            store,
            events,
        });
        rail.ensure_watch_wallet().await;
        rail.reimport_watching().await;
        rail.spawn_poller();
        rail
    }

    async fn rpc(&self, wallet: Option<&str>, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let url = match wallet {
            Some(w) => format!("{}/wallet/{w}", self.rpc_url),
            None => self.rpc_url.clone(),
        };
        let body = serde_json::json!({"jsonrpc": "1.0", "id": "pecan", "method": method, "params": params});
        let resp = self
            .http
            .post(&url)
            .basic_auth(&self.rpc_user, Some(&self.rpc_pass))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("rpc transport: {e}"))?;
        let parsed: serde_json::Value = resp.json().await.map_err(|e| format!("rpc decode: {e}"))?;
        if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
            return Err(format!("rpc {method}: {err}"));
        }
        Ok(parsed["result"].clone())
    }

    /// The watch wallet survives restarts on the node; create-once,
    /// load-if-unloaded. Failures are logged, not fatal: the poller
    /// retries via listunspent errors and a later restart re-runs this.
    async fn ensure_watch_wallet(&self) {
        let created = self
            .rpc(
                None,
                "createwallet",
                serde_json::json!({"wallet_name": WATCH_WALLET, "disable_private_keys": true}),
            )
            .await;
        match created {
            Ok(_) => tracing::info!("bitcoind watch wallet '{WATCH_WALLET}' created"),
            Err(_) => {
                // -35 "already loaded" IS success; anything else falls
                // through to loadwallet, whose error is the real signal.
                let loaded = self
                    .rpc(None, "loadwallet", serde_json::json!({ "filename": WATCH_WALLET }))
                    .await;
                match loaded {
                    Ok(_) => {
                        tracing::info!("bitcoind watch wallet '{WATCH_WALLET}' loaded");
                    }
                    Err(e) if e.contains("already loaded") => {
                        tracing::info!("bitcoind watch wallet '{WATCH_WALLET}' ready");
                    }
                    Err(e) => {
                        tracing::warn!("watch wallet setup failed: {e} — onchain watching degraded until next restart");
                    }
                }
            }
        }
    }

    fn spawn_poller(&self) {
        let http = self.http.clone();
        let rpc_url = self.rpc_url.clone();
        let rpc_user = self.rpc_user.clone();
        let rpc_pass = self.rpc_pass.clone();
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
                // One wallet-wide query per tick: minconf=0 keeps mempool
                // outputs visible (0-conf settlement); errors skip the
                // tick rather than killing the poller.
                let unspent: Vec<UnspentEntry> = match http
                    .post(format!("{rpc_url}/wallet/{WATCH_WALLET}"))
                    .basic_auth(&rpc_user, Some(&rpc_pass))
                    .json(&serde_json::json!({
                        "jsonrpc": "1.0", "id": "pecan", "method": "listunspent",
                        "params": [0, 9999999, [], true, { "minimumAmount": 0.00000001 }]
                    }))
                    .send()
                    .await
                {
                    Ok(r) => match r.json::<serde_json::Value>().await {
                        Ok(v) => match serde_json::from_value(v["result"].clone()) {
                            Ok(u) => u,
                            Err(e) => {
                                tracing::warn!("onchain poll decode: {e}");
                                continue;
                            }
                        },
                        Err(e) => {
                            tracing::warn!("onchain poll read: {e}");
                            continue;
                        }
                    },
                    Err(e) => {
                        tracing::warn!("onchain poll transport: {e}");
                        continue;
                    }
                };
                let by_address: HashMap<String, Vec<UnspentEntry>> = {
                    let mut m: HashMap<String, Vec<UnspentEntry>> = HashMap::new();
                    for e in unspent {
                        m.entry(e.address.clone()).or_default().push(e);
                    }
                    m
                };
                for quote_id in watching {
                    let address = {
                        let guard = addresses.read().await;
                        guard.get(&quote_id).map(|r| r.address.clone())
                    };
                    let Some(address) = address else { continue };
                    let empty: Vec<UnspentEntry> = Vec::new();
                    let entries = by_address.get(&address).unwrap_or(&empty);
                    let (msat, confs) = received_and_confirmations(entries);
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
        if expected_sat < DUST_SAT {
            // Chain physics, not policy: sub-dust outputs cannot confirm,
            // so no amount of waiting would ever settle this quote.
            return Err(Error::Custom(format!(
                "onchain deposits convert to {expected_sat} sat — below the \
                 {DUST_SAT} sat dust floor, the transaction could never \
                 confirm; use lightning or the teller for this amount"
            )));
        }
        let addr: NewAddrResult = self
            .cln
            .call("newaddr", serde_json::json!({"addresstype": "bech32"}))
            .await?;
        if let Err(e) = self.import_watch(&addr.bech32, quote_id).await {
            tracing::error!("watch-wallet import failed for {quote_id} ({}): {e}", addr.bech32);
            return Err(Error::Custom("watch wallet unavailable".into()));
        }
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

    /// Import an address into the watch wallet as a descriptor. The
    /// node checksums the descriptor for us (getdescriptorinfo) — the
    /// default wallet format since Core 22 rejects legacy
    /// importaddress, and hand-rolling the descriptor checksum is a
    /// bug factory.
    async fn import_watch(&self, address: &str, label: &str) -> Result<(), String> {
        let info = self
            .rpc(
                None,
                "getdescriptorinfo",
                serde_json::json!([format!("addr({address})")]),
            )
            .await?;
        let desc = info["descriptor"]
            .as_str()
            .ok_or("getdescriptorinfo returned no descriptor")?;
        self.rpc(
            Some(WATCH_WALLET),
            "importdescriptors",
            serde_json::json!([[{ "desc": desc, "label": label, "timestamp": "now" }]]),
        )
        .await
        .map(|_| ())
    }

    /// Re-import every still-watching address at boot: the watch
    /// wallet is the source of truth for the poller, and quote
    /// addresses created before a wallet wipe/recreate would otherwise
    /// be invisible forever (the mechanism that unstuck the 2026-09-09
    /// deposit by hand — never again by hand).
    async fn reimport_watching(&self) {
        let watching: Vec<(String, String)> = {
            let guard = self.addresses.read().await;
            guard
                .iter()
                .filter(|(_, r)| r.state == AddressState::Watching)
                .map(|(id, r)| (id.clone(), r.address.clone()))
                .collect()
        };
        let n = watching.len();
        for (quote_id, address) in watching {
            if let Err(e) = self.import_watch(&address, &quote_id).await {
                tracing::warn!("reimport {quote_id} failed ({address}): {e}");
            }
        }
        tracing::info!("watch wallet re-import: {n} watching address(es) ensured");
    }

    /// Per-address status for the console's onchain widget, in the
    /// historical esplora response shape so the wallet UI stays
    /// unchanged: `{tip, utxos:[{value, status:{confirmed, block_height}}]}`.
    pub async fn address_status(&self, address: &str) -> Option<(u64, String)> {
        let tip = self
            .rpc(None, "getblockcount", serde_json::json!([]))
            .await
            .ok()?
            .as_u64()?;
        let unspent = self
            .rpc(
                Some(WATCH_WALLET),
                "listunspent",
                serde_json::json!([0, 9999999, [address], true, { "minimumAmount": 0.00000001 }]),
            )
            .await
            .ok()?;
        let entries: Vec<UnspentEntry> = serde_json::from_value(unspent).ok()?;
        let utxos: Vec<serde_json::Value> = entries
            .iter()
            .map(|e| {
                let confirmed = e.confirmations > 0;
                let block_height = confirmed.then(|| tip - e.confirmations as u64 + 1);
                serde_json::json!({
                    "value": (e.amount * 100_000_000.0).round() as u64,
                    "status": { "confirmed": confirmed, "block_height": block_height }
                })
            })
            .collect();
        Some((tip, serde_json::to_string(&utxos).ok()?))
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

    fn entry(sat: u64, confirmations: i64) -> UnspentEntry {
        UnspentEntry {
            address: "tb1qtest".into(),
            amount: sat as f64 / 100_000_000.0,
            confirmations,
        }
    }

    #[test]
    fn mempool_entry_counts_amount_with_zero_confirmations() {
        let (msat, confs) = received_and_confirmations(&[entry(1000, 0)]);
        assert_eq!((msat, confs), (1_000_000, 0));
    }

    #[test]
    fn confirmations_come_from_the_node_directly() {
        let (msat, confs) = received_and_confirmations(&[entry(1000, 3)]);
        assert_eq!((msat, confs), (1_000_000, 3));
    }

    #[test]
    fn multiple_entries_sum_amounts_and_take_best_confs() {
        let entries = [entry(400, 0), entry(600, 2)];
        let (msat, confs) = received_and_confirmations(&entries);
        assert_eq!((msat, confs), (1_000_000, 2));
    }

    #[test]
    fn sub_satoshi_precision_is_preserved() {
        // bitcoind reports BTC decimals; 7506 sat must not drift
        let (msat, _) = received_and_confirmations(&[entry(7506, 0)]);
        assert_eq!(msat, 7_506_000);
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
