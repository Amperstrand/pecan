//! The `ln` rail: mint NOK ecash by paying a real bolt11 invoice (signet CLN
//! in this deployment), routed alongside the teller (`branch`) rail inside
//! one payment processor.
//!
//! One-way by construction: the melt side (`get_payment_quote`/
//! `make_payment` in `backend.rs`) refuses `ln` — the only exit rail is the
//! teller. Conversion runs here, in the processor layer, because cdk has no
//! price service: a public NOK/BTC rate (cached, fallback to last known)
//! plus a configurable markup protects the mint against rate movement.
//!
//! CLN is driven over its `lightning-rpc` unix socket (filesystem trust:
//! whoever holds the socket owns the node — the socket dir is bind-mounted
//! into this container and nothing else exposes it). Invoice records are
//! in-memory: a processor restart orphans open unpaid invoices; the mint
//! quote TTL expires them and the wallet retries. CLN keeps the invoices
//! themselves, so paid-but-unobserved labels surface on the next poll only
//! if the record survived — acceptable for this simulated mint.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use cdk_common::nuts::CurrencyUnit;
use cdk_common::payment::{Error, Event, PaymentIdentifier, WaitPaymentResponse};
use cdk_common::Amount;
use serde::Deserialize;
use tokio::sync::broadcast;

const DEFAULT_RATE_URL: &str = "https://api.yadio.io/rate/BTC/NOK";
const RATE_TTL_SECS: u64 = 300;
const POLL_INTERVAL_SECS: u64 = 3;
/// Invoice lifetime on the node; the mint's quote TTL stays the wallet-facing
/// deadline, so keep the invoice alive at least that long.
pub const INVOICE_EXPIRY_SECS: u64 = 1900;

/// NOK øre → invoice sats, rounded up, markup applied first so the mint
/// always receives at least the quoted NOK value at the quoted rate.
pub fn nok_ore_to_sat(ore: u64, nok_per_btc: f64, markup_percent: f64) -> u64 {
    let nok = ore as f64 / 100.0;
    let with_markup = nok * (1.0 + markup_percent / 100.0);
    let sat = with_markup / nok_per_btc * 1e8;
    // Subtract a rounding epsilon before ceil so exact integer results in
    // decimal terms (e.g. 11000) are not pushed up by f64 noise (11000.000…2).
    (sat - 1e-6).ceil() as u64
}

pub(crate) struct Fx {
    url: String,
    http: reqwest::Client,
    markup_percent: f64,
    nok_per_btc: std::sync::RwLock<Option<(f64, u64)>>,
}

impl Fx {
    pub(crate) fn new(url: String, markup_percent: f64) -> Self {
        Self {
            url,
            markup_percent,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            nok_per_btc: std::sync::RwLock::new(None),
        }
    }

    /// Quote-time sat expectation for a NOK øre amount (used by rails that
    /// display/verify an expected payment, like onchain addresses).
    pub(crate) async fn quote_sat(&self, ore: u64) -> Result<u64, Error> {
        let rate = self.get().await?;
        Ok(nok_ore_to_sat(ore, rate, self.markup_percent))
    }

    async fn fetch(&self) -> Option<f64> {
        #[derive(Deserialize)]
        struct RateResp {
            rate: f64,
        }
        // Primary source
        let primary = self
            .http
            .get(&self.url)
            .send()
            .await
            .and_then(|r| r.error_for_status());
        if let Ok(resp) = primary {
            if let Ok(rate) = resp.json::<RateResp>().await {
                if let Some(normalized) = Self::normalize(rate.rate) {
                    *self.nok_per_btc.write().expect("rate lock") =
                        Some((normalized, unix_now()));
                    return Some(normalized);
                }
            }
        }
        // Fallback: CoinGecko simple price (BTC in NOK)
        #[derive(Deserialize)]
        struct CoinGeckoInner {
            nok: f64,
        }
        #[derive(Deserialize)]
        struct CoinGeckoResp {
            bitcoin: CoinGeckoInner,
        }
        if let Ok(resp) = self
            .http
            .get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=nok")
            .send()
            .await
        {
            if let Ok(data) = resp.json::<CoinGeckoResp>().await {
                if let Some(normalized) = Self::normalize(data.bitcoin.nok) {
                    tracing::info!("rate from CoinGecko fallback: {normalized:.0} NOK/BTC");
                    *self.nok_per_btc.write().expect("rate lock") =
                        Some((normalized, unix_now()));
                    return Some(normalized);
                }
            }
        }
        None
    }

    /// yadio's /rate/BTC/NOK answers in BTC per NOK (≈1.4e-6); CoinGecko
    /// answers NOK per BTC (≈730k). Normalize by magnitude — no fiat
    /// answers "NOK per BTC" below 1.
    fn normalize(rate: f64) -> Option<f64> {
        if rate.is_finite() && rate > 0.0 {
            Some(if rate < 1.0 { 1.0 / rate } else { rate })
        } else {
            None
        }
    }

    /// Current rate if fresh, else refresh; falls back to the last known
    /// rate when the source is down (a stale rate is preferable to a rail
    /// that cannot quote at all — the markup absorbs small drift).
    async fn get(&self) -> Result<f64, Error> {
        let cached = *self.nok_per_btc.read().expect("rate lock");
        if let Some((rate, at)) = cached {
            if unix_now().saturating_sub(at) < RATE_TTL_SECS {
                return Ok(rate);
            }
        }
        if let Some(rate) = self.fetch().await {
            return Ok(rate);
        }
        if let Some((rate, _)) = cached {
            tracing::warn!("rate source unreachable; using last known rate {rate}");
            return Ok(rate);
        }
        Err(Error::Custom(
            "no NOK/BTC rate available yet; retry shortly".into(),
        ))
    }
}

/// JSON-RPC client over the CLN `lightning-rpc` unix socket. Holds ONE
/// persistent connection between calls and reconnects on error — a
/// connect-per-call pattern hammers the node with socket churn.
pub(crate) struct ClnClient {
    socket: PathBuf,
    next_id: std::sync::Mutex<u64>,
    /// The parked connection; taken out per call, returned on success.
    conn: tokio::sync::Mutex<Option<tokio::net::UnixStream>>,
}

impl ClnClient {
    pub(crate) fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            next_id: std::sync::Mutex::new(0),
            conn: tokio::sync::Mutex::new(None),
        }
    }

    async fn connect(&self) -> Result<tokio::net::UnixStream, Error> {
        tokio::net::UnixStream::connect(&self.socket)
            .await
            .map_err(|e| Error::Custom(format!("connect {}: {e}", self.socket.display())))
    }

    /// One round-trip on the given stream; returns (result, stream) so a
    /// healthy connection can be parked again.
    async fn round_trip<T: serde::de::DeserializeOwned>(
        &self,
        stream: &mut tokio::net::UnixStream,
        req: &serde_json::Value,
        method: &str,
    ) -> Result<T, Error> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let line =
            serde_json::to_string(req).map_err(|e| Error::Custom(format!("encode rpc: {e}")))?;
        stream
            .write_all(line.as_bytes())
            .await
            .map_err(|e| Error::Custom(format!("write rpc: {e}")))?;
        stream
            .write_all(b"\n")
            .await
            .map_err(|e| Error::Custom(format!("write rpc: {e}")))?;
        // Read line-by-line, byte at a time (keeps the stream borrowable —
        // BufReader would consume it), skipping the blank lines CLN frames
        // responses with. First non-empty line is the JSON-RPC answer.
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            use tokio::io::AsyncReadExt;
            let n = stream
                .read(&mut byte)
                .await
                .map_err(|e| Error::Custom(format!("read rpc: {e}")))?;
            if n == 0 {
                return Err(Error::Custom("read rpc: end of stream".into()));
            }
            if byte[0] == b'\n' {
                if buf.iter().any(|b: &u8| !b.is_ascii_whitespace()) {
                    break;
                }
                buf.clear();
                continue;
            }
            buf.push(byte[0]);
        }
        let parsed: serde_json::Value = serde_json::from_slice(&buf)
            .map_err(|e| Error::Custom(format!("parse rpc: {e}")))?;
        if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
            return Err(Error::Custom(format!("cln {method}: {err}")));
        }
        serde_json::from_value(parsed["result"].clone())
            .map_err(|e| Error::Custom(format!("decode {method} result: {e}")))
    }

    pub(crate) async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, Error> {
        // One request in flight at a time: a stream socket scrambles
        // interleaved reads, and the parked-connection dance needs it.
        let mut guard = self.conn.lock().await;
        let id = {
            let mut n = self.next_id.lock().expect("id lock");
            *n += 1;
            *n
        };
        let req =
            serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params, "id": id});
        let mut stream = match guard.take() {
            Some(s) => s,
            None => self.connect().await?,
        };
        match self.round_trip::<T>(&mut stream, &req, method).await {
            Ok(v) => {
                *guard = Some(stream);
                Ok(v)
            }
            Err(e) => {
                drop(stream);
                let mut fresh = self.connect().await?;
                let result = self.round_trip::<T>(&mut fresh, &req, method).await;
                if result.is_ok() {
                    *guard = Some(fresh);
                }
                result.map_err(|retry_err| Error::Custom(format!("{e}; retry: {retry_err}")))
            }
        }
    }

}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
enum InvoiceState {
    Open,
    Paid,
    Expired,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct InvoiceRecord {
    amount_ore: u64,
    unit: CurrencyUnit,
    state: InvoiceState,
}

pub struct LnRail {
    cln: Arc<ClnClient>,
    fx: Arc<Fx>,
    invoices: Arc<tokio::sync::RwLock<HashMap<String, InvoiceRecord>>>,
    store: Option<std::path::PathBuf>,
    events: broadcast::Sender<Event>,
}

#[derive(Deserialize)]
struct InvoiceResult {
    bolt11: String,
    #[serde(default)]
    expires_at: Option<u64>,
}

#[derive(Deserialize)]
struct ListInvoicesResult {
    #[serde(default)]
    invoices: Vec<ListedInvoicesEntry>,
}

#[derive(Deserialize)]
struct ListedInvoicesEntry {
    status: String,
}

impl LnRail {
    /// Starts the rail and its settlement poller on a shared socket client.
    /// `events` is the processor's shared channel: invoice settlements are
    /// announced as `Event::PaymentReceived` with the bare quote id as the
    /// lookup id. `store` persists open records across processor restarts
    /// (an in-memory-only rail orphans every open invoice on redeploy).
    pub async fn start_with_client(
        cln: Arc<ClnClient>,
        markup_percent: f64,
        rate_url: String,
        store: Option<std::path::PathBuf>,
        events: broadcast::Sender<Event>,
    ) -> Arc<Self> {
        let invoices = Arc::new(tokio::sync::RwLock::new(load_store(&store).await));
        let rail = Arc::new(Self {
            cln,
            fx: Arc::new(Fx::new(rate_url, markup_percent)),
            invoices,
            store,
            events,
        });
        rail.spawn_poller();
        rail
    }

    fn spawn_poller(&self) {
        let cln = self.cln.clone();
        let invoices = self.invoices.clone();
        let store = self.store.clone();
        let events = self.events.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
            loop {
                tick.tick().await;
                let open: Vec<String> = {
                    let guard = invoices.read().await;
                    guard
                        .iter()
                        .filter(|(_, r)| r.state == InvoiceState::Open)
                        .map(|(id, _)| id.clone())
                        .collect()
                };
                for quote_id in open {
                    let Ok(list) = cln
                        .call::<ListInvoicesResult>(
                            "listinvoices",
                            serde_json::json!({"label": quote_id}),
                        )
                        .await
                    else {
                        continue;
                    };
                    let Some(entry) = list.invoices.first() else {
                        continue;
                    };
                    let new_state = match entry.status.as_str() {
                        "paid" => InvoiceState::Paid,
                        "expired" => InvoiceState::Expired,
                        _ => continue,
                    };
                    let settled = {
                        let mut guard = invoices.write().await;
                        match guard.get_mut(&quote_id) {
                            Some(rec) if rec.state == InvoiceState::Open => {
                                rec.state = new_state.clone();
                                let out = (rec.amount_ore, rec.unit.clone());
                                persist(&store, &guard).await;
                                out
                            }
                            _ => continue,
                        }
                    };
                    if new_state == InvoiceState::Paid {
                        tracing::info!(
                            "ln invoice settled: {quote_id} ({} øre)",
                            settled.0
                        );
                        let _ = events.send(Event::PaymentReceived(WaitPaymentResponse {
                            payment_identifier: PaymentIdentifier::CustomId(quote_id.clone()),
                            payment_amount: Amount::new(settled.0, settled.1),
                            payment_id: quote_id.clone(),
                        }));
                    }
                }
            }
        });
    }

    /// Creates a CLN invoice for the quote and records it for settlement
    /// watching. Locked-quotes-only is enforced by the caller (backend).
    pub async fn create_invoice(
        &self,
        quote_id: &str,
        amount_ore: u64,
        unit: &CurrencyUnit,
        description: Option<String>,
    ) -> Result<(String, Option<u64>), Error> {
        let sat = self.fx.quote_sat(amount_ore).await?;
        let invoice: InvoiceResult = self
            .cln
            .call(
                "invoice",
                serde_json::json!({
                    "amount_msat": sat * 1000,
                    "label": quote_id,
                    "description": description
                        .unwrap_or_else(|| "giftcard.nok lightning mint".into()),
                    "expiry": INVOICE_EXPIRY_SECS,
                }),
            )
            .await?;
        let mut invoices = self.invoices.write().await;
        invoices.insert(
            quote_id.to_string(),
            InvoiceRecord {
                amount_ore,
                unit: unit.clone(),
                state: InvoiceState::Open,
            },
        );
        persist(&self.store, &invoices).await;
        tracing::info!("ln invoice {quote_id} for {amount_ore} øre ({sat} sat)");
        Ok((invoice.bolt11, invoice.expires_at))
    }

    /// Paid amount (øre) for a settled invoice, if this rail knows it.
    pub async fn paid_amount(&self, quote_id: &str) -> Option<(u64, CurrencyUnit)> {
        let invoices = self.invoices.read().await;
        let rec = invoices.get(quote_id)?;
        (rec.state == InvoiceState::Paid).then_some((rec.amount_ore, rec.unit.clone()))
    }
}

/// Records on disk survive processor restarts; anything older than a day is
/// dead weight (mint quotes expire long before that).
async fn load_store(store: &Option<std::path::PathBuf>) -> HashMap<String, InvoiceRecord> {
    let Some(path) = store else { return HashMap::new() };
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::warn!("ln rail store unreadable ({}), starting empty", e);
            HashMap::new()
        }),
        Err(_) => HashMap::new(),
    }
}

async fn persist(
    store: &Option<std::path::PathBuf>,
    invoices: &HashMap<String, InvoiceRecord>,
) {
    let Some(path) = store else { return };
    let trimmed: HashMap<_, _> = invoices
        .iter()
        .filter(|(_, r)| r.state != InvoiceState::Expired)
        .collect();
    if let Ok(bytes) = serde_json::to_vec(&trimmed) {
        if let Err(e) = tokio::fs::write(path, bytes).await {
            tracing::warn!("ln rail store write failed: {e}");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_nok_to_sat_with_markup_rounding_up() {
        // 100 NOK at 1,000,000 NOK/BTC, no markup → 10,000 sat exactly.
        assert_eq!(nok_ore_to_sat(10_000, 1_000_000.0, 0.0), 10_000);
        // 10% markup on the same quote → 11,000 sat (f64 noise must not
        // round an exact result up).
        assert_eq!(nok_ore_to_sat(10_000, 1_000_000.0, 10.0), 11_000);
        // Fractional results round UP in the mint's favor: 1 øre at 3 NOK
        // per BTC → 0.01/3 * 1e8 = 333333.3̅ sat.
        assert_eq!(nok_ore_to_sat(1, 3.0, 0.0), 333_334);
        // 5 NOK (500 øre) at a realistic 1.2M NOK/BTC with 10% markup:
        // 5.5 / 1_200_000 * 1e8 = 458.33 sat.
        assert_eq!(nok_ore_to_sat(500, 1_200_000.0, 10.0), 459);
    }
}
