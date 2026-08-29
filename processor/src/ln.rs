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

struct RateCache {
    url: String,
    http: reqwest::Client,
    nok_per_btc: std::sync::RwLock<Option<(f64, u64)>>,
}

impl RateCache {
    fn new(url: String) -> Self {
        Self {
            url,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            nok_per_btc: std::sync::RwLock::new(None),
        }
    }

    async fn fetch(&self) -> Option<f64> {
        #[derive(Deserialize)]
        struct RateResp {
            rate: f64,
        }
        let resp: RateResp = self
            .http
            .get(&self.url)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        // yadio's /rate/BTC/NOK answers in BTC per NOK (≈1.4e-6); other
        // sources may answer NOK per BTC (≈730k). Normalize by magnitude —
        // no fiat answers "NOK per BTC" below 1.
        if resp.rate.is_finite() && resp.rate > 0.0 {
            let nok_per_btc = if resp.rate < 1.0 { 1.0 / resp.rate } else { resp.rate };
            *self.nok_per_btc.write().expect("rate lock") = Some((nok_per_btc, unix_now()));
            Some(nok_per_btc)
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

/// Minimal JSON-RPC client over the CLN `lightning-rpc` unix socket.
struct ClnClient {
    socket: PathBuf,
    next_id: std::sync::Mutex<u64>,
    lock: tokio::sync::Mutex<()>,
}

impl ClnClient {
    fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            next_id: std::sync::Mutex::new(0),
            lock: tokio::sync::Mutex::new(()),
        }
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, Error> {
        // Serialize whole request/response exchanges: the socket is a
        // stream and interleaved reads would scramble responses.
        let _guard = self.lock.lock().await;
        let id = {
            let mut n = self.next_id.lock().expect("id lock");
            *n += 1;
            *n
        };
        let req = serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params, "id": id});
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let mut stream = tokio::net::UnixStream::connect(&self.socket)
            .await
            .map_err(|e| Error::Custom(format!("connect {}: {e}", self.socket.display())))?;
        let line = serde_json::to_string(&req)
            .map_err(|e| Error::Custom(format!("encode rpc: {e}")))?;
        stream
            .write_all(line.as_bytes())
            .await
            .map_err(|e| Error::Custom(format!("write rpc: {e}")))?;
        stream
            .write_all(b"\n")
            .await
            .map_err(|e| Error::Custom(format!("write rpc: {e}")))?;
        let mut reader = tokio::io::BufReader::new(stream);
        let mut buf = String::new();
        reader
            .read_line(&mut buf)
            .await
            .map_err(|e| Error::Custom(format!("read rpc: {e}")))?;
        let parsed: serde_json::Value = serde_json::from_str(&buf)
            .map_err(|e| Error::Custom(format!("parse rpc: {e}")))?;
        if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
            return Err(Error::Custom(format!("cln {method}: {err}")));
        }
        serde_json::from_value(parsed["result"].clone())
            .map_err(|e| Error::Custom(format!("decode {method} result: {e}")))
    }
}

#[derive(Debug, Clone, PartialEq)]
enum InvoiceState {
    Open,
    Paid,
    Expired,
}

#[derive(Debug, Clone)]
struct InvoiceRecord {
    amount_ore: u64,
    unit: CurrencyUnit,
    state: InvoiceState,
}

pub struct LnRail {
    cln: Arc<ClnClient>,
    rate: Arc<RateCache>,
    markup_percent: f64,
    invoices: Arc<tokio::sync::RwLock<HashMap<String, InvoiceRecord>>>,
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
    /// Starts the rail and its settlement poller. `events` is the processor's
    /// shared channel: invoice settlements are announced as
    /// `Event::PaymentReceived` with the bare quote id as the lookup id.
    pub fn start(
        cln_socket: PathBuf,
        markup_percent: f64,
        rate_url: String,
        events: broadcast::Sender<Event>,
    ) -> Arc<Self> {
        let rail = Arc::new(Self {
            cln: Arc::new(ClnClient::new(cln_socket)),
            rate: Arc::new(RateCache::new(rate_url)),
            markup_percent,
            invoices: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            events,
        });
        rail.spawn_poller();
        rail
    }

    fn spawn_poller(&self) {
        let cln = self.cln.clone();
        let invoices = self.invoices.clone();
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
                                (rec.amount_ore, rec.unit.clone())
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
        let rate = self.rate.get().await?;
        let sat = nok_ore_to_sat(amount_ore, rate, self.markup_percent);
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
        self.invoices.write().await.insert(
            quote_id.to_string(),
            InvoiceRecord {
                amount_ore,
                unit: unit.clone(),
                state: InvoiceState::Open,
            },
        );
        tracing::info!(
            "ln invoice {quote_id} for {amount_ore} øre ({sat} sat, rate {rate:.0}, \
             markup {}%)",
            self.markup_percent
        );
        Ok((invoice.bolt11, invoice.expires_at))
    }

    /// Paid amount (øre) for a settled invoice, if this rail knows it.
    pub async fn paid_amount(&self, quote_id: &str) -> Option<(u64, CurrencyUnit)> {
        let invoices = self.invoices.read().await;
        let rec = invoices.get(quote_id)?;
        (rec.state == InvoiceState::Paid).then_some((rec.amount_ore, rec.unit.clone()))
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
