//! Thin clients used by the operator web UI and the boot sequence:
//!   * `MintRpcClient` — tonic gRPC client for cdk-mintd's management RPC
//!     (`RotateNextKeyset`, `UpdateQuoteTtl`).
//!   * `MintHttpClient` — reqwest client for the mint's public HTTP API:
//!     keysets and info for the dashboard, plus per-quote lookups used to
//!     cross-check a teller match against the mint's own records.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use cdk_common::grpc::{VersionInterceptor, VERSION_HEADER};
use cdk_mint_rpc::cdk_mint_client::CdkMintClient;
use cdk_mint_rpc::{RotateNextKeysetRequest, UpdateQuoteTtlRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tonic::transport::Channel;
use tonic::Request;

#[derive(Clone, Debug)]
pub struct MintRpcClient {
    addr: Arc<String>,
}

impl MintRpcClient {
    pub fn new(addr: impl Into<String>) -> Self {
        Self {
            addr: Arc::new(addr.into()),
        }
    }

    async fn connect(
        &self,
    ) -> Result<CdkMintClient<tonic::codegen::InterceptedService<Channel, VersionInterceptor>>>
    {
        let channel = Channel::from_shared(self.addr.as_str().to_string())
            .with_context(|| format!("bad mint-rpc address {}", self.addr))?
            .connect()
            .await
            .with_context(|| format!("connect to mint-rpc at {}", self.addr))?;
        let interceptor =
            VersionInterceptor::new(VERSION_HEADER, cdk_common::MINT_RPC_PROTOCOL_VERSION);
        Ok(CdkMintClient::with_interceptor(channel, interceptor))
    }

    pub async fn rotate_next_keyset(
        &self,
        unit: String,
        amounts: Vec<u64>,
        input_fee_ppk: Option<u64>,
        final_expiry: Option<u64>,
    ) -> Result<RotateResult> {
        let mut client = self.connect().await?;
        let response = client
            .rotate_next_keyset(Request::new(RotateNextKeysetRequest {
                unit,
                amounts,
                input_fee_ppk,
                use_keyset_v2: None,
                final_expiry,
            }))
            .await
            .map_err(|e| anyhow!("rotate_next_keyset: {e}"))?
            .into_inner();
        Ok(RotateResult {
            id: response.id,
            unit: response.unit,
            amounts: response.amounts,
            input_fee_ppk: response.input_fee_ppk,
        })
    }

    /// Persist the mint's quote TTLs. QuoteTTL lives in the mint's database
    /// (the toml value only seeds a fresh install), so this is asserted on
    /// every processor boot to keep existing deployments in sync with the
    /// ticket-expiry constants.
    pub async fn set_quote_ttl(&self, mint_ttl: u64, melt_ttl: u64) -> Result<()> {
        let mut client = self.connect().await?;
        client
            .update_quote_ttl(Request::new(UpdateQuoteTtlRequest {
                mint_ttl: Some(mint_ttl),
                melt_ttl: Some(melt_ttl),
            }))
            .await
            .map_err(|e| anyhow!("update_quote_ttl: {e}"))?;
        Ok(())
    }

    pub async fn health(&self) -> Result<()> {
        let _ = self.connect().await?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RotateResult {
    pub id: String,
    pub unit: String,
    pub amounts: Vec<u64>,
    pub input_fee_ppk: u64,
}

#[derive(Clone, Debug)]
pub struct MintHttpClient {
    base: Arc<String>,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[allow(dead_code)]
pub struct KeysetEntry {
    pub id: String,
    pub unit: String,
    pub active: bool,
    pub input_fee_ppk: u64,
    /// Unix seconds. Present on keysets that were rotated with a `final_expiry`.
    /// Mint enforces this natively (returns `Error::ExpiredKeyset` (12003)
    /// once the value is in the past) — see cdk commit bbe7be09.
    #[serde(default)]
    pub final_expiry: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct KeysetsResponse {
    keysets: Vec<KeysetEntry>,
}

impl MintHttpClient {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: Arc::new(base.into()),
            http: reqwest::Client::new(),
        }
    }

    pub async fn list_keysets(&self) -> Result<Vec<KeysetEntry>> {
        let base = self.base.trim_end_matches('/');
        let r = self
            .http
            .get(format!("{base}/v1/keysets"))
            .send()
            .await
            .with_context(|| format!("GET {base}/v1/keysets"))?;
        if !r.status().is_success() {
            return Err(anyhow!("list_keysets: HTTP {}", r.status()));
        }
        let parsed: KeysetsResponse = r.json().await?;
        Ok(parsed.keysets)
    }

    pub async fn get_info(&self) -> Result<Value> {
        let base = self.base.trim_end_matches('/');
        let r = self
            .http
            .get(format!("{base}/v1/info"))
            .send()
            .await
            .with_context(|| format!("GET {base}/v1/info"))?;
        if !r.status().is_success() {
            return Err(anyhow!("get_info: HTTP {}", r.status()));
        }
        Ok(r.json().await?)
    }

    /// Fetch one mint quote from the mint's public API. `Ok(None)` means the
    /// mint does not know the quote (404) — for the teller that distinction
    /// (unknown vs. unreachable mint) decides between "reject" and "retry".
    pub async fn get_mint_quote(
        &self,
        method: &str,
        quote_id: &str,
    ) -> Result<Option<MintQuoteSnapshot>> {
        let base = self.base.trim_end_matches('/');
        let url = format!("{base}/v1/mint/quote/{method}/{quote_id}");
        let r = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !r.status().is_success() {
            return Err(anyhow!("get_mint_quote: HTTP {}", r.status()));
        }
        Ok(Some(r.json().await?))
    }

    /// Melt-quote sibling of [`Self::get_mint_quote`].
    pub async fn get_melt_quote(
        &self,
        method: &str,
        quote_id: &str,
    ) -> Result<Option<MeltQuoteSnapshot>> {
        let base = self.base.trim_end_matches('/');
        let url = format!("{base}/v1/melt/quote/{method}/{quote_id}");
        let r = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !r.status().is_success() {
            return Err(anyhow!("get_melt_quote: HTTP {}", r.status()));
        }
        Ok(Some(r.json().await?))
    }
}

/// The wallet-visible state of a custom-method mint quote. Custom quotes have
/// no `state` field — "open" means nothing paid or issued yet.
#[derive(Debug, Clone, Deserialize)]
pub struct MintQuoteSnapshot {
    /// The processor-issued payment request (the ticket id).
    pub request: String,
    #[serde(default)]
    pub amount: Option<u64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub amount_paid: u64,
    #[serde(default)]
    pub amount_issued: u64,
    /// NUT-20 lock. Absent means the quote is not locked to a wallet key.
    #[serde(default)]
    pub pubkey: Option<String>,
}

/// The wallet-visible state of a custom-method melt quote.
#[derive(Debug, Clone, Deserialize)]
pub struct MeltQuoteSnapshot {
    pub amount: u64,
    /// "UNPAID" | "PENDING" | "PAID" (serialized NUT-05 state).
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub unit: Option<String>,
}
