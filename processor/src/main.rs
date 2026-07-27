//! cdk-branch-processor
//!
//! Single binary that runs:
//!   * a gRPC `cdk-payment-processor` server on $CDK_BRANCH_PROCESSOR_GRPC_PORT,
//!     implementing the "branch" custom payment method for the configured unit.
//!     cdk-mintd connects to this and routes all mint/melt for that method to us.
//!   * a web UI on $CDK_BRANCH_PROCESSOR_HTTP_PORT for branch operators to sign
//!     in (username + password from the users.json store; first boot seeds a
//!     demo admin/admin account), see pending mint/melt quotes, mark them paid
//!     when physical cash is exchanged, and manage units, keysets, and users.
//!
//! First boot bootstraps a complete configuration (generated recovery seed,
//! unit "ora", method "branch") with zero interaction — there is no setup mode.

mod backend;
mod clients;
mod config;
mod offer;
mod sessions;
mod state;
mod users;
mod web;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use cdk_common::nuts::CurrencyUnit;
use cdk_payment_processor::PaymentProcessorServer;
use tokio::net::TcpListener;
use tokio::time::{sleep, Duration};
use tracing_subscriber::EnvFilter;

use crate::backend::BranchBackend;
use crate::clients::{KeysetEntry, MintHttpClient, MintRpcClient};
use crate::config::{AppConfig, BootstrapEndpoints, ConfigStore, UnitLifecycle};
use crate::sessions::SessionStore;
use crate::state::BranchState;
use crate::users::UserStore;

const ENV_WORK_DIR: &str = "CDK_BRANCH_PROCESSOR_WORK_DIR";
const ENV_CONFIG_DIR: &str = "CDK_BRANCH_PROCESSOR_CONFIG_DIR";
const ENV_GRPC_ADDR: &str = "CDK_BRANCH_PROCESSOR_GRPC_ADDR";
const ENV_GRPC_PORT: &str = "CDK_BRANCH_PROCESSOR_GRPC_PORT";
const ENV_HTTP_ADDR: &str = "CDK_BRANCH_PROCESSOR_HTTP_ADDR";
const ENV_HTTP_PORT: &str = "CDK_BRANCH_PROCESSOR_HTTP_PORT";
const ENV_MINT_RPC_URL: &str = "CDK_BRANCH_PROCESSOR_MINT_RPC_URL";
const ENV_MINT_HTTP_URL: &str = "CDK_BRANCH_PROCESSOR_MINT_HTTP_URL";
const ENV_DEFAULT_MINT_PUBLIC_URL: &str = "CDK_BRANCH_PROCESSOR_DEFAULT_MINT_PUBLIC_URL";
const ENV_MINT_GRPC_ADDR: &str = "CDK_BRANCH_PROCESSOR_MINT_GRPC_ADDR";

const DEFAULT_WORK_DIR: &str = "/var/lib/cdk-branch-processor";
const DEFAULT_CONFIG_DIR: &str = "/var/lib/custom-unit-mint/config";
const DEFAULT_GRPC_ADDR: &str = "0.0.0.0";
const DEFAULT_GRPC_PORT: u16 = 50051;
const DEFAULT_HTTP_ADDR: &str = "0.0.0.0";
const DEFAULT_HTTP_PORT: u16 = 9090;
const DEFAULT_MINT_HTTP_URL: &str = "http://mint:8089";
const DEFAULT_MINT_RPC_URL: &str = "http://mint:8091";
const DEFAULT_PUBLIC_URL: &str = "http://localhost:8089";
const DEFAULT_MINT_GRPC_ADDR: &str = "http://processor";

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
    let config_dir =
        PathBuf::from(std::env::var(ENV_CONFIG_DIR).unwrap_or_else(|_| DEFAULT_CONFIG_DIR.into()));
    tokio::fs::create_dir_all(&config_dir)
        .await
        .with_context(|| format!("create config_dir {}", config_dir.display()))?;
    // Credentials live on the durable config volume next to setup.json;
    // sessions are operational scratch and live in the work dir.
    let users_path = config_dir.join("users.json");
    let sessions_path = work_dir.join("sessions.json");
    let config_store =
        ConfigStore::new(config_dir).with_backup_path(work_dir.join("managed-stack-backup.json"));

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

    let mint_rpc_url =
        std::env::var(ENV_MINT_RPC_URL).unwrap_or_else(|_| DEFAULT_MINT_RPC_URL.into());
    let mint_http_url =
        std::env::var(ENV_MINT_HTTP_URL).unwrap_or_else(|_| DEFAULT_MINT_HTTP_URL.into());
    let default_public_url =
        std::env::var(ENV_DEFAULT_MINT_PUBLIC_URL).unwrap_or_else(|_| DEFAULT_PUBLIC_URL.into());
    let mint_grpc_addr =
        std::env::var(ENV_MINT_GRPC_ADDR).unwrap_or_else(|_| DEFAULT_MINT_GRPC_ADDR.into());

    let state_path = work_dir.join("tickets.json");

    // Load the config, or bootstrap a complete one on first boot. The old
    // browser setup wizard is gone: the stack comes up working immediately.
    let mut app_config = match config_store.load().await? {
        Some(config) => config,
        None => {
            let config = config::bootstrap_config(
                BootstrapEndpoints {
                    public_url: default_public_url.clone(),
                    mint_http_url: mint_http_url.clone(),
                    mint_rpc_url: mint_rpc_url.clone(),
                    processor_grpc_addr: mint_grpc_addr.clone(),
                    processor_grpc_port: grpc_port,
                },
                unix_now(),
            )?;
            config_store.save(&config).await?;
            tracing::info!(
                "bootstrapped new mint configuration at {}",
                config_store.app_config_path().display()
            );
            config
        }
    };

    // Auth migration, ordered for crash safety: seed users.json from the
    // legacy operator hash BEFORE stripping it from setup.json. A crash in
    // between converges on the next boot (users.json exists, so the legacy
    // hash is ignored and then stripped) — the hash is never in zero places.
    let users = UserStore::load(
        users_path,
        app_config
            .auth
            .as_ref()
            .map(|auth| auth.password_hash.clone()),
    )
    .await?;
    if app_config.auth.take().is_some() {
        tracing::info!("migrated the operator password into users.json as user 'admin'");
    }
    config_store.save(&app_config).await?;
    config_store.write_mint_config(&app_config).await?;
    let sessions = SessionStore::load(sessions_path).await?;

    let app_config = app_config;
    let mut units = HashMap::new();
    for managed in app_config
        .units
        .iter()
        .filter(|unit| unit.lifecycle != UnitLifecycle::Retired)
    {
        let unit: CurrencyUnit = managed
            .unit
            .parse()
            .map_err(|e| anyhow!("bad configured unit {}: {e}", managed.unit))?;
        units.insert(unit, managed.lifecycle);
    }
    let unit: CurrencyUnit = app_config
        .mint
        .unit
        .parse()
        .map_err(|e| anyhow!("bad primary unit: {e}"))?;
    let method = app_config.mint.method.clone();
    let branch = BranchState::load(state_path).await?;

    let backend = Arc::new(BranchBackend::new(
        branch.clone(),
        units,
        unit.clone(),
        method.clone(),
    ));
    let mut server = PaymentProcessorServer::new(backend.clone(), &grpc_addr, grpc_port)
        .map_err(|e| anyhow!("payment processor server init: {e}"))?;
    server
        .start(None)
        .await
        .map_err(|e| anyhow!("grpc start: {e}"))?;
    tracing::info!(
        "branch-processor gRPC on {grpc_addr}:{grpc_port} (method={method}, unit={unit})"
    );
    let grpc_server = Some(server);

    let mint_rpc = MintRpcClient::new(app_config.endpoints.mint_rpc_url.clone());
    let mint_http = MintHttpClient::new(app_config.endpoints.mint_http_url.clone());
    spawn_rollover_worker(
        app_config.clone(),
        mint_rpc.clone(),
        mint_http.clone(),
        branch.clone(),
    );

    let app = web::router(web::WebState::new(
        branch,
        mint_rpc,
        mint_http,
        app_config,
        config_store.clone(),
        users,
        sessions,
    ));

    tracing::info!("branch-processor HTTP on {http_socket}");
    let listener = TcpListener::bind(http_socket).await?;
    let serve = axum::serve(listener, app);

    tokio::select! {
        r = serve => r.map_err(|e| anyhow!("http: {e}"))?,
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("ctrl-c received, shutting down");
        }
    }

    if let Some(server) = grpc_server {
        let _ = server.stop().await;
    }
    Ok(())
}

fn spawn_rollover_worker(
    config: AppConfig,
    mint_rpc: MintRpcClient,
    mint_http: MintHttpClient,
    branch: BranchState,
) {
    if !config
        .units
        .iter()
        .any(|unit| unit.lifecycle == UnitLifecycle::Active && unit.rollover.enabled)
    {
        return;
    }
    tokio::spawn(async move {
        sleep(Duration::from_secs(8)).await;
        loop {
            if let Err(e) = reconcile_rollover(&config, &mint_rpc, &mint_http, &branch).await {
                tracing::warn!("keyset rollover check failed: {e:#}");
            }
            sleep(Duration::from_secs(60)).await;
        }
    });
}

async fn reconcile_rollover(
    config: &AppConfig,
    mint_rpc: &MintRpcClient,
    mint_http: &MintHttpClient,
    branch: &BranchState,
) -> Result<()> {
    let keysets = mint_http.list_keysets().await?;
    let now = unix_now();
    for managed in config
        .units
        .iter()
        .filter(|unit| unit.lifecycle == UnitLifecycle::Active && unit.rollover.enabled)
    {
        let threshold = managed.rollover.rotate_before_expiry_days * 86_400;
        let active = keysets
            .iter()
            .find(|ks| ks.unit == managed.unit && ks.active);
        let should_rotate = match active {
            None => true,
            Some(KeysetEntry {
                final_expiry: None, ..
            }) => true,
            Some(KeysetEntry {
                final_expiry: Some(expiry),
                ..
            }) => *expiry <= now.saturating_add(threshold),
        };

        if should_rotate {
            let final_expiry = now + managed.rollover.keyset_lifetime_days * 86_400;
            let result = mint_rpc
                .rotate_next_keyset(
                    managed.unit.clone(),
                    managed.rollover.amounts.clone(),
                    Some(managed.rollover.input_fee_ppk),
                    Some(final_expiry),
                )
                .await?;
            tracing::info!(
                "rotated keyset {} for unit {} with final_expiry {}",
                result.id,
                managed.unit,
                final_expiry
            );
            branch.notify_ui_change();
        }
    }
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
