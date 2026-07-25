//! Operator web UI for the branch payment backend.
//!
//! Auth: static password. POST /login → cookie session id (kept in process memory,
//! invalidated on restart). All other routes require a valid session cookie.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Form, Json, Path as AxumPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use cdk_common::nuts::CurrencyUnit;
use futures::stream::{Stream, StreamExt};
use maud::{html, Markup, PreEscaped, DOCTYPE};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tokio_stream::wrappers::BroadcastStream;

use crate::clients::{MintHttpClient, MintRpcClient};
use crate::config::{
    default_amounts, generate_mnemonic, parse_amounts, AppConfig, ConfigStore, RolloverPolicy,
    SetupDraft, UnitLifecycle, PASSWORD_MIN_LENGTH,
};
use crate::offer::QuoteOffer;
use crate::state::{BranchState, Ticket, TicketKind, TicketStatus};

#[derive(Clone)]
pub struct WebState {
    pub branch: BranchState,
    pub mint_rpc: MintRpcClient,
    pub mint_http: MintHttpClient,
    pub config: Arc<AppConfig>,
    pub sessions: Arc<RwLock<HashMap<String, Session>>>,
    pub unit: CurrencyUnit,
    pub method: Arc<String>,
    pub mint_public_url: Arc<String>,
    pub default_amounts: Arc<Vec<u64>>,
    pub config_store: ConfigStore,
}

impl WebState {
    pub fn new(
        branch: BranchState,
        mint_rpc: MintRpcClient,
        mint_http: MintHttpClient,
        config: AppConfig,
        unit: CurrencyUnit,
        config_store: ConfigStore,
    ) -> Self {
        let method = config.mint.method.clone();
        let mint_public_url = config.endpoints.public_url.clone();
        let default_amounts = config.rollover.amounts.clone();
        Self {
            branch,
            mint_rpc,
            mint_http,
            config: Arc::new(config),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            unit,
            method: Arc::new(method),
            mint_public_url: Arc::new(mint_public_url),
            default_amounts: Arc::new(default_amounts),
            config_store,
        }
    }
}

#[derive(Clone)]
pub struct SetupState {
    pub config_store: ConfigStore,
    pub mint_http_url: String,
    pub mint_rpc_url: String,
    pub mint_grpc_addr: String,
    pub grpc_port: u16,
    pub default_public_url: String,
}

#[derive(Clone)]
pub struct Session {
    expires_at: u64,
}

pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/", get(spa_page))
        .route("/teller", get(spa_page))
        .route("/keysets", get(spa_page))
        .route("/settings", get(spa_page))
        .route("/login", get(spa_page).post(login_submit))
        .route("/logout", post(logout))
        .route("/api/app", get(api_app))
        .route("/api/login", post(api_login))
        .route("/api/logout", post(api_logout))
        .route("/api/quotes", post(api_create_quote))
        .route("/api/tickets/{id}/mark-paid", post(api_mark_paid))
        .route("/api/tickets/{id}/mark-failed", post(api_mark_failed))
        .route("/api/keysets/rotate", post(api_rotate_keyset))
        .route("/api/units", post(api_add_unit))
        .route("/api/units/{unit}/lifecycle", post(api_set_unit_lifecycle))
        .route("/api/settings/identity", post(api_update_identity))
        .route("/quotes", post(create_quote))
        .route("/tickets/{id}/mark-paid", post(mark_paid))
        .route("/tickets/{id}/mark-failed", post(mark_failed))
        .route("/keysets/rotate", post(rotate_keyset))
        .route("/setup", get(spa_page))
        // Server-sent events: the dashboard listens here and reloads when state changes.
        .route("/events", get(sse_events))
        .route("/assets/{*path}", get(spa_asset))
        .route("/favicon.svg", get(spa_favicon))
        // Self-hosted fonts (embedded in the binary so the UI works offline / behind
        // content blockers).
        .route("/static/inter.woff2", get(font_inter))
        .route("/static/jbm.woff2", get(font_jbm))
        .with_state(state)
}

pub fn setup_router(state: SetupState) -> Router {
    Router::new()
        .route("/", get(spa_page))
        .route("/setup", get(spa_page).post(setup_submit))
        .route("/api/setup/defaults", get(api_setup_defaults))
        .route("/api/setup", post(api_setup_submit))
        .route("/assets/{*path}", get(spa_asset))
        .route("/favicon.svg", get(spa_favicon))
        .route("/static/inter.woff2", get(font_inter))
        .route("/static/jbm.woff2", get(font_jbm))
        .with_state(state)
}

async fn sse_events(
    State(state): State<WebState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    if !is_authenticated(&state, &headers).await {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized").into_response());
    }
    let rx = state.branch.subscribe_ui_changes();
    let stream = BroadcastStream::new(rx).filter_map(|r| async move {
        // Drop Lagged errors; treat every successful tick as one event.
        r.ok()
            .map(|()| Ok(SseEvent::default().event("change").data("1")))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

const LIVE_RELOAD_JS: &str = r#"
(function() {
  if (!window.EventSource) return;
  let pending = null;
  const src = new EventSource("/events");
  src.addEventListener("change", () => {
    clearTimeout(pending);
    pending = setTimeout(() => location.reload(), 250);
  });
  src.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
})();
"#;

const INTER_WOFF2: &[u8] = include_bytes!("../assets/Inter-Variable.woff2");
const JBM_WOFF2: &[u8] = include_bytes!("../assets/JetBrainsMono.woff2");

async fn font_inter() -> impl IntoResponse {
    font_response(INTER_WOFF2)
}

async fn font_jbm() -> impl IntoResponse {
    font_response(JBM_WOFF2)
}

fn font_response(bytes: &'static [u8]) -> Response {
    use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
    (
        [
            (CONTENT_TYPE, "font/woff2"),
            (CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response()
}

// ---------------- SPA assets ----------------

async fn spa_page() -> Response {
    match read_spa_file("index.html").await {
        Ok(bytes) => bytes_response(bytes, "text/html; charset=utf-8"),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "text/html; charset=utf-8")],
            r#"<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Branch</title></head>
  <body style="font-family: Inter, system-ui, sans-serif; margin: 40px; color: #0a0a0a">
    <h1>Operator UI assets are not built</h1>
    <p>Run <code>npm --prefix web run build</code> or set <code>CDK_BRANCH_PROCESSOR_WEB_DIST</code> to a built Vite dist directory.</p>
  </body>
</html>"#,
        )
            .into_response(),
    }
}

async fn spa_asset(AxumPath(path): AxumPath<String>) -> Response {
    if !is_safe_asset_path(&path) {
        return (StatusCode::BAD_REQUEST, "bad asset path").into_response();
    }
    let asset_path = format!("assets/{path}");
    match read_spa_file(&asset_path).await {
        Ok(bytes) => bytes_response(bytes, content_type_for(&asset_path)),
        Err(_) => (StatusCode::NOT_FOUND, "asset not found").into_response(),
    }
}

async fn spa_favicon() -> Response {
    match read_spa_file("favicon.svg").await {
        Ok(bytes) => bytes_response(bytes, "image/svg+xml"),
        Err(_) => (StatusCode::NOT_FOUND, "asset not found").into_response(),
    }
}

async fn read_spa_file(rel: &str) -> std::io::Result<Vec<u8>> {
    let rel = Path::new(rel);
    for dir in web_dist_candidates() {
        let path = dir.join(rel);
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return tokio::fs::read(path).await;
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "web dist not found",
    ))
}

fn web_dist_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("CDK_BRANCH_PROCESSOR_WEB_DIST") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(PathBuf::from("web/dist"));
    candidates.push(PathBuf::from("../web/dist"));
    candidates.push(PathBuf::from("/usr/local/share/custom-unit-mint/web"));
    candidates
}

fn is_safe_asset_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

fn content_type_for(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|ext| ext.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn bytes_response(bytes: Vec<u8>, content_type: &'static str) -> Response {
    ([("content-type", content_type)], bytes).into_response()
}

// ---------------- JSON API ----------------

#[derive(Serialize)]
struct ApiError {
    error: String,
}

#[derive(Serialize)]
struct ApiMessage {
    message: &'static str,
}

fn api_error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ApiError { error: msg.into() })).into_response()
}

async fn require_api_auth(state: &WebState, headers: &HeaderMap) -> Result<(), Response> {
    if is_authenticated(state, headers).await {
        Ok(())
    } else {
        Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

#[derive(Serialize)]
struct ApiAppSnapshot {
    now: u64,
    mint: ApiMintConfig,
    endpoints: ApiEndpoints,
    rollover: ApiRollover,
    default_amounts: Vec<u64>,
    health: ApiHealth,
    keysets: ApiKeysetsSnapshot,
    active_keyset: Option<crate::clients::KeysetEntry>,
    summary: MintSummary,
    unit_summaries: Vec<ApiUnitSummary>,
    circulation: Vec<CirculationPoint>,
    tickets: Vec<ApiTicket>,
    active_tickets: Vec<ApiTicket>,
    recent_done: Vec<ApiTicket>,
    units: Vec<ApiManagedUnit>,
    capabilities: Vec<ApiCapability>,
    consistency: ApiConsistency,
}

#[derive(Serialize)]
struct ApiMintConfig {
    name: String,
    description: String,
    description_long: String,
    unit: String,
    method: String,
}

#[derive(Serialize)]
struct ApiEndpoints {
    public_url: String,
    mint_http_url: String,
    mint_rpc_url: String,
    processor_grpc_addr: String,
    processor_grpc_port: u16,
}

#[derive(Serialize)]
struct ApiRollover {
    enabled: bool,
    keyset_lifetime_days: u64,
    rotate_before_expiry_days: u64,
    input_fee_ppk: u64,
    amounts: Vec<u64>,
}

#[derive(Serialize)]
struct ApiManagedUnit {
    unit: String,
    lifecycle: UnitLifecycle,
    configured_at: u64,
    rollover: ApiRollover,
    keyset_count: usize,
    active_keyset: Option<crate::clients::KeysetEntry>,
    can_mint: bool,
    can_melt: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct ApiCapability {
    unit: String,
    method: String,
    mint: bool,
    melt: bool,
    managed: bool,
}

#[derive(Serialize)]
struct ApiConsistency {
    ok: bool,
    issues: Vec<String>,
}

#[derive(Serialize)]
struct ApiUnitSummary {
    unit: String,
    mint_count: usize,
    melt_count: usize,
    minted_amount: u64,
    melted_amount: u64,
    net_issued: i128,
}

#[derive(Serialize)]
struct ApiHealth {
    mint_http: ApiHealthItem,
    management_rpc: ApiHealthItem,
    payment_backend: ApiHealthItem,
}

#[derive(Serialize)]
struct ApiHealthItem {
    ok: bool,
    label: String,
    detail: String,
}

#[derive(Serialize)]
struct ApiKeysetsSnapshot {
    ok: bool,
    items: Vec<crate::clients::KeysetEntry>,
    error: Option<String>,
}

#[derive(Serialize)]
struct ApiTicket {
    id: String,
    short_id: String,
    kind: TicketKind,
    kind_label: &'static str,
    amount: u64,
    unit: String,
    status: TicketStatus,
    status_label: &'static str,
    created_at: u64,
    paid_at: Option<u64>,
    expires_at: Option<u64>,
    description: Option<String>,
    notes: Option<String>,
    /// Serialized NUT-XX quote offer; the only thing shown to the wallet.
    offer: Option<String>,
    /// QR of the offer, present while the ticket is unclaimed.
    qr_svg: Option<String>,
    /// Payout verification code for funded melt tickets: last 6 characters of
    /// the (otherwise secret) melt quote id, uppercased. The customer's wallet
    /// shows the same code; the operator compares before dispensing cash.
    verification_code: Option<String>,
}

#[derive(Serialize)]
struct CirculationPoint {
    ts: u64,
    ticket_id: String,
    kind: TicketKind,
    amount: u64,
    delta: i128,
    circulation: i128,
}

async fn api_app(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }

    let mut tickets = state.branch.list_all().await;
    tickets.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let primary_tickets = tickets
        .iter()
        .filter(|ticket| ticket.unit == state.config.mint.unit)
        .cloned()
        .collect::<Vec<_>>();
    let summary = MintSummary::from_tickets(&primary_tickets);
    let now = unix_now();

    let info_health = state.mint_http.get_info().await;
    let rpc_health = state.mint_rpc.health().await;
    let keysets_result = state.mint_http.list_keysets().await;
    let keyset_items = keysets_result.as_ref().cloned().unwrap_or_default();
    let active_keyset = keysets_result.as_ref().ok().and_then(|keysets| {
        keysets
            .iter()
            .find(|ks| ks.unit == state.config.mint.unit.as_str() && ks.active)
            .cloned()
    });
    let keysets = match keysets_result {
        Ok(items) => ApiKeysetsSnapshot {
            ok: true,
            items,
            error: None,
        },
        Err(e) => ApiKeysetsSnapshot {
            ok: false,
            items: Vec::new(),
            error: Some(e.to_string()),
        },
    };

    let active_tickets = tickets
        .iter()
        .filter(|t| t.status.is_active())
        .map(|ticket| ApiTicket::from_ticket(ticket, &state))
        .collect();
    let recent_done = tickets
        .iter()
        .filter(|t| !t.status.is_active())
        .take(50)
        .map(|ticket| ApiTicket::from_ticket(ticket, &state))
        .collect();
    let api_tickets = tickets
        .iter()
        .map(|ticket| ApiTicket::from_ticket(ticket, &state))
        .collect();

    let observed_capabilities = info_health
        .as_ref()
        .map(|info| capabilities_from_info(info))
        .unwrap_or_default();
    let mut capabilities = observed_capabilities.clone();
    for managed in &state.config.units {
        if managed.lifecycle == UnitLifecycle::Retired {
            continue;
        }
        let expected_mint = managed.lifecycle.can_mint();
        let expected_melt = managed.lifecycle.can_melt();
        if let Some(existing) = capabilities
            .iter_mut()
            .find(|pair| pair.unit == managed.unit && pair.method == state.config.mint.method)
        {
            existing.managed = true;
        } else {
            capabilities.push(ApiCapability {
                unit: managed.unit.clone(),
                method: state.config.mint.method.clone(),
                mint: expected_mint,
                melt: expected_melt,
                managed: true,
            });
        }
    }
    capabilities.sort();

    let units = state
        .config
        .units
        .iter()
        .map(|managed| {
            let unit_keysets: Vec<_> = keyset_items
                .iter()
                .filter(|keyset| keyset.unit == managed.unit)
                .cloned()
                .collect();
            ApiManagedUnit {
                unit: managed.unit.clone(),
                lifecycle: managed.lifecycle,
                configured_at: managed.configured_at,
                rollover: api_rollover(&managed.rollover),
                keyset_count: unit_keysets.len(),
                active_keyset: unit_keysets.into_iter().find(|keyset| keyset.active),
                can_mint: managed.lifecycle.can_mint(),
                can_melt: managed.lifecycle.can_melt(),
            }
        })
        .collect::<Vec<_>>();

    let mut consistency_issues = Vec::new();
    if info_health.is_ok() {
        for managed in &state.config.units {
            let observed = observed_capabilities
                .iter()
                .find(|pair| pair.unit == managed.unit && pair.method == state.config.mint.method);
            let observed_mint = observed.is_some_and(|pair| pair.mint);
            let observed_melt = observed.is_some_and(|pair| pair.melt);
            if observed_mint != managed.lifecycle.can_mint()
                || observed_melt != managed.lifecycle.can_melt()
            {
                consistency_issues.push(format!(
                    "{} · {} is configured for mint={} melt={} but advertises mint={} melt={}",
                    managed.unit,
                    state.config.mint.method,
                    managed.lifecycle.can_mint(),
                    managed.lifecycle.can_melt(),
                    observed_mint,
                    observed_melt
                ));
            }
            if managed.lifecycle != UnitLifecycle::Retired
                && !keyset_items
                    .iter()
                    .any(|keyset| keyset.unit == managed.unit && keyset.active)
            {
                consistency_issues.push(format!(
                    "{} has no active keyset; teller operations are unavailable",
                    managed.unit
                ));
            }
        }
    }
    let unit_summaries = state
        .config
        .units
        .iter()
        .map(|managed| {
            let matching = tickets
                .iter()
                .filter(|ticket| ticket.unit == managed.unit)
                .cloned()
                .collect::<Vec<_>>();
            let summary = MintSummary::from_tickets(&matching);
            ApiUnitSummary {
                unit: managed.unit.clone(),
                mint_count: summary.mint_count,
                melt_count: summary.melt_count,
                minted_amount: summary.minted_amount,
                melted_amount: summary.melted_amount,
                net_issued: summary.net_issued,
            }
        })
        .collect();

    Json(ApiAppSnapshot {
        now,
        mint: ApiMintConfig {
            name: state.config.mint.name.clone(),
            description: state.config.mint.description.clone(),
            description_long: state.config.mint.description_long.clone(),
            unit: state.config.mint.unit.clone(),
            method: state.config.mint.method.clone(),
        },
        endpoints: ApiEndpoints {
            public_url: state.config.endpoints.public_url.clone(),
            mint_http_url: state.config.endpoints.mint_http_url.clone(),
            mint_rpc_url: state.config.endpoints.mint_rpc_url.clone(),
            processor_grpc_addr: state.config.endpoints.processor_grpc_addr.clone(),
            processor_grpc_port: state.config.endpoints.processor_grpc_port,
        },
        rollover: api_rollover(&state.config.rollover),
        default_amounts: (*state.default_amounts).clone(),
        health: ApiHealth {
            mint_http: health_item(info_health.as_ref().map(|_| ())),
            management_rpc: health_item(rpc_health.as_ref().map(|_| ())),
            payment_backend: ApiHealthItem {
                ok: true,
                label: "Listening".to_string(),
                detail: format!(
                    "{}:{}",
                    state.config.endpoints.processor_grpc_addr,
                    state.config.endpoints.processor_grpc_port
                ),
            },
        },
        keysets,
        active_keyset,
        summary,
        unit_summaries,
        circulation: circulation_points(&primary_tickets),
        tickets: api_tickets,
        active_tickets,
        recent_done,
        units,
        capabilities,
        consistency: ApiConsistency {
            ok: consistency_issues.is_empty(),
            issues: consistency_issues,
        },
    })
    .into_response()
}

fn api_rollover(policy: &RolloverPolicy) -> ApiRollover {
    ApiRollover {
        enabled: policy.enabled,
        keyset_lifetime_days: policy.keyset_lifetime_days,
        rotate_before_expiry_days: policy.rotate_before_expiry_days,
        input_fee_ppk: policy.input_fee_ppk,
        amounts: policy.amounts.clone(),
    }
}

fn capabilities_from_info(info: &serde_json::Value) -> Vec<ApiCapability> {
    let mut pairs = std::collections::BTreeMap::<(String, String), (bool, bool)>::new();
    for (nut, mint_direction) in [("4", true), ("5", false)] {
        let methods = info
            .get("nuts")
            .and_then(|nuts| nuts.get(nut))
            .and_then(|settings| settings.get("methods"))
            .and_then(serde_json::Value::as_array);
        for method in methods.into_iter().flatten() {
            let Some(unit) = method.get("unit").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let Some(method_name) = method.get("method").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let entry = pairs
                .entry((unit.to_string(), method_name.to_string()))
                .or_insert((false, false));
            if mint_direction {
                entry.0 = true;
            } else {
                entry.1 = true;
            }
        }
    }
    pairs
        .into_iter()
        .map(|((unit, method), (mint, melt))| ApiCapability {
            unit,
            method,
            mint,
            melt,
            managed: false,
        })
        .collect()
}

fn health_item<T>(result: Result<T, &anyhow::Error>) -> ApiHealthItem {
    let ok = result.is_ok();
    ApiHealthItem {
        ok,
        label: health_label(ok).to_string(),
        detail: match result {
            Ok(_) => "Responding normally".to_string(),
            Err(e) => e.to_string(),
        },
    }
}

impl ApiTicket {
    fn from_ticket(ticket: &Ticket, _state: &WebState) -> Self {
        let qr_svg = match ticket.status {
            TicketStatus::Offered => ticket.offer.as_deref().and_then(qr_code_svg),
            _ => None,
        };
        let verification_code = match (ticket.kind, ticket.status) {
            (TicketKind::Outgoing, TicketStatus::Pending) => {
                ticket.quote_id.as_deref().map(verification_code)
            }
            _ => None,
        };
        Self {
            id: ticket.id.clone(),
            short_id: short_id(&ticket.id),
            kind: ticket.kind,
            kind_label: kind_label(ticket.kind),
            amount: ticket.amount,
            unit: ticket.unit.clone(),
            status: ticket.status,
            status_label: status_label(ticket.status),
            created_at: ticket.created_at,
            paid_at: ticket.paid_at,
            expires_at: ticket.expires_at,
            description: ticket.description.clone(),
            notes: ticket.notes.clone(),
            offer: ticket.offer.clone(),
            qr_svg,
            verification_code,
        }
    }
}

/// Last 6 characters of the melt quote id, uppercased — mirrored by the wallet.
fn verification_code(quote_id: &str) -> String {
    let tail: String = quote_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    tail.to_uppercase()
}

fn circulation_points(tickets: &[Ticket]) -> Vec<CirculationPoint> {
    let mut paid: Vec<_> = tickets
        .iter()
        .filter(|ticket| ticket.status == TicketStatus::Paid)
        .collect();
    paid.sort_by(|a, b| {
        let a_ts = a.paid_at.unwrap_or(a.created_at);
        let b_ts = b.paid_at.unwrap_or(b.created_at);
        a_ts.cmp(&b_ts)
    });

    let mut circulation = 0i128;
    paid.into_iter()
        .map(|ticket| {
            let delta = match ticket.kind {
                TicketKind::Incoming => ticket.amount as i128,
                TicketKind::Outgoing => -(ticket.amount as i128),
            };
            circulation += delta;
            CirculationPoint {
                ts: ticket.paid_at.unwrap_or(ticket.created_at),
                ticket_id: ticket.id.clone(),
                kind: ticket.kind,
                amount: ticket.amount,
                delta,
                circulation,
            }
        })
        .collect()
}

async fn api_login(State(state): State<WebState>, Json(form): Json<LoginForm>) -> Response {
    if !state.config.verify_password(&form.password) {
        return api_error(StatusCode::UNAUTHORIZED, "incorrect password");
    }
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(
        sid.clone(),
        Session {
            expires_at: unix_now() + 12 * 60 * 60,
        },
    );
    let mut resp = Json(ApiMessage {
        message: "signed_in",
    })
    .into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE_NAME}={sid}; Path=/; HttpOnly; SameSite=Lax")
            .parse()
            .unwrap(),
    );
    resp
}

async fn api_logout(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Some(c) = cookie_value(&headers) {
        state.sessions.write().await.remove(&c);
    }
    let mut resp = Json(ApiMessage {
        message: "signed_out",
    })
    .into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE_NAME}=deleted; Path=/; Max-Age=0")
            .parse()
            .unwrap(),
    );
    resp
}

async fn api_create_quote(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<CreateQuoteForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    match create_quote_inner(&state, form).await {
        Ok(ticket) => Json(ApiTicket::from_ticket(&ticket, &state)).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_mark_paid(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(form): Json<NotesForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    match mark_paid_inner(&state, &id, form.notes).await {
        Ok(ticket) => Json(ApiTicket::from_ticket(&ticket, &state)).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_mark_failed(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(form): Json<NotesForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    match mark_failed_inner(&state, &id, form.notes).await {
        Ok(ticket) => Json(ApiTicket::from_ticket(&ticket, &state)).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_rotate_keyset(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<RotateForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    match rotate_keyset_inner(&state, form).await {
        Ok(()) => Json(ApiMessage { message: "rotated" }).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct AddUnitForm {
    unit: String,
    keyset_lifetime_days: u64,
    rotate_before_expiry_days: u64,
    #[serde(default)]
    input_fee_ppk: u64,
    amounts: String,
}

#[derive(Deserialize)]
struct UnitLifecycleForm {
    lifecycle: UnitLifecycle,
}

#[derive(Deserialize)]
struct IdentityForm {
    name: String,
    description: String,
    #[serde(default)]
    description_long: String,
    public_url: String,
}

async fn api_add_unit(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<AddUnitForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    let amounts = match parse_amounts(&form.amounts) {
        Ok(amounts) => amounts,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, format!("amounts: {e}")),
    };
    let mut config = (*state.config).clone();
    let policy = RolloverPolicy {
        enabled: true,
        keyset_lifetime_days: form.keyset_lifetime_days,
        rotate_before_expiry_days: form.rotate_before_expiry_days,
        input_fee_ppk: form.input_fee_ppk,
        amounts,
    };
    if let Err(e) = config.add_unit(&form.unit, policy, unix_now()) {
        return api_error(StatusCode::BAD_REQUEST, e.to_string());
    }
    match persist_config_and_restart(&state, &config).await {
        Ok(()) => Json(ApiMessage {
            message: "restarting",
        })
        .into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn api_set_unit_lifecycle(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(unit): AxumPath<String>,
    Json(form): Json<UnitLifecycleForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    if state
        .branch
        .active_tickets()
        .await
        .iter()
        .any(|ticket| ticket.unit == unit)
    {
        return api_error(
            StatusCode::CONFLICT,
            format!("finish the active {unit} quote before changing its lifecycle"),
        );
    }
    if form.lifecycle == UnitLifecycle::Retired {
        let keysets = match state.mint_http.list_keysets().await {
            Ok(keysets) => keysets,
            Err(e) => {
                return api_error(
                    StatusCode::BAD_GATEWAY,
                    format!("could not verify {unit} keyset expiry: {e}"),
                )
            }
        };
        let now = unix_now();
        let blocking = keysets.iter().filter(|keyset| {
            keyset.unit == unit && keyset.final_expiry.is_none_or(|expiry| expiry > now)
        });
        let count = blocking.count();
        if count > 0 {
            return api_error(
                StatusCode::CONFLICT,
                format!(
                    "{unit} cannot be retired: {count} keyset(s) have not reached a final expiry; keep the unit redemption-only"
                ),
            );
        }
    }
    let mut config = (*state.config).clone();
    if let Err(e) = config.set_unit_lifecycle(&unit, form.lifecycle) {
        return api_error(StatusCode::BAD_REQUEST, e.to_string());
    }
    match persist_config_and_restart(&state, &config).await {
        Ok(()) => Json(ApiMessage {
            message: "restarting",
        })
        .into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn api_update_identity(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<IdentityForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    if form.name.trim().is_empty() || form.description.trim().is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "mint name and short description are required",
        );
    }
    let public_url = form.public_url.trim().trim_end_matches('/');
    if !(public_url.starts_with("http://") || public_url.starts_with("https://")) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "wallet-facing URL must start with http:// or https://",
        );
    }
    let mut config = (*state.config).clone();
    config.mint.name = form.name.trim().to_string();
    config.mint.description = form.description.trim().to_string();
    config.mint.description_long = if form.description_long.trim().is_empty() {
        config.mint.description.clone()
    } else {
        form.description_long.trim().to_string()
    };
    config.endpoints.public_url = public_url.to_string();
    match persist_config_and_restart(&state, &config).await {
        Ok(()) => Json(ApiMessage {
            message: "restarting",
        })
        .into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn persist_config_and_restart(state: &WebState, config: &AppConfig) -> Result<(), String> {
    state
        .config_store
        .save(config)
        .await
        .map_err(|e| format!("save lifecycle config: {e}"))?;
    state
        .config_store
        .write_mint_config(config)
        .await
        .map_err(|e| format!("write mint config: {e}"))?;
    tokio::spawn(async {
        sleep(Duration::from_millis(900)).await;
        std::process::exit(0);
    });
    Ok(())
}

#[derive(Serialize)]
struct ApiSetupDefaults {
    name: String,
    description: String,
    description_long: String,
    unit: String,
    method: String,
    public_url: String,
    password_min_length: usize,
    mnemonic: String,
    rollover_enabled: bool,
    keyset_lifetime_days: u64,
    rotate_before_expiry_days: u64,
    input_fee_ppk: u64,
    amounts: String,
}

async fn api_setup_defaults(State(state): State<SetupState>) -> Response {
    let amounts = default_amounts();
    let mnemonic = generate_mnemonic().unwrap_or_else(|_| {
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
            .to_string()
    });
    Json(ApiSetupDefaults {
        name: "Custom Unit Mint".to_string(),
        description: "Cashu mint for a custom unit with branch settlement.".to_string(),
        description_long: "A stock cdk-mintd instance managed from the browser UI. Mint and melt quotes settle manually through the branch operator workflow.".to_string(),
        unit: "ora".to_string(),
        method: "branch".to_string(),
        public_url: state.default_public_url,
        password_min_length: PASSWORD_MIN_LENGTH,
        mnemonic,
        rollover_enabled: true,
        keyset_lifetime_days: 90,
        rotate_before_expiry_days: 14,
        input_fee_ppk: 0,
        amounts: default_amounts_str(&amounts),
    })
    .into_response()
}

#[derive(Serialize)]
struct ApiSetupSaved {
    message: &'static str,
    app_config_path: String,
    mint_config_path: String,
}

async fn api_setup_submit(
    State(state): State<SetupState>,
    Json(form): Json<SetupForm>,
) -> Response {
    match save_setup(&state, &form).await {
        Ok(saved) => {
            tokio::spawn(async {
                sleep(Duration::from_millis(900)).await;
                std::process::exit(0);
            });
            Json(ApiSetupSaved {
                message: "saved",
                app_config_path: saved.app_config_path,
                mint_config_path: saved.mint_config_path,
            })
            .into_response()
        }
        Err(e) => api_error(StatusCode::BAD_REQUEST, e),
    }
}

// ---------------- session ----------------

const COOKIE_NAME: &str = "branch_session";

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for c in cookie_header.split(';') {
        let c = c.trim();
        if let Some(rest) = c.strip_prefix(&format!("{COOKIE_NAME}=")) {
            return Some(rest.to_string());
        }
    }
    None
}

async fn is_authenticated(state: &WebState, headers: &HeaderMap) -> bool {
    let Some(c) = cookie_value(headers) else {
        return false;
    };
    let now = unix_now();
    let expired = {
        let sessions = state.sessions.read().await;
        match sessions.get(&c) {
            Some(session) if session.expires_at > now => return true,
            Some(_) => true,
            None => false,
        }
    };
    if expired {
        state.sessions.write().await.remove(&c);
    }
    false
}

/// Reject the request with a redirect to /login. Always returns the same
/// concrete `Response` type so handlers can short-circuit cleanly.
async fn require_auth(state: &WebState, headers: &HeaderMap) -> Result<(), Response> {
    if is_authenticated(state, headers).await {
        Ok(())
    } else {
        Err(Redirect::to("/login").into_response())
    }
}

#[allow(dead_code)]
async fn setup_already_done() -> Response {
    Redirect::to("/teller").into_response()
}

// ---------------- pages ----------------

#[allow(dead_code)]
async fn setup_page(State(state): State<SetupState>) -> Markup {
    let mnemonic = generate_mnemonic().unwrap_or_else(|_| {
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
            .to_string()
    });
    layout_no_chrome("Setup", setup_markup(&state, None, None, Some(mnemonic)))
}

#[derive(Deserialize, Clone)]
struct SetupForm {
    name: String,
    description: String,
    #[serde(default)]
    description_long: String,
    unit: String,
    method: String,
    public_url: String,
    password: String,
    password_confirm: String,
    mnemonic: String,
    #[serde(default)]
    rollover_enabled: Option<String>,
    keyset_lifetime_days: u64,
    rotate_before_expiry_days: u64,
    #[serde(default)]
    input_fee_ppk: u64,
    amounts: String,
    #[serde(default)]
    backup_confirmed: Option<String>,
}

struct SavedSetup {
    app_config_path: String,
    mint_config_path: String,
}

async fn save_setup(state: &SetupState, form: &SetupForm) -> Result<SavedSetup, String> {
    let amounts = match parse_amounts(&form.amounts) {
        Ok(v) => v,
        Err(e) => return Err(format!("amounts: {e}")),
    };
    let description_long = if form.description_long.trim().is_empty() {
        form.description.clone()
    } else {
        form.description_long.clone()
    };
    let draft = SetupDraft {
        name: form.name.clone(),
        description: form.description.clone(),
        description_long,
        unit: form.unit.clone(),
        method: form.method.clone(),
        public_url: form.public_url.clone(),
        password: form.password.clone(),
        password_confirm: form.password_confirm.clone(),
        mnemonic: form.mnemonic.clone(),
        rollover_enabled: form.rollover_enabled.is_some(),
        keyset_lifetime_days: form.keyset_lifetime_days,
        rotate_before_expiry_days: form.rotate_before_expiry_days,
        input_fee_ppk: form.input_fee_ppk,
        amounts,
        backup_confirmed: form.backup_confirmed.is_some(),
    };
    let config = match AppConfig::from_draft(
        draft,
        unix_now(),
        state.mint_http_url.clone(),
        state.mint_rpc_url.clone(),
        state.mint_grpc_addr.clone(),
        state.grpc_port,
    ) {
        Ok(config) => config,
        Err(e) => return Err(e.to_string()),
    };
    if let Err(e) = state.config_store.save(&config).await {
        return Err(format!("save setup: {e}"));
    }
    if let Err(e) = state.config_store.write_mint_config(&config).await {
        return Err(format!("write mint config: {e}"));
    }
    Ok(SavedSetup {
        app_config_path: state.config_store.app_config_path().display().to_string(),
        mint_config_path: state.config_store.mint_config_path().display().to_string(),
    })
}

async fn setup_submit(State(state): State<SetupState>, Form(form): Form<SetupForm>) -> Response {
    let saved = match save_setup(&state, &form).await {
        Ok(saved) => saved,
        Err(e) => return setup_error_response(&state, &form, &e),
    };
    tokio::spawn(async {
        sleep(Duration::from_millis(900)).await;
        std::process::exit(0);
    });

    layout_no_chrome(
        "Setup complete",
        html! {
            div.setup-shell {
                div.setup-panel.compact {
                    div.brand {
                        span.brand-mark { "◐" }
                        span.brand-name { "Branch" }
                    }
                    h1 { "Mint configuration saved" }
                    p.lede { "The service is restarting with the generated mint configuration. The mint container will start as soon as the config file is visible." }
                    div.status-list {
                        div.status-row {
                            span.pill.pill-paid { "Saved" }
                            div {
                                strong { "Lifecycle config" }
                                p.muted { (saved.app_config_path.as_str()) }
                            }
                        }
                        div.status-row {
                            span.pill.pill-paid { "Generated" }
                            div {
                                strong { "Mint config" }
                                p.muted { (saved.mint_config_path.as_str()) }
                            }
                        }
                    }
                    p.muted { "Refresh this page in a few seconds if the browser does not reconnect automatically." }
                    script { (PreEscaped("setTimeout(() => location.href='/', 3500);")) }
                }
            }
        },
    )
    .into_response()
}

fn setup_error_response(state: &SetupState, form: &SetupForm, msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        layout_no_chrome("Setup", setup_markup(state, Some(msg), Some(form), None)),
    )
        .into_response()
}

fn setup_markup(
    state: &SetupState,
    error: Option<&str>,
    form: Option<&SetupForm>,
    generated_mnemonic: Option<String>,
) -> Markup {
    let amounts = default_amounts();
    let mnemonic = form
        .map(|f| f.mnemonic.clone())
        .or(generated_mnemonic)
        .unwrap_or_default();
    let name = form.map(|f| f.name.as_str()).unwrap_or("Custom Unit Mint");
    let description = form
        .map(|f| f.description.as_str())
        .unwrap_or("Cashu mint for a custom unit with branch settlement.");
    let description_long = form
        .map(|f| f.description_long.as_str())
        .unwrap_or("A stock cdk-mintd instance managed from the browser UI. Mint and melt quotes settle manually through the branch operator workflow.");
    let unit = form.map(|f| f.unit.as_str()).unwrap_or("ora");
    let method = form.map(|f| f.method.as_str()).unwrap_or("branch");
    let public_url = form
        .map(|f| f.public_url.as_str())
        .unwrap_or(state.default_public_url.as_str());
    let keyset_lifetime_days = form.map(|f| f.keyset_lifetime_days).unwrap_or(90);
    let rotate_before_expiry_days = form.map(|f| f.rotate_before_expiry_days).unwrap_or(14);
    let input_fee_ppk = form.map(|f| f.input_fee_ppk).unwrap_or(0);
    let amounts_value = form
        .map(|f| f.amounts.clone())
        .unwrap_or_else(|| default_amounts_str(&amounts));
    let rollover_checked = form.map(|f| f.rollover_enabled.is_some()).unwrap_or(true);
    let backup_checked = form.map(|f| f.backup_confirmed.is_some()).unwrap_or(false);

    html! {
        div.setup-shell {
            div.setup-panel {
                div.setup-head {
                    div.brand {
                        span.brand-mark { "◐" }
                        span.brand-name { "Branch" }
                    }
                    h1 { "Set up your custom unit mint" }
                    p.lede { "One command starts the containers. This browser setup writes the mint configuration, locks the irreversible choices, and brings the mint online." }
                }
                @if let Some(error) = error {
                    div.alert.alert-error { (error) }
                }
                form id="setup-form" method="post" action="/setup" class="setup-form" {
                    div.setup-section {
                        h2 { "Mint identity" }
                        div.field-row {
                            div.field {
                                label for="setup-name" { "Mint name" }
                                input id="setup-name" type="text" name="name" value=(name) required;
                            }
                            div.field {
                                label for="setup-public-url" { "Wallet-facing URL" }
                                input id="setup-public-url" type="url" name="public_url" value=(public_url) required;
                                div.field-help { "Use the URL wallets will scan or paste, for example http://localhost:8089 or your LAN address." }
                            }
                        }
                        div.field {
                            label for="setup-description" { "Short description" }
                            input id="setup-description" type="text" name="description" value=(description) required;
                        }
                        div.field {
                            label for="setup-description-long" { "Long description" }
                            textarea id="setup-description-long" name="description_long" rows="3" { (description_long) }
                        }
                    }

                    div.setup-section {
                        h2 { "Immutable unit settings" }
                        div.field-row {
                            div.field {
                                label for="setup-unit" { "Custom unit" }
                                input id="setup-unit" type="text" name="unit" value=(unit) pattern="[a-z0-9_-]+" required;
                                div.field-help { "Lowercase unit code. This cannot be changed after provisioning." }
                            }
                            div.field {
                                label for="setup-method" { "Payment method" }
                                input id="setup-method" type="text" name="method" value=(method) pattern="[a-z0-9_-]+" required;
                                div.field-help { "Use branch unless you know a wallet integration expects a different method." }
                            }
                        }
                    }

                    div.setup-section {
                        h2 { "Operator access" }
                        div.field-row {
                            div.field {
                                label for="setup-password" { "Operator password" }
                                div.password-control {
                                    input id="setup-password" type="password" name="password" autocomplete="new-password" minlength=(PASSWORD_MIN_LENGTH) data-password-min=(PASSWORD_MIN_LENGTH) required;
                                    button type="button" class="btn btn-outline btn-sm password-toggle" data-password-toggle="setup-password" aria-controls="setup-password" aria-pressed="false" { "Show" }
                                }
                            }
                            div.field {
                                label for="setup-password-confirm" { "Confirm password" }
                                div.password-control {
                                    input id="setup-password-confirm" type="password" name="password_confirm" autocomplete="new-password" minlength=(PASSWORD_MIN_LENGTH) required;
                                    button type="button" class="btn btn-outline btn-sm password-toggle" data-password-toggle="setup-password-confirm" aria-controls="setup-password-confirm" aria-pressed="false" { "Show" }
                                }
                            }
                        }
                        ul.password-rules id="setup-password-rules" aria-live="polite" {
                            li data-password-rule="length" data-valid="false" {
                                span.rule-status { "Needed" }
                                span { "At least " (PASSWORD_MIN_LENGTH) " characters" }
                            }
                            li data-password-rule="letter" data-valid="false" {
                                span.rule-status { "Needed" }
                                span { "Contains a letter" }
                            }
                            li data-password-rule="number" data-valid="false" {
                                span.rule-status { "Needed" }
                                span { "Contains a number" }
                            }
                            li data-password-rule="symbol" data-valid="false" {
                                span.rule-status { "Needed" }
                                span { "Contains a symbol" }
                            }
                            li data-password-rule="match" data-valid="false" {
                                span.rule-status { "Needed" }
                                span { "Passwords match" }
                            }
                        }
                    }

                    div.setup-section {
                        h2 { "Recovery phrase" }
                        div.field {
                            label for="setup-mnemonic" { "Mint seed phrase" }
                            textarea id="setup-mnemonic" name="mnemonic" rows="4" aria-describedby="setup-seed-help" required { (mnemonic) }
                            div.field-help id="setup-seed-help" { "This phrase restores Cashu mint signing keys and keysets. It does not control bitcoin funds in this custom processor. Use the generated phrase, or paste an existing phrase when restoring." }
                        }
                        label.checkbox-row {
                            input id="setup-backup-confirmed" type="checkbox" name="backup_confirmed" value="yes" checked[backup_checked] required;
                            span { "I have saved the recovery phrase somewhere safe and understand it is required to recover this mint's signing keys." }
                        }
                    }

                    div.setup-section {
                        h2 { "Keyset expiry" }
                        label.checkbox-row {
                            input type="checkbox" name="rollover_enabled" value="yes" checked[rollover_checked];
                            span { "Automatically rotate keysets before they expire." }
                        }
                        div.field-row {
                            div.field {
                                label for="setup-lifetime" { "Keyset lifetime · days" }
                                input id="setup-lifetime" type="number" name="keyset_lifetime_days" min="2" value=(keyset_lifetime_days) required;
                            }
                            div.field {
                                label for="setup-rotate" { "Rotate before expiry · days" }
                                input id="setup-rotate" type="number" name="rotate_before_expiry_days" min="1" value=(rotate_before_expiry_days) required;
                            }
                        }
                        div.field-row {
                            div.field {
                                label for="setup-fee" { "Input fee (ppk)" }
                                input id="setup-fee" type="number" name="input_fee_ppk" min="0" value=(input_fee_ppk) required;
                            }
                            div.field {
                                label for="setup-amounts" { "Denominations" }
                                input id="setup-amounts" type="text" name="amounts" value=(amounts_value) required;
                            }
                        }
                    }

                    div.setup-review {
                        strong { "Locked after setup" }
                        span { " Unit, method, recovery phrase, and initial mint identity become read-only after provisioning." }
                    }
                    div.setup-submit-row {
                        button id="setup-submit" type="submit" class="btn btn-primary" disabled aria-disabled="true" { "Provision mint" }
                        span id="setup-validation-summary" class="setup-submit-hint" aria-live="polite" { "Complete the required fields to continue." }
                    }
                }
                script { (PreEscaped(SETUP_VALIDATION_JS)) }
            }
        }
    }
}

const SETUP_VALIDATION_JS: &str = r#"
(() => {
  const form = document.getElementById('setup-form');
  if (!form) return;

  const byId = (id) => document.getElementById(id);
  const submit = byId('setup-submit');
  const summary = byId('setup-validation-summary');
  const password = byId('setup-password');
  const passwordConfirm = byId('setup-password-confirm');
  const unit = byId('setup-unit');
  const method = byId('setup-method');
  const publicUrl = byId('setup-public-url');
  const seed = byId('setup-mnemonic');
  const backup = byId('setup-backup-confirmed');
  const lifetime = byId('setup-lifetime');
  const rotate = byId('setup-rotate');
  const fee = byId('setup-fee');
  const amounts = byId('setup-amounts');

  const slugPattern = /^[a-z0-9_-]+$/;
  const letterPattern = /\p{L}/u;
  const symbolPattern = /[^\p{L}\p{N}\s]/u;

  function setRule(name, valid) {
    const item = form.querySelector(`[data-password-rule="${name}"]`);
    if (!item) return;
    item.dataset.valid = valid ? 'true' : 'false';
    const status = item.querySelector('.rule-status');
    if (status) status.textContent = valid ? 'Met' : 'Needed';
  }

  function setValidity(input, valid, message) {
    if (!input) return valid;
    input.setCustomValidity(valid ? '' : message);
    return valid;
  }

  function validHttpUrl(value) {
    try {
      const url = new URL(value.trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function validAmounts(value) {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      try {
        return BigInt(part) > 0n;
      } catch (_) {
        return false;
      }
    });
  }

  function passwordState() {
    const value = password.value;
    const minLength = Number(password.dataset.passwordMin || 12);
    const checks = {
      length: Array.from(value).length >= minLength,
      letter: letterPattern.test(value),
      number: /\d/.test(value),
      symbol: symbolPattern.test(value),
      match: value.length > 0 && value === passwordConfirm.value,
    };

    Object.entries(checks).forEach(([name, valid]) => setRule(name, valid));

    const baseOk = checks.length && checks.letter && checks.number && checks.symbol;
    setValidity(password, baseOk, 'Password does not meet the listed requirements.');
    setValidity(passwordConfirm, checks.match, 'Passwords do not match.');
    return { ...checks, baseOk };
  }

  function numberValue(input) {
    const value = Number(input.value);
    return Number.isInteger(value) ? value : NaN;
  }

  function validateSetup() {
    const passwordChecks = passwordState();
    const lifetimeValue = numberValue(lifetime);
    const rotateValue = numberValue(rotate);
    const feeValue = numberValue(fee);

    const unitOk = setValidity(unit, slugPattern.test(unit.value.trim()), 'Use lowercase letters, digits, hyphen, or underscore.');
    const methodOk = setValidity(method, slugPattern.test(method.value.trim()), 'Use lowercase letters, digits, hyphen, or underscore.');
    const publicUrlOk = setValidity(publicUrl, validHttpUrl(publicUrl.value), 'Enter an http:// or https:// URL.');
    const seedOk = setValidity(seed, seed.value.trim().length > 0, 'A mint seed phrase is required.');
    const backupOk = setValidity(backup, backup.checked, 'Confirm that the seed phrase has been saved.');
    const lifetimeOk = setValidity(lifetime, lifetimeValue >= 2, 'Keyset lifetime must be at least 2 days.');
    const rotateOk = setValidity(rotate, rotateValue >= 1 && rotateValue < lifetimeValue, 'Rotate-before-expiry must be shorter than the keyset lifetime.');
    const feeOk = setValidity(fee, feeValue >= 0, 'Input fee must be zero or greater.');
    const amountsOk = setValidity(amounts, validAmounts(amounts.value), 'Enter comma-separated positive whole numbers.');

    const ok = form.checkValidity()
      && passwordChecks.baseOk
      && passwordChecks.match
      && unitOk
      && methodOk
      && publicUrlOk
      && seedOk
      && backupOk
      && lifetimeOk
      && rotateOk
      && feeOk
      && amountsOk;

    submit.disabled = !ok;
    submit.setAttribute('aria-disabled', ok ? 'false' : 'true');
    summary.dataset.valid = ok ? 'true' : 'false';

    if (ok) {
      summary.textContent = 'Ready to provision. This writes config and restarts the services.';
    } else if (!passwordChecks.baseOk) {
      summary.textContent = 'Complete the password requirements.';
    } else if (!passwordChecks.match) {
      summary.textContent = 'Confirm the operator password.';
    } else if (!backupOk) {
      summary.textContent = 'Save the seed phrase before provisioning.';
    } else if (!unitOk || !methodOk || !publicUrlOk || !seedOk) {
      summary.textContent = 'Complete the required mint settings.';
    } else if (!lifetimeOk || !rotateOk || !feeOk || !amountsOk) {
      summary.textContent = 'Review the keyset expiry settings.';
    } else {
      summary.textContent = 'Complete the required fields to continue.';
    }

    return ok;
  }

  form.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = byId(button.dataset.passwordToggle);
      if (!target) return;
      const reveal = target.type === 'password';
      target.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', reveal ? 'true' : 'false');
      target.focus();
    });
  });

  form.addEventListener('input', validateSetup);
  form.addEventListener('change', validateSetup);
  form.addEventListener('submit', (event) => {
    if (!validateSetup()) {
      event.preventDefault();
      form.reportValidity();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Provisioning...';
    summary.textContent = 'Writing configuration. The service will restart.';
  });

  validateSetup();
})();
"#;

#[allow(dead_code)]
async fn overview(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }

    let mut tickets = state.branch.list_all().await;
    tickets.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let summary = MintSummary::from_tickets(&tickets);
    let active_count = tickets.iter().filter(|t| t.status.is_active()).count();
    let now = unix_now();

    let info_health = state.mint_http.get_info().await;
    let rpc_health = state.mint_rpc.health().await;
    let keysets_result = state.mint_http.list_keysets().await;
    let active_keyset = keysets_result.as_ref().ok().and_then(|keysets| {
        keysets
            .iter()
            .find(|ks| ks.unit == state.config.mint.unit.as_str() && ks.active)
    });

    let recent_done: Vec<_> = tickets
        .iter()
        .filter(|t| !t.status.is_active())
        .take(8)
        .collect();

    layout(
        "Overview",
        html! {
            section class="overview-hero" {
                div {
                    h1 { (state.config.mint.name.as_str()) }
                    p { (state.config.mint.description.as_str()) }
                }
                div.hero-actions {
                    a.btn.btn-primary href="/teller" { "Open teller" }
                    a.btn.btn-outline href="/keysets" { "Manage keysets" }
                }
            }

            section class="metric-grid" {
                (metric_card("Mint HTTP", health_label(info_health.is_ok()), health_detail(info_health.as_ref().err())))
                (metric_card("Management RPC", health_label(rpc_health.is_ok()), health_detail(rpc_health.as_ref().err())))
                (metric_card("Payment backend", "Listening", format!("{}:{}", state.config.endpoints.processor_grpc_addr.as_str(), state.config.endpoints.processor_grpc_port)))
                (metric_card("Active quotes", active_count.to_string(), "Waiting or pending teller work"))
                (metric_card("Mints processed", summary.mint_count.to_string(), amount_text(summary.minted_amount, &state.config.mint.unit)))
                (metric_card("Melts processed", summary.melt_count.to_string(), amount_text(summary.melted_amount, &state.config.mint.unit)))
                (metric_card("Estimated circulation", signed_amount_text(summary.net_issued, &state.config.mint.unit), "Completed mints minus completed melts"))
                (metric_card("Unit", state.config.mint.unit.as_str(), format!("method {}", state.config.mint.method.as_str())))
            }

            section class="split-grid" {
                div.card {
                    div.card-header {
                        div {
                            h2.card-title { "Keyset state" }
                            p.card-subtitle { "Expiry is immutable per keyset; rollover creates the next active keyset." }
                        }
                        @match active_keyset {
                            Some(ks) => { (keyset_status_pill(ks.active, ks.final_expiry, now)) }
                            None => { span.pill.pill-pending { "Waiting" } }
                        }
                    }
                    div.card-body {
                        @match keysets_result.as_ref() {
                            Ok(keysets) => {
                                @if let Some(ks) = active_keyset {
                                    div.detail-list {
                                        div { span.muted { "Active keyset" } strong.mono { (ks.id) } }
                                        div { span.muted { "Final expiry" } strong { (fmt_expiry(ks.final_expiry, now)) } }
                                        div { span.muted { "Input fee" } strong.mono { (ks.input_fee_ppk) " ppk" } }
                                        div { span.muted { "Total keysets" } strong { (keysets.len()) } }
                                    }
                                } @else {
                                    div.empty {
                                        div.empty-title { "No active keyset yet" }
                                        div { "The rollover worker will create the first expiring keyset once the mint management RPC is reachable." }
                                    }
                                }
                            }
                            Err(e) => {
                                div.alert.alert-error { "Could not read keysets: " (e) }
                            }
                        }
                    }
                }

                div.card {
                    div.card-header {
                        div {
                            h2.card-title { "Rollover policy" }
                            p.card-subtitle { "Configured during provisioning." }
                        }
                        @if state.config.rollover.enabled {
                            span.pill.pill-active { "Enabled" }
                        } @else {
                            span.pill.pill-inactive { "Disabled" }
                        }
                    }
                    div.card-body {
                        div.detail-list {
                            div { span.muted { "Lifetime" } strong { (state.config.rollover.keyset_lifetime_days) " days" } }
                            div { span.muted { "Rotate before expiry" } strong { (state.config.rollover.rotate_before_expiry_days) " days" } }
                            div { span.muted { "Denominations" } strong { (state.config.rollover.amounts.len()) " amounts" } }
                            div { span.muted { "Public URL" } strong.mono.wrap { (state.config.endpoints.public_url.as_str()) } }
                        }
                    }
                }
            }

            section {
                div.card {
                    div.card-header {
                        h2.card-title { "Recent settled activity" }
                        span.muted { (recent_done.len()) " rows" }
                    }
                    @if recent_done.is_empty() {
                        div.empty {
                            div.empty-title { "No settled operations yet" }
                            div { "Completed mints and melts will appear here." }
                        }
                    } @else {
                        div.card-body.zero {
                            table {
                                thead { tr {
                                    th { "Ticket" } th { "Kind" } th { "Amount" } th { "Status" } th { "When" }
                                } }
                                tbody {
                                    @for t in &recent_done {
                                        tr {
                                            td { span.id-chip { (short_id(&t.id)) } }
                                            td.muted { (kind_label(t.kind)) }
                                            td { (amount_cell(t.amount, &t.unit)) }
                                            td { (status_pill(t.status)) }
                                            td.muted { (relative_age(t.paid_at.unwrap_or(t.created_at), now)) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    )
    .into_response()
}

#[derive(Serialize)]
struct MintSummary {
    mint_count: usize,
    melt_count: usize,
    minted_amount: u64,
    melted_amount: u64,
    net_issued: i128,
}

impl MintSummary {
    fn from_tickets(tickets: &[Ticket]) -> Self {
        let mut summary = Self {
            mint_count: 0,
            melt_count: 0,
            minted_amount: 0,
            melted_amount: 0,
            net_issued: 0,
        };
        for ticket in tickets {
            if ticket.status != TicketStatus::Paid {
                continue;
            }
            match ticket.kind {
                TicketKind::Incoming => {
                    summary.mint_count += 1;
                    summary.minted_amount = summary.minted_amount.saturating_add(ticket.amount);
                    summary.net_issued += ticket.amount as i128;
                }
                TicketKind::Outgoing => {
                    summary.melt_count += 1;
                    summary.melted_amount = summary.melted_amount.saturating_add(ticket.amount);
                    summary.net_issued -= ticket.amount as i128;
                }
            }
        }
        summary
    }
}

#[allow(dead_code)]
async fn dashboard(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    let mut tickets = state.branch.list_all().await;
    tickets.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let now = unix_now();
    let active: Vec<_> = tickets.iter().filter(|t| t.status.is_active()).collect();
    let done: Vec<_> = tickets
        .iter()
        .filter(|t| !t.status.is_active())
        .take(50)
        .collect();

    layout(
        "Teller",
        html! {
            section {
                div.card {
                    div.card-header {
                        div {
                            h2.card-title { "Create quote" }
                            p.card-subtitle { "The teller starts each branch quote from this screen." }
                        }
                        @if active.is_empty() {
                            span.pill.pill-active { "Ready" }
                        } @else {
                            span.pill.pill-pending { (active.len()) " active" }
                        }
                    }
                    @if active.is_empty() {
                        div.card-body {
                            form method="post" action="/quotes" class="quote-form" {
                                div.field-row {
                                    div.field {
                                        label for="quote-kind" { "Flow" }
                                        select id="quote-kind" name="kind" {
                                            option value="mint" { "Cash deposit" }
                                            option value="melt" { "Cash dispense" }
                                        }
                                    }
                                    div.field {
                                        label for="quote-amount" { "Amount" }
                                        input id="quote-amount" type="number" name="amount" min="1" step="1" required autofocus;
                                    }
                                }
                                div.field {
                                    label for="quote-description" { "Note" }
                                    input id="quote-description" type="text" name="description" placeholder="optional";
                                }
                                div.form-row {
                                    button type="submit" class="btn btn-primary" { "Create quote" }
                                    span.muted { (state.unit) " · " (state.method.as_str()) }
                                }
                            }
                        }
                    } @else if active.len() == 1 {
                        (active_quote_panel(active[0], now, &state))
                    } @else {
                        div.card-body.zero {
                            div.alert.alert-error { "Multiple active quotes exist. Finish or cancel active quotes before creating another." }
                            table {
                                thead { tr {
                                    th { "Ticket" } th { "Kind" } th { "Amount" } th { "Status" } th { "Created" }
                                } }
                                tbody {
                                    @for t in &active {
                                        tr {
                                            td { span.id-chip { (short_id(&t.id)) } }
                                            td.muted { (kind_label(t.kind)) }
                                            td { (amount_cell(t.amount, &t.unit)) }
                                            td { (status_pill(t.status)) }
                                            td.muted { (relative_age(t.created_at, now)) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            section {
                div.card {
                    div.card-header {
                        h2.card-title { "Recent activity" }
                        span.muted { "Last " (done.len()) " events" }
                    }
                    @if done.is_empty() {
                        div.empty {
                            div.empty-title { "Quiet day" }
                            div { "Settled tickets will appear here." }
                        }
                    } @else {
                        div.card-body.zero {
                            table {
                                thead { tr {
                                    th { "Ticket" } th { "Kind" } th { "Amount" }
                                    th { "Status" } th { "When" } th { "Notes" }
                                } }
                                tbody {
                                    @for t in &done {
                                        tr {
                                            td { span.id-chip { (short_id(&t.id)) } }
                                            td.muted { (kind_label(t.kind)) }
                                            td { (amount_cell(t.amount, &t.unit)) }
                                            td { (status_pill(t.status)) }
                                            td.muted { (relative_age(t.paid_at.unwrap_or(t.created_at), now)) }
                                            td.muted { (t.notes.as_deref().unwrap_or("—")) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    )
    .into_response()
}

#[allow(dead_code)]
async fn login_page() -> Markup {
    layout_no_chrome(
        "Sign in",
        html! {
            div.auth-shell {
                div.auth-card {
                    div.brand {
                        span.brand-mark { "◐" }
                        span.brand-name { "Branch" }
                    }
                    h1 { "Operator sign-in" }
                    p { "Enter the operator password to continue." }
                    form method="post" action="/login" {
                        div.field {
                            label for="pw" { "Password" }
                            input id="pw" type="password" name="password" autofocus autocomplete="current-password";
                        }
                        button type="submit" class="btn btn-primary btn-block" { "Sign in" }
                    }
                }
            }
        },
    )
}

#[derive(Deserialize)]
struct LoginForm {
    password: String,
}

async fn login_submit(State(state): State<WebState>, Form(form): Form<LoginForm>) -> Response {
    if !state.config.verify_password(&form.password) {
        return (
            StatusCode::UNAUTHORIZED,
            layout_no_chrome(
                "Sign in",
                html! {
                    div.auth-shell {
                        div.auth-card {
                            div.brand {
                                span.brand-mark { "◐" }
                                span.brand-name { "Branch" }
                            }
                            h1 { "Operator sign-in" }
                            div.alert.alert-error { "Incorrect password." }
                            form method="post" action="/login" {
                                div.field {
                                    label for="pw" { "Password" }
                                    input id="pw" type="password" name="password" autofocus;
                                }
                                button type="submit" class="btn btn-primary btn-block" { "Sign in" }
                            }
                        }
                    }
                },
            ),
        )
            .into_response();
    }
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.write().await.insert(
        sid.clone(),
        Session {
            expires_at: unix_now() + 12 * 60 * 60,
        },
    );
    let mut resp = Redirect::to("/").into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE_NAME}={sid}; Path=/; HttpOnly; SameSite=Lax")
            .parse()
            .unwrap(),
    );
    resp
}

async fn logout(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Some(c) = cookie_value(&headers) {
        state.sessions.write().await.remove(&c);
    }
    let mut resp = Redirect::to("/login").into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE_NAME}=deleted; Path=/; Max-Age=0")
            .parse()
            .unwrap(),
    );
    resp
}

#[derive(Deserialize)]
struct CreateQuoteForm {
    kind: String,
    amount: u64,
    #[serde(default)]
    unit: String,
    #[serde(default)]
    description: String,
}

/// How long a displayed offer can be claimed before the teller must reissue.
const OFFER_TTL_SECS: u64 = 15 * 60;

async fn create_quote_inner(state: &WebState, form: CreateQuoteForm) -> Result<Ticket, String> {
    if form.amount == 0 {
        return Err("amount must be greater than zero".to_string());
    }
    if !state.branch.active_tickets().await.is_empty() {
        return Err("finish the active quote before creating another".to_string());
    }

    let description = match form.description.trim() {
        "" => None,
        s => Some(s.to_string()),
    };

    let unit = if form.unit.trim().is_empty() {
        state.config.mint.unit.as_str()
    } else {
        form.unit.trim()
    };
    let managed = state
        .config
        .managed_unit(unit)
        .ok_or_else(|| format!("unit {unit} is not managed by this stack"))?;
    let (kind, operation) = match form.kind.as_str() {
        "mint" if managed.lifecycle.can_mint() => (TicketKind::Incoming, "mint"),
        "melt" if managed.lifecycle.can_melt() => (TicketKind::Outgoing, "melt"),
        "mint" => {
            return Err(format!(
                "{unit} is redemption-only; new mint offers are disabled"
            ))
        }
        "melt" => return Err(format!("{unit} is retired; melt offers are disabled")),
        other => return Err(format!("unknown quote flow: {other}")),
    };

    // Register the ticket and hand out the serialized offer. The wallet creates
    // the actual mint/melt quote itself by claiming the ticket (NUT-XX); the
    // processor no longer pre-creates quotes through the mint's public API.
    let expires_at = unix_now() + OFFER_TTL_SECS;
    let mut ticket = Ticket::new_offer(
        kind,
        form.amount,
        unit.to_string(),
        description.clone(),
        Some(expires_at),
    );
    let offer = QuoteOffer {
        mint_url: state.mint_public_url.trim_end_matches('/').to_string(),
        operation,
        method: state.method.as_str().to_string(),
        unit: unit.to_string(),
        ticket: ticket.id.clone(),
        amount: Some(form.amount),
        description,
        expiry: Some(expires_at),
    };
    ticket.offer = Some(offer.encode());

    state
        .branch
        .insert_active(ticket)
        .await
        .map_err(|e| format!("register offer: {e}"))
}

async fn create_quote(
    State(state): State<WebState>,
    headers: HeaderMap,
    Form(form): Form<CreateQuoteForm>,
) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    if let Err(e) = create_quote_inner(&state, form).await {
        return error_response(&e);
    }

    Redirect::to("/teller").into_response()
}

#[derive(Deserialize)]
struct NotesForm {
    #[serde(default)]
    notes: String,
}

fn clean_notes(notes: String) -> Option<String> {
    let notes = notes.trim().to_string();
    if notes.is_empty() {
        None
    } else {
        Some(notes)
    }
}

async fn mark_paid_inner(state: &WebState, id: &str, notes: String) -> Result<Ticket, String> {
    state
        .branch
        .mark_paid(id, clean_notes(notes))
        .await
        .map_err(|e| format!("mark_paid: {e}"))
}

async fn mark_failed_inner(state: &WebState, id: &str, notes: String) -> Result<Ticket, String> {
    state
        .branch
        .mark_failed(id, clean_notes(notes))
        .await
        .map_err(|e| format!("mark_failed: {e}"))
}

async fn mark_paid(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Form(form): Form<NotesForm>,
) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    if let Err(e) = mark_paid_inner(&state, &id, form.notes).await {
        return error_response(&e);
    }
    Redirect::to("/teller").into_response()
}

async fn mark_failed(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Form(form): Form<NotesForm>,
) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    if let Err(e) = mark_failed_inner(&state, &id, form.notes).await {
        return error_response(&e);
    }
    Redirect::to("/").into_response()
}

#[allow(dead_code)]
async fn keysets_page(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    let snap = match state.mint_http.list_keysets().await {
        Ok(v) => v,
        Err(e) => return error_response(&format!("mint /v1/keysets: {e}")),
    };
    let now = unix_now();

    let body = html! {
        section {
            div.card {
                div.card-header {
                    div {
                        h2.card-title { "Keysets · " (state.unit) }
                        p.card-subtitle { "Active is the keyset the mint signs new ecash with. Expiry is enforced natively by the mint — once final_expiry passes, swap/mint/melt operations involving the keyset are rejected with ExpiredKeyset (12003)." }
                    }
                    span.pill { (snap.len()) " total" }
                }
                @if snap.is_empty() {
                    div.empty {
                        div.empty-title { "No keysets yet" }
                        div { "Rotate one below." }
                    }
                } @else {
                    div.card-body.zero {
                        table {
                            thead { tr {
                                th { "Keyset ID" } th { "Status" } th { "Final expiry" } th { "Fee ppk" }
                            } }
                            tbody {
                                @for ks in &snap {
                                    tr {
                                        td { span.id-chip.full { (ks.id) } }
                                        td { (keyset_status_pill(ks.active, ks.final_expiry, now)) }
                                        td.muted { (fmt_expiry(ks.final_expiry, now)) }
                                        td.mono { (ks.input_fee_ppk) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        section {
            div.card {
                div.card-header {
                    div {
                        h2.card-title { "Rotate to a new active keyset" }
                        p.card-subtitle { "The new keyset becomes active and the mint signs all new ecash with it. The previous keyset becomes inactive — its proofs continue to verify until its baked-in final_expiry passes." }
                    }
                }
                div.card-body {
                    form method="post" action="/keysets/rotate" {
                        div.field-row {
                            div.field {
                                label { "Unit" }
                                input type="text" name="unit" value=(state.unit.to_string()) readonly;
                            }
                            div.field {
                                label { "Input fee (ppk)" }
                                input type="number" name="input_fee_ppk" value="0";
                            }
                        }
                        div.field {
                            label { "Amounts" }
                            input type="text" name="amounts" value=(default_amounts_str(&state.default_amounts));
                            div.field-help { "Comma-separated powers of 2 for the denominations this keyset will sign." }
                        }
                        div.field {
                            label { "Final expiry · unix seconds" }
                            input type="number" name="final_expiry" placeholder="leave blank for no expiry";
                            div.field-help { "Immutable once the keyset is created. To 'expire now', leave any old keyset's expiry as set at its creation and rotate to a fresh one; ecash on the old keyset will stop verifying when its baked-in expiry passes." }
                        }
                        hr.sep;
                        div.form-row {
                            button type="submit" class="btn btn-primary" { "Rotate" }
                            a.btn.btn-ghost href="/keysets" { "Cancel" }
                        }
                    }
                }
            }
        }
    };
    layout("Keysets", body).into_response()
}

#[derive(Deserialize)]
struct RotateForm {
    unit: String,
    amounts: String,
    #[serde(default)]
    input_fee_ppk: Option<u64>,
    #[serde(default, deserialize_with = "empty_string_as_none")]
    final_expiry: Option<u64>,
}

fn empty_string_as_none<'de, D>(d: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(d)?;
    match opt.as_deref().map(str::trim) {
        Some("") | None => Ok(None),
        Some(s) => s.parse::<u64>().map(Some).map_err(serde::de::Error::custom),
    }
}

async fn rotate_keyset_inner(state: &WebState, form: RotateForm) -> Result<(), String> {
    let managed = state
        .config
        .managed_unit(form.unit.trim())
        .ok_or_else(|| format!("unit {} is not managed by this stack", form.unit.trim()))?;
    if managed.lifecycle != UnitLifecycle::Active {
        return Err(format!(
            "{} is not active; keyset rotation is disabled while redemption-only or retired",
            managed.unit
        ));
    }
    let amounts: Result<Vec<u64>, _> = form
        .amounts
        .split(',')
        .map(|s| s.trim().parse::<u64>())
        .collect();
    let amounts = amounts.map_err(|e| format!("amounts: {e}"))?;
    if amounts.is_empty() || amounts.contains(&0) {
        return Err("amounts must contain positive denominations".to_string());
    }
    if amounts != managed.rollover.amounts {
        return Err(format!(
            "amounts must match the persisted {} unit policy",
            managed.unit
        ));
    }
    let input_fee_ppk = form.input_fee_ppk.unwrap_or(managed.rollover.input_fee_ppk);
    if input_fee_ppk != managed.rollover.input_fee_ppk {
        return Err(format!(
            "input fee must match the persisted {} unit policy",
            managed.unit
        ));
    }
    let now = unix_now();
    let final_expiry = form.final_expiry.unwrap_or_else(|| {
        now.saturating_add(managed.rollover.keyset_lifetime_days.saturating_mul(86_400))
    });
    if final_expiry <= now {
        return Err("final expiry must be in the future".to_string());
    }
    state
        .mint_rpc
        .rotate_next_keyset(
            managed.unit.clone(),
            amounts,
            Some(input_fee_ppk),
            Some(final_expiry),
        )
        .await
        .map_err(|e| format!("rotate: {e}"))?;
    Ok(())
}

async fn rotate_keyset(
    State(state): State<WebState>,
    headers: HeaderMap,
    Form(form): Form<RotateForm>,
) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    if let Err(e) = rotate_keyset_inner(&state, form).await {
        return error_response(&e);
    }
    Redirect::to("/keysets").into_response()
}

#[allow(dead_code)]
async fn settings_page(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }

    layout(
        "Settings",
        html! {
            section {
                div.card {
                    div.card-header {
                        div {
                            h2.card-title { "Mint configuration" }
                            p.card-subtitle { "These values were committed during first-run setup." }
                        }
                        span.pill.pill-inactive { "Read-only" }
                    }
                    div.card-body {
                        div.detail-list {
                            div { span.muted { "Name" } strong { (state.config.mint.name.as_str()) } }
                            div { span.muted { "Unit" } strong.mono { (state.config.mint.unit.as_str()) } }
                            div { span.muted { "Method" } strong.mono { (state.config.mint.method.as_str()) } }
                            div { span.muted { "Public URL" } strong.mono.wrap { (state.config.endpoints.public_url.as_str()) } }
                            div { span.muted { "Mint HTTP" } strong.mono.wrap { (state.config.endpoints.mint_http_url.as_str()) } }
                            div { span.muted { "Management RPC" } strong.mono.wrap { (state.config.endpoints.mint_rpc_url.as_str()) } }
                        }
                    }
                }
            }

            section {
                div.card {
                    div.card-header {
                        div {
                            h2.card-title { "Keyset rollover" }
                            p.card-subtitle { "Expiry policy used by the background rollover worker." }
                        }
                        @if state.config.rollover.enabled {
                            span.pill.pill-active { "Enabled" }
                        } @else {
                            span.pill.pill-inactive { "Disabled" }
                        }
                    }
                    div.card-body {
                        div.detail-list {
                            div { span.muted { "Lifetime" } strong { (state.config.rollover.keyset_lifetime_days) " days" } }
                            div { span.muted { "Rotate before expiry" } strong { (state.config.rollover.rotate_before_expiry_days) " days" } }
                            div { span.muted { "Input fee" } strong.mono { (state.config.rollover.input_fee_ppk) " ppk" } }
                            div { span.muted { "Denominations" } strong.mono.wrap { (default_amounts_str(&state.config.rollover.amounts)) } }
                        }
                    }
                }
            }

            section {
                div.card {
                    div.card-header {
                        div {
                            h2.card-title { "Reset guidance" }
                            p.card-subtitle { "Immutable settings are protected by the data volumes." }
                        }
                    }
                    div.card-body {
                        div.alert.alert-warning { "Changing the unit, method, or recovery phrase requires a deliberate reset of the processor, config, and mint data volumes. Do not reset a production mint without first draining and backing up operational records." }
                    }
                }
            }
        },
    )
    .into_response()
}

// ---------------- helpers ----------------

#[allow(dead_code)]
fn metric_card(
    label: impl std::fmt::Display,
    value: impl std::fmt::Display,
    detail: impl std::fmt::Display,
) -> Markup {
    html! {
        div.metric {
            span.metric-label { (label) }
            strong.metric-value { (value) }
            span.metric-detail { (detail) }
        }
    }
}

fn health_label(ok: bool) -> &'static str {
    if ok {
        "Healthy"
    } else {
        "Offline"
    }
}

#[allow(dead_code)]
fn health_detail(err: Option<&anyhow::Error>) -> String {
    match err {
        Some(e) => e.to_string(),
        None => "Responding normally".to_string(),
    }
}

#[allow(dead_code)]
fn amount_text(amount: u64, unit: &str) -> String {
    format!("{amount} {}", unit.to_ascii_uppercase())
}

#[allow(dead_code)]
fn signed_amount_text(amount: i128, unit: &str) -> String {
    if amount < 0 {
        format!("-{} {}", amount.abs(), unit.to_ascii_uppercase())
    } else {
        format!("{amount} {}", unit.to_ascii_uppercase())
    }
}

#[allow(dead_code)]
fn active_quote_panel(ticket: &Ticket, now: u64, _state: &WebState) -> Markup {
    let (title, subtitle) = match (ticket.kind, ticket.status) {
        (TicketKind::Incoming, TicketStatus::Pending) => {
            ("Cash deposit", "Customer pays cash before ecash is issued.")
        }
        (TicketKind::Outgoing, TicketStatus::Waiting) => {
            ("Cash dispense", "Waiting for the wallet to lock ecash.")
        }
        (TicketKind::Outgoing, TicketStatus::Pending) => {
            ("Cash dispense", "Ecash is locked; cash can be handed over.")
        }
        _ => ("Quote", "Quote is no longer active."),
    };
    // Legacy no-JS panel: the only thing displayed to the wallet is the offer.
    let quote_url = ticket.offer.clone();

    html! {
        div.card-body {
            div.quote-workspace {
                div.quote-main {
                    div.quote-heading {
                        div {
                            h3 { (title) }
                            p { (subtitle) }
                        }
                        (status_pill(ticket.status))
                    }
                    div.quote-amount {
                        (amount_cell(ticket.amount, &ticket.unit))
                    }
                    div.quote-grid {
                        div.quote-meta {
                            span.muted { "Quote" }
                            @if let Some(quote_id) = ticket.quote_id.as_deref() {
                                span.id-chip.full { (quote_id) }
                            } @else {
                                span.id-chip.full { (ticket.id) }
                            }
                        }
                        div.quote-meta {
                            span.muted { "Ticket" }
                            span.id-chip.full { (ticket.id) }
                        }
                        div.quote-meta {
                            span.muted { "Created" }
                            span { (relative_age(ticket.created_at, now)) }
                        }
                        @if let Some(description) = ticket.description.as_deref() {
                            div.quote-meta {
                                span.muted { "Note" }
                                span { (description) }
                            }
                        }
                    }
                    @if let Some(url) = quote_url.as_deref() {
                        div.quote-url {
                            span.muted { "Fetch URL" }
                            span.mono { (url) }
                        }
                    }
                }
                div.quote-qr {
                    @if let Some(url) = quote_url.as_deref() {
                        (qr_code_markup(url))
                    } @else {
                        div.qr-placeholder { "No quote id" }
                    }
                }
            }
            (active_quote_actions(ticket))
        }
    }
}

#[allow(dead_code)]
fn active_quote_actions(ticket: &Ticket) -> Markup {
    html! {
        div.settlement-actions {
            @match (ticket.kind, ticket.status) {
                (TicketKind::Incoming, TicketStatus::Pending) => {
                    form method="post" action={ "/tickets/" (ticket.id) "/mark-paid" } {
                        input type="text" name="notes" placeholder="Receipt note (optional)";
                        button type="submit" class="btn btn-success" { "Cash received" }
                    }
                    form method="post" action={ "/tickets/" (ticket.id) "/mark-failed" } class="inline" {
                        button type="submit" class="btn btn-danger" { "Cancel" }
                    }
                }
                (TicketKind::Outgoing, TicketStatus::Waiting) => {
                    form method="post" action={ "/tickets/" (ticket.id) "/mark-failed" } class="inline" {
                        button type="submit" class="btn btn-danger" { "Cancel quote" }
                    }
                }
                (TicketKind::Outgoing, TicketStatus::Pending) => {
                    form method="post" action={ "/tickets/" (ticket.id) "/mark-paid" } {
                        input type="text" name="notes" placeholder="Receipt note (optional)";
                        button type="submit" class="btn btn-success" { "Cash handed over" }
                    }
                    form method="post" action={ "/tickets/" (ticket.id) "/mark-failed" } class="inline" {
                        button type="submit" class="btn btn-danger" { "Cancel" }
                    }
                }
                _ => {}
            }
        }
    }
}

#[allow(dead_code)]
fn qr_code_markup(data: &str) -> Markup {
    match qr_code_svg(data) {
        Some(image) => html! { div.qr-frame { (PreEscaped(image)) } },
        None => html! { div.alert.alert-error { "QR error" } },
    }
}

fn qr_code_svg(data: &str) -> Option<String> {
    match QrCode::new(data.as_bytes()) {
        Ok(code) => {
            let mut image = code
                .render::<svg::Color>()
                .min_dimensions(220, 220)
                .dark_color(svg::Color("#0a0a0a"))
                .light_color(svg::Color("#ffffff"))
                .build();
            if let Some(svg) = image.strip_prefix(r#"<?xml version="1.0" standalone="yes"?>"#) {
                image = svg.to_string();
            }
            Some(image)
        }
        Err(_) => None,
    }
}

fn layout(title: &str, body: Markup) -> Markup {
    layout_with_chrome(title, body, true)
}

fn layout_no_chrome(title: &str, body: Markup) -> Markup {
    layout_with_chrome(title, body, false)
}

fn layout_with_chrome(title: &str, body: Markup, chrome: bool) -> Markup {
    html! {
        (DOCTYPE)
        html lang="en" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width,initial-scale=1";
                meta name="color-scheme" content="light dark";
                title { (title) " · Branch" }
                style { (PreEscaped(CSS)) }
            }
            body {
                @if chrome {
                    header.topbar {
                        div.brand {
                            span.brand-mark { "◐" }
                            span.brand-name { "Branch" }
                        }
                        nav.topnav {
                            a href="/" { "Overview" }
                            a href="/teller" { "Teller" }
                            a href="/keysets" { "Keysets" }
                            a href="/settings" { "Settings" }
                            form method="post" action="/logout" class="inline" {
                                button type="submit" class="btn btn-ghost btn-sm" { "Sign out" }
                            }
                        }
                    }
                }
                main.shell { (body) }
                @if chrome {
                    // SSE listener — the server pushes "change" events whenever the
                    // ticket store mutates. We debounce briefly so a burst of changes
                    // collapses to one reload.
                    script { (PreEscaped(LIVE_RELOAD_JS)) }
                }
            }
        }
    }
}

const CSS: &str = r#"
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/static/inter.woff2") format("woff2-variations"),
       url("/static/inter.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 400 500;
  font-display: swap;
  src: url("/static/jbm.woff2") format("woff2");
}

:root {
  color-scheme: light dark;
  --bg: #f7f7f8;
  --surface: #ffffff;
  --surface-2: #fafafa;
  --fg: #0a0a0a;
  --fg-muted: #71717a;
  --fg-subtle: #a1a1aa;
  --border: #e4e4e7;
  --border-strong: #d4d4d8;
  --accent: #2563eb;
  --accent-fg: #ffffff;
  --accent-soft: rgba(37, 99, 235, 0.10);
  --success: #15803d;
  --success-soft: rgba(34, 197, 94, 0.14);
  --warning: #b45309;
  --warning-soft: rgba(245, 158, 11, 0.16);
  --danger: #b91c1c;
  --danger-soft: rgba(239, 68, 68, 0.14);
  --shadow-sm: 0 1px 2px rgba(0,0,0,.04);
  --shadow-md: 0 1px 3px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.04);
  --radius: 10px;
  --radius-sm: 6px;
  --radius-pill: 999px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b;
    --surface: #111114;
    --surface-2: #16161a;
    --fg: #fafafa;
    --fg-muted: #a1a1aa;
    --fg-subtle: #71717a;
    --border: #27272a;
    --border-strong: #3f3f46;
    --accent: #3b82f6;
    --accent-soft: rgba(59, 130, 246, 0.18);
    --success: #4ade80;
    --success-soft: rgba(74, 222, 128, 0.12);
    --warning: #fbbf24;
    --warning-soft: rgba(251, 191, 36, 0.14);
    --danger: #f87171;
    --danger-soft: rgba(248, 113, 113, 0.14);
    --shadow-sm: 0 1px 2px rgba(0,0,0,.6);
    --shadow-md: 0 1px 3px rgba(0,0,0,.5), 0 8px 24px rgba(0,0,0,.4);
  }
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
h1, h2, h3, h4, h5, h6, p, button, input, select, textarea, label, a, span, td, th { font-family: inherit; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* Top bar */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
  backdrop-filter: saturate(180%) blur(8px);
}
.brand { display: flex; align-items: center; gap: 10px; }
.brand-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border-radius: var(--radius-sm);
  background: var(--accent); color: var(--accent-fg);
  font-weight: 700; font-size: 16px;
}
.brand-name { font-weight: 600; letter-spacing: -0.01em; }
.topnav { display: flex; align-items: center; gap: 8px; }
.topnav a { color: var(--fg-muted); padding: 6px 10px; border-radius: var(--radius-sm); font-weight: 500; }
.topnav a:hover { color: var(--fg); background: var(--surface-2); text-decoration: none; }

/* Shell */
.shell { max-width: 1100px; margin: 0 auto; padding: 28px; }
.shell > section + section { margin-top: 20px; }

/* Cards */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.card-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.card-title { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.005em; }
.card-subtitle { color: var(--fg-muted); font-size: 13px; margin: 2px 0 0; }
.card-body { padding: 16px 20px; }
.card-body.padded-tight { padding: 12px 20px; }
.card-body.zero { padding: 0; }

/* Section headings */
.section-eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--fg-subtle);
  margin: 0 0 10px;
}

/* Empty state */
.empty {
  padding: 28px 20px;
  text-align: center;
  color: var(--fg-muted);
}
.empty .empty-title { font-weight: 500; color: var(--fg); margin-bottom: 4px; }

/* Tables */
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left; font-size: 12px; font-weight: 500;
  color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em;
  padding: 10px 20px; background: var(--surface-2); border-bottom: 1px solid var(--border);
}
tbody td {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }

/* Text helpers */
.mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.id-chip {
  display: inline-block; padding: 2px 8px;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
  color: var(--fg-muted);
}
.id-chip.full { font-size: 11.5px; word-break: break-all; }
.amount { font-weight: 600; font-variant-numeric: tabular-nums; }
.amount .unit { font-weight: 400; color: var(--fg-muted); margin-left: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.muted { color: var(--fg-muted); }
.subtle { color: var(--fg-subtle); }

/* Pills (status, badges) */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px; font-weight: 500;
  background: var(--surface-2);
  color: var(--fg-muted);
  border: 1px solid var(--border);
}
.pill::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
}
.pill-waiting { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.pill-pending { background: var(--warning-soft); color: var(--warning); border-color: transparent; }
.pill-paid { background: var(--success-soft); color: var(--success); border-color: transparent; }
.pill-failed { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
.pill-active { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.pill-inactive { background: var(--surface-2); color: var(--fg-muted); border-color: var(--border); }
.pill-expired { background: var(--danger-soft); color: var(--danger); border-color: transparent; }

/* Buttons */
.btn {
  font: inherit; font-weight: 500; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: var(--surface);
  color: var(--fg);
  cursor: pointer;
  transition: background-color .12s, border-color .12s, color .12s, transform .04s;
  white-space: nowrap;
}
.btn:active { transform: translateY(1px); }
.btn-sm { padding: 6px 10px; font-size: 12.5px; }
.btn-block { width: 100%; }
.btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn-primary:hover { filter: brightness(1.08); }
.btn-success { background: var(--success); color: white; border-color: var(--success); }
.btn-success:hover { filter: brightness(1.08); }
.btn-danger { background: transparent; color: var(--danger); border-color: var(--border-strong); }
.btn-danger:hover { background: var(--danger); color: white; border-color: var(--danger); }
.btn-ghost { background: transparent; color: var(--fg-muted); border-color: transparent; }
.btn-ghost:hover { background: var(--surface-2); color: var(--fg); }
.btn-outline { background: transparent; border-color: var(--border-strong); }
.btn-outline:hover { background: var(--surface-2); }
.btn:disabled,
.btn[aria-disabled="true"] {
  opacity: .55;
  cursor: not-allowed;
  transform: none;
}
.btn:disabled:hover,
.btn[aria-disabled="true"]:hover {
  filter: none;
}
.btn-primary:disabled:hover,
.btn-primary[aria-disabled="true"]:hover {
  background: var(--accent);
}
.btn-outline:disabled:hover,
.btn-outline[aria-disabled="true"]:hover {
  background: transparent;
}

/* Forms */
form.inline { display: inline; margin: 0; }
.form-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.form-row.compact > * { flex: 0 0 auto; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 720px) { .field-row { grid-template-columns: 1fr; } }
.field label { font-size: 12px; font-weight: 500; color: var(--fg-muted); }
.field-help { font-size: 12px; color: var(--fg-subtle); }
input[type=text], input[type=password], input[type=number] {
  font: inherit; font-size: 14px;
  padding: 9px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--fg);
  width: 100%;
}
textarea {
  font: inherit; font-size: 14px; line-height: 1.45;
  padding: 9px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--fg);
  width: 100%;
  resize: vertical;
}
select {
  font: inherit; font-size: 14px;
  padding: 9px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--fg);
  width: 100%;
}
input::placeholder { color: var(--fg-subtle); }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
input[readonly] { background: var(--surface-2); color: var(--fg-muted); }
input:invalid:not(:focus),
textarea:invalid:not(:focus) {
  box-shadow: none;
}

/* Overview */
.overview-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}
.overview-hero h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
  font-weight: 650;
}
.overview-hero p {
  margin: 6px 0 0;
  color: var(--fg-muted);
  max-width: 70ch;
}
.hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
}
.metric {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  min-width: 0;
}
.metric-label {
  display: block;
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 500;
}
.metric-value {
  display: block;
  margin-top: 4px;
  font-size: 22px;
  line-height: 1.2;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.metric-detail {
  display: block;
  margin-top: 5px;
  color: var(--fg-subtle);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.split-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.detail-list {
  display: grid;
  gap: 12px;
}
.detail-list > div {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
  align-items: baseline;
}
.wrap { overflow-wrap: anywhere; }
@media (max-width: 820px) {
  .overview-hero { align-items: flex-start; flex-direction: column; }
  .split-grid { grid-template-columns: 1fr; }
  .detail-list > div { grid-template-columns: 1fr; gap: 3px; }
}

/* Row of inline action buttons in a table cell */
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; }
.actions input { width: auto; min-width: 200px; padding: 7px 10px; font-size: 13px; }
.actions form { display: flex; gap: 6px; align-items: center; }

/* Active quote */
.quote-form { display: flex; flex-direction: column; gap: 14px; }
.quote-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 24px;
  align-items: start;
}
.quote-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.quote-heading h3 { margin: 0; font-size: 18px; font-weight: 600; }
.quote-heading p { margin: 2px 0 0; color: var(--fg-muted); font-size: 13px; }
.quote-amount { margin-top: 18px; font-size: 22px; }
.quote-amount .amount .unit { font-size: 13px; }
.quote-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}
.quote-meta { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.quote-url {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 14px;
  min-width: 0;
}
.quote-url .mono {
  display: block;
  overflow-wrap: anywhere;
  color: var(--fg-muted);
}
.quote-qr { display: flex; justify-content: center; }
.qr-frame {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
  line-height: 0;
}
.qr-frame svg { width: 220px; height: 220px; display: block; }
.qr-placeholder {
  width: 246px; height: 246px;
  display: grid; place-items: center;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
}
.settlement-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.settlement-actions form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.settlement-actions input { width: 240px; }
@media (max-width: 780px) {
  .quote-workspace { grid-template-columns: 1fr; }
  .quote-grid { grid-template-columns: 1fr; }
  .quote-qr { justify-content: flex-start; }
  .settlement-actions input { width: 100%; }
}

/* Setup */
.setup-shell {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 44px 20px;
  background: var(--bg);
}
.setup-panel {
  width: min(900px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px;
}
.setup-panel.compact { max-width: 560px; align-self: center; }
.setup-head {
  border-bottom: 1px solid var(--border);
  padding-bottom: 20px;
  margin-bottom: 20px;
}
.setup-head .brand, .setup-panel.compact .brand { margin-bottom: 16px; }
.setup-head h1, .setup-panel.compact h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
  font-weight: 650;
}
.lede {
  margin: 8px 0 0;
  max-width: 74ch;
  color: var(--fg-muted);
}
.setup-form { display: grid; gap: 22px; }
.setup-section {
  display: grid;
  gap: 14px;
}
.setup-section h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.password-control {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.password-control input {
  flex: 1 1 auto;
  min-width: 0;
}
.password-control .btn {
  flex: 0 0 auto;
}
.password-rules {
  list-style: none;
  padding: 0;
  margin: -2px 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 12px;
}
.password-rules li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg-muted);
  font-size: 12px;
}
.password-rules li[data-valid="true"] {
  color: var(--success);
}
.rule-status {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-width: 52px;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
}
.password-rules li[data-valid="true"] .rule-status {
  background: var(--success-soft);
  border-color: transparent;
  color: var(--success);
}
.checkbox-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--fg);
}
.checkbox-row input {
  width: auto;
  margin-top: 3px;
}
.setup-review {
  padding: 12px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.setup-submit-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.setup-submit-hint {
  color: var(--fg-muted);
  font-size: 13px;
}
.setup-submit-hint[data-valid="true"] {
  color: var(--success);
}
.status-list { display: grid; gap: 12px; margin: 18px 0; }
.status-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.status-row p { margin: 2px 0 0; overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .password-control { flex-direction: column; }
  .password-control .btn { width: 100%; }
  .setup-submit-row .btn { width: 100%; }
}

/* Login */
.auth-shell {
  min-height: 100vh; display: grid; place-items: center; padding: 40px 20px;
  background: var(--bg);
}
.auth-card {
  width: 100%; max-width: 360px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  padding: 28px;
}
.auth-card .brand { justify-content: center; margin-bottom: 18px; flex-direction: column; gap: 8px; }
.auth-card h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; text-align: center; }
.auth-card p { margin: 0 0 20px; color: var(--fg-muted); font-size: 13px; text-align: center; }
.auth-card .field + button { margin-top: 16px; }

/* Alerts */
.alert {
  padding: 12px 14px; border-radius: var(--radius-sm);
  font-size: 13px;
  margin-bottom: 14px;
  border: 1px solid transparent;
}
.alert-error { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
.alert-warning { background: var(--warning-soft); color: var(--warning); border-color: transparent; }

/* Tweaks */
hr.sep { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }

"#;

fn error_response(msg: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        layout(
            "Error",
            html! {
                section {
                    div.card {
                        div.card-header { h2.card-title { "Something went wrong" } }
                        div.card-body {
                            div.alert.alert-error { (msg) }
                            div.form-row {
                                a.btn.btn-outline href="/" { "Back to dashboard" }
                            }
                        }
                    }
                }
            },
        ),
    )
        .into_response()
}

fn short_id(id: &str) -> String {
    // "MINT-5a6c5a9e-..." → "MINT-5a6c5a9e"
    match id
        .find('-')
        .and_then(|p1| id[p1 + 1..].find('-').map(|p2| p1 + 1 + p2))
    {
        Some(end) => id[..end].to_string(),
        None => id.to_string(),
    }
}

#[allow(dead_code)]
fn amount_cell(amount: u64, unit: &str) -> Markup {
    html! {
        span.amount { (amount) span.unit { (unit) } }
    }
}

fn kind_label(k: TicketKind) -> &'static str {
    match k {
        TicketKind::Incoming => "Incoming",
        TicketKind::Outgoing => "Outgoing",
    }
}

#[allow(dead_code)]
fn status_pill(s: TicketStatus) -> Markup {
    let (cls, label) = match s {
        TicketStatus::Offered => ("pill pill-waiting", status_label(s)),
        TicketStatus::Waiting => ("pill pill-waiting", status_label(s)),
        TicketStatus::Pending => ("pill pill-pending", status_label(s)),
        TicketStatus::Paid => ("pill pill-paid", status_label(s)),
        TicketStatus::Failed => ("pill pill-failed", status_label(s)),
    };
    html! { span class=(cls) { (label) } }
}

fn status_label(s: TicketStatus) -> &'static str {
    match s {
        TicketStatus::Offered => "Offered",
        TicketStatus::Waiting => "Claimed",
        TicketStatus::Pending => "Pending",
        TicketStatus::Paid => "Paid",
        TicketStatus::Failed => "Failed",
    }
}

#[allow(dead_code)]
fn keyset_status_pill(active: bool, final_expiry: Option<u64>, now: u64) -> Markup {
    let expired = matches!(final_expiry, Some(t) if t <= now);
    html! {
        @if expired {
            span.pill.pill-expired { "Expired" }
        } @else if active {
            span.pill.pill-active { "Active" }
        } @else {
            span.pill.pill-inactive { "Inactive" }
        }
    }
}

#[allow(dead_code)]
fn fmt_expiry(expiry: Option<u64>, now: u64) -> String {
    match expiry {
        None => "—".to_string(),
        Some(t) if t <= now => format!("expired {}", relative_age(t, now)),
        Some(t) => {
            let delta = t - now;
            if delta < 3600 {
                format!("in {}m", delta / 60)
            } else if delta < 86_400 {
                format!("in {}h", delta / 3600)
            } else {
                format!("in {}d", delta / 86_400)
            }
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[allow(dead_code)]
fn relative_age(then: u64, now: u64) -> String {
    if then >= now {
        return "just now".into();
    }
    let s = now - then;
    if s < 60 {
        format!("{s}s ago")
    } else if s < 3600 {
        format!("{}m ago", s / 60)
    } else if s < 86_400 {
        format!("{}h ago", s / 3600)
    } else {
        format!("{}d ago", s / 86_400)
    }
}

fn default_amounts_str(amounts: &[u64]) -> String {
    amounts
        .iter()
        .map(|a| a.to_string())
        .collect::<Vec<_>>()
        .join(",")
}
