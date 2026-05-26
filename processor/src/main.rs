//! cdk-branch-processor
//!
//! Single binary that runs:
//!   * a gRPC `cdk-payment-processor` server on $CDK_BRANCH_PROCESSOR_GRPC_PORT,
//!     implementing the "branch" custom payment method for the configured unit.
//!     cdk-mintd connects to this and routes all mint/melt for that method to us.
//!   * a web UI on $CDK_BRANCH_PROCESSOR_HTTP_PORT for a branch operator to log
//!     in (static password), see pending mint/melt quotes, mark them paid when
//!     physical cash is exchanged, and manage keysets (rotate via mint-rpc,
//!     operator-expire via the signatory admin endpoint).

mod backend;
mod clients;
mod state;
mod web;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use cdk_common::nuts::CurrencyUnit;
use cdk_payment_processor::PaymentProcessorServer;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::backend::BranchBackend;
use crate::clients::{MintHttpClient, MintRpcClient};
use crate::state::BranchState;

const ENV_WORK_DIR: &str = "CDK_BRANCH_PROCESSOR_WORK_DIR";
const ENV_GRPC_ADDR: &str = "CDK_BRANCH_PROCESSOR_GRPC_ADDR";
const ENV_GRPC_PORT: &str = "CDK_BRANCH_PROCESSOR_GRPC_PORT";
const ENV_HTTP_ADDR: &str = "CDK_BRANCH_PROCESSOR_HTTP_ADDR";
const ENV_HTTP_PORT: &str = "CDK_BRANCH_PROCESSOR_HTTP_PORT";
const ENV_UNIT: &str = "CDK_BRANCH_PROCESSOR_UNIT";
const ENV_METHOD: &str = "CDK_BRANCH_PROCESSOR_METHOD";
const ENV_OPERATOR_PASSWORD: &str = "CDK_BRANCH_PROCESSOR_OPERATOR_PASSWORD";
const ENV_MINT_RPC_URL: &str = "CDK_BRANCH_PROCESSOR_MINT_RPC_URL";
const ENV_MINT_HTTP_URL: &str = "CDK_BRANCH_PROCESSOR_MINT_HTTP_URL";
const ENV_MINT_PUBLIC_URL: &str = "CDK_BRANCH_PROCESSOR_MINT_PUBLIC_URL";

const DEFAULT_WORK_DIR: &str = "/var/lib/cdk-branch-processor";
const DEFAULT_GRPC_ADDR: &str = "0.0.0.0";
const DEFAULT_GRPC_PORT: u16 = 50051;
const DEFAULT_HTTP_ADDR: &str = "0.0.0.0";
const DEFAULT_HTTP_PORT: u16 = 9090;
const DEFAULT_UNIT: &str = "ora";
const DEFAULT_METHOD: &str = "branch";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,h2=warn,hyper=warn,reqwest=warn")),
        )
        .with_ansi(false)
        .init();

    let work_dir =
        PathBuf::from(std::env::var(ENV_WORK_DIR).unwrap_or_else(|_| DEFAULT_WORK_DIR.into()));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .with_context(|| format!("create work_dir {}", work_dir.display()))?;

    let grpc_addr = std::env::var(ENV_GRPC_ADDR).unwrap_or_else(|_| DEFAULT_GRPC_ADDR.into());
    let grpc_port: u16 = std::env::var(ENV_GRPC_PORT)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_GRPC_PORT);
    let http_addr = std::env::var(ENV_HTTP_ADDR).unwrap_or_else(|_| DEFAULT_HTTP_ADDR.into());
    let http_port: u16 = std::env::var(ENV_HTTP_PORT)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT);
    let http_socket = SocketAddr::from_str(&format!("{http_addr}:{http_port}"))?;

    let unit_str = std::env::var(ENV_UNIT).unwrap_or_else(|_| DEFAULT_UNIT.into());
    let unit: CurrencyUnit = unit_str.parse().map_err(|e| anyhow!("bad unit: {e}"))?;
    let method = std::env::var(ENV_METHOD).unwrap_or_else(|_| DEFAULT_METHOD.into());

    let password = std::env::var(ENV_OPERATOR_PASSWORD).map_err(|_| {
        anyhow!("{ENV_OPERATOR_PASSWORD} is required (operator web-UI login password)")
    })?;

    let mint_rpc_url = std::env::var(ENV_MINT_RPC_URL)
        .map_err(|_| anyhow!("{ENV_MINT_RPC_URL} is required (e.g. http://mint-c:8091)"))?;
    let mint_http_url = std::env::var(ENV_MINT_HTTP_URL).map_err(|_| {
        anyhow!("{ENV_MINT_HTTP_URL} is required (e.g. http://mint-c:8089) — used to read /v1/keysets for the operator UI")
    })?;
    let mint_public_url =
        std::env::var(ENV_MINT_PUBLIC_URL).unwrap_or_else(|_| mint_http_url.clone());

    let state_path = work_dir.join("tickets.json");
    let branch = BranchState::load(state_path).await?;

    let backend = Arc::new(BranchBackend::new(
        branch.clone(),
        unit.clone(),
        method.clone(),
    ));

    let mut grpc_server = PaymentProcessorServer::new(backend.clone(), &grpc_addr, grpc_port)
        .map_err(|e| anyhow!("payment processor server init: {e}"))?;
    grpc_server
        .start(None)
        .await
        .map_err(|e| anyhow!("grpc start: {e}"))?;
    tracing::info!(
        "branch-processor gRPC on {grpc_addr}:{grpc_port} (method={method}, unit={unit})"
    );

    let web_state = web::WebState {
        branch,
        mint_rpc: MintRpcClient::new(mint_rpc_url),
        mint_http: MintHttpClient::new(mint_http_url),
        password: Arc::new(password),
        sessions: Arc::new(RwLock::new(HashSet::new())),
        unit,
        method: Arc::new(method),
        mint_public_url: Arc::new(mint_public_url),
        default_amounts: Arc::new((0..32).map(|i| 2u64.pow(i)).collect()),
    };
    let app = web::router(web_state);

    tracing::info!("branch-processor HTTP on {http_socket}");
    let listener = TcpListener::bind(http_socket).await?;
    let serve = axum::serve(listener, app);

    tokio::select! {
        r = serve => r.map_err(|e| anyhow!("http: {e}"))?,
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("ctrl-c received, shutting down");
        }
    }

    let _ = grpc_server.stop().await;
    Ok(())
}
