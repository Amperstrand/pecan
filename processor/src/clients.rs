//! Thin clients used by the operator web UI:
//!   * `MintRpcClient` — tonic gRPC client for cdk-mintd's management RPC
//!     (only used for `RotateNextKeyset`).
//!   * `MintHttpClient` — reqwest client that talks to the mint's public HTTP
//!     API (`/v1/keysets`) to list keysets for the dashboard.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use cdk_common::grpc::{VersionInterceptor, VERSION_HEADER};
use cdk_mint_rpc::cdk_mint_client::CdkMintClient;
use cdk_mint_rpc::RotateNextKeysetRequest;
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
}
