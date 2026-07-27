//! Operator web API for the branch payment backend.
//!
//! Auth: username + password against the users.json store. POST /api/login →
//! cookie session id, persisted in sessions.json so config-change restarts do
//! not sign operators out. All other /api routes require a valid session whose
//! user still exists.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Json, Path as AxumPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use futures::stream::{Stream, StreamExt};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio::time::{sleep, Duration};
use tokio_stream::wrappers::BroadcastStream;

use crate::clients::{MintHttpClient, MintRpcClient};
use crate::config::{
    parse_amounts, AppConfig, ConfigStore, RolloverPolicy, UnitLifecycle, PASSWORD_MIN_LENGTH,
};
use crate::offer::QuoteOffer;
use crate::sessions::SessionStore;
use crate::state::{BranchState, Ticket, TicketKind, TicketStatus};
use crate::users::{PublicUser, UserError, UserStore};

#[derive(Clone)]
pub struct WebState {
    pub branch: BranchState,
    pub mint_rpc: MintRpcClient,
    pub mint_http: MintHttpClient,
    pub config: Arc<AppConfig>,
    pub users: UserStore,
    pub sessions: SessionStore,
    pub method: Arc<String>,
    pub mint_public_url: Arc<String>,
    pub default_amounts: Arc<Vec<u64>>,
    pub config_store: ConfigStore,
}

impl WebState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        branch: BranchState,
        mint_rpc: MintRpcClient,
        mint_http: MintHttpClient,
        config: AppConfig,
        config_store: ConfigStore,
        users: UserStore,
        sessions: SessionStore,
    ) -> Self {
        let method = config.mint.method.clone();
        let mint_public_url = config.endpoints.public_url.clone();
        let default_amounts = config.rollover.amounts.clone();
        Self {
            branch,
            mint_rpc,
            mint_http,
            config: Arc::new(config),
            users,
            sessions,
            method: Arc::new(method),
            mint_public_url: Arc::new(mint_public_url),
            default_amounts: Arc::new(default_amounts),
            config_store,
        }
    }
}

pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/", get(spa_page))
        .route("/teller", get(spa_page))
        .route("/keysets", get(spa_page))
        .route("/settings", get(spa_page))
        .route("/login", get(spa_page))
        .route("/api/app", get(api_app))
        .route("/api/login", post(api_login))
        .route("/api/logout", post(api_logout))
        .route("/api/quotes", post(api_create_quote))
        .route("/api/tickets/{id}/mark-paid", post(api_mark_paid))
        .route("/api/tickets/{id}/mark-failed", post(api_mark_failed))
        .route("/api/keysets/rotate", post(api_rotate_keyset))
        .route("/api/units", post(api_add_unit))
        .route("/api/units/{unit}/lifecycle", post(api_set_unit_lifecycle))
        .route("/api/units/{unit}/policy", post(api_set_unit_policy))
        .route("/api/settings/identity", post(api_update_identity))
        .route("/api/settings/mnemonic", post(api_reveal_mnemonic))
        .route("/api/users", post(api_users_create))
        .route("/api/users/{username}", delete(api_users_delete))
        .route(
            "/api/users/{username}/password",
            post(api_users_reset_password),
        )
        .route("/api/me/password", post(api_me_password))
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

async fn sse_events(
    State(state): State<WebState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, Response> {
    if authenticated(&state, &headers).await.is_none() {
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

/// The resolved identity behind a valid session cookie.
struct Authed {
    session_id: String,
    username: String,
}

async fn require_api_auth(state: &WebState, headers: &HeaderMap) -> Result<Authed, Response> {
    match authenticated(state, headers).await {
        Some(authed) => Ok(authed),
        None => Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized")),
    }
}

#[derive(Serialize)]
struct ApiAppSnapshot {
    now: u64,
    session: ApiSessionInfo,
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
    users: Vec<PublicUser>,
    demo_password_active: bool,
    password_min_length: usize,
}

#[derive(Serialize)]
struct ApiSessionInfo {
    username: String,
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
    let authed = match require_api_auth(&state, &headers).await {
        Ok(authed) => authed,
        Err(r) => return r,
    };

    let mut tickets = state.branch.list_all().await;
    tickets.sort_by_key(|ticket| std::cmp::Reverse(ticket.created_at));
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
        .map(capabilities_from_info)
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
        session: ApiSessionInfo {
            username: authed.username,
        },
        users: state.users.list().await,
        demo_password_active: state.users.demo_password_active().await,
        password_min_length: PASSWORD_MIN_LENGTH,
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
    let username = form.username.trim().to_ascii_lowercase();
    if !state.users.verify(&username, &form.password).await {
        return api_error(StatusCode::UNAUTHORIZED, "incorrect username or password");
    }
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.insert(&sid, &username).await;
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
        state.sessions.remove(&c).await;
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

// ---------------- unit policy ----------------

#[derive(Deserialize)]
struct UnitPolicyForm {
    #[serde(default = "default_true")]
    enabled: bool,
    keyset_lifetime_days: u64,
    rotate_before_expiry_days: u64,
    #[serde(default)]
    input_fee_ppk: u64,
    amounts: String,
}

fn default_true() -> bool {
    true
}

async fn api_set_unit_policy(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(unit): AxumPath<String>,
    Json(form): Json<UnitPolicyForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    if state.config.managed_unit(&unit).is_none() {
        return api_error(StatusCode::NOT_FOUND, format!("unit {unit} is not managed"));
    }
    let amounts = match parse_amounts(&form.amounts) {
        Ok(amounts) => amounts,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, format!("amounts: {e}")),
    };
    let policy = RolloverPolicy {
        enabled: form.enabled,
        keyset_lifetime_days: form.keyset_lifetime_days,
        rotate_before_expiry_days: form.rotate_before_expiry_days,
        input_fee_ppk: form.input_fee_ppk,
        amounts,
    };
    let mut config = (*state.config).clone();
    if let Err(e) = config.set_unit_rollover(&unit, policy) {
        return api_error(StatusCode::BAD_REQUEST, e.to_string());
    }
    // After the restart both the manual-rotate guard and the rollover worker
    // read the new policy. The regenerated mint.toml's initial_final_expiry
    // only matters for a unit's first keyset.
    match persist_config_and_restart(&state, &config).await {
        Ok(()) => Json(ApiMessage {
            message: "restarting",
        })
        .into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------- recovery ----------------

#[derive(Deserialize)]
struct MnemonicRevealForm {
    password: String,
}

#[derive(Serialize)]
struct MnemonicReveal {
    mnemonic: String,
}

async fn api_reveal_mnemonic(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<MnemonicRevealForm>,
) -> Response {
    let authed = match require_api_auth(&state, &headers).await {
        Ok(authed) => authed,
        Err(r) => return r,
    };
    // Re-entering the caller's own password gates the reveal. 403, not 401 —
    // the SPA treats 401 as session-expired and would bounce to /login.
    if !state.users.verify(&authed.username, &form.password).await {
        return api_error(StatusCode::FORBIDDEN, "password confirmation failed");
    }
    let mut resp = Json(MnemonicReveal {
        mnemonic: state.config.mint.mnemonic.clone(),
    })
    .into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    resp
}

// ---------------- users ----------------

#[derive(Deserialize)]
struct CreateUserForm {
    username: String,
    password: String,
    password_confirm: String,
}

#[derive(Deserialize)]
struct PasswordChangeForm {
    current_password: String,
    password: String,
    password_confirm: String,
}

#[derive(Deserialize)]
struct PasswordResetForm {
    password: String,
    password_confirm: String,
}

fn user_error_response(e: anyhow::Error) -> Response {
    let status = match e.downcast_ref::<UserError>() {
        Some(UserError::Invalid(_)) => StatusCode::BAD_REQUEST,
        Some(UserError::Duplicate(_)) => StatusCode::CONFLICT,
        Some(UserError::Unknown(_)) => StatusCode::NOT_FOUND,
        Some(UserError::DeleteSelf) | Some(UserError::DeleteLast) => StatusCode::CONFLICT,
        None => StatusCode::INTERNAL_SERVER_ERROR,
    };
    api_error(status, e.to_string())
}

async fn api_users_create(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<CreateUserForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    match state
        .users
        .create(&form.username, &form.password, &form.password_confirm)
        .await
    {
        Ok(user) => {
            state.branch.notify_ui_change();
            Json(user).into_response()
        }
        Err(e) => user_error_response(e),
    }
}

async fn api_users_delete(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(username): AxumPath<String>,
) -> Response {
    let authed = match require_api_auth(&state, &headers).await {
        Ok(authed) => authed,
        Err(r) => return r,
    };
    let username = username.trim().to_ascii_lowercase();
    match state.users.delete(&username, &authed.username).await {
        Ok(()) => {
            state.sessions.remove_for_user(&username, None).await;
            state.branch.notify_ui_change();
            Json(ApiMessage { message: "deleted" }).into_response()
        }
        Err(e) => user_error_response(e),
    }
}

async fn api_me_password(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<PasswordChangeForm>,
) -> Response {
    let authed = match require_api_auth(&state, &headers).await {
        Ok(authed) => authed,
        Err(r) => return r,
    };
    if !state
        .users
        .verify(&authed.username, &form.current_password)
        .await
    {
        return api_error(StatusCode::FORBIDDEN, "current password is incorrect");
    }
    match state
        .users
        .set_password(&authed.username, &form.password, &form.password_confirm)
        .await
    {
        Ok(()) => {
            // Other sessions of this user die; the current one survives.
            state
                .sessions
                .remove_for_user(&authed.username, Some(&authed.session_id))
                .await;
            state.branch.notify_ui_change();
            Json(ApiMessage {
                message: "password_changed",
            })
            .into_response()
        }
        Err(e) => user_error_response(e),
    }
}

async fn api_users_reset_password(
    State(state): State<WebState>,
    headers: HeaderMap,
    AxumPath(username): AxumPath<String>,
    Json(form): Json<PasswordResetForm>,
) -> Response {
    let authed = match require_api_auth(&state, &headers).await {
        Ok(authed) => authed,
        Err(r) => return r,
    };
    let username = username.trim().to_ascii_lowercase();
    if username == authed.username {
        // Self-changes must go through /api/me/password so the
        // current-password check cannot be sidestepped.
        return api_error(
            StatusCode::FORBIDDEN,
            "use /api/me/password to change your own password",
        );
    }
    match state
        .users
        .set_password(&username, &form.password, &form.password_confirm)
        .await
    {
        Ok(()) => {
            state.sessions.remove_for_user(&username, None).await;
            state.branch.notify_ui_change();
            Json(ApiMessage {
                message: "password_changed",
            })
            .into_response()
        }
        Err(e) => user_error_response(e),
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

async fn authenticated(state: &WebState, headers: &HeaderMap) -> Option<Authed> {
    let session_id = cookie_value(headers)?;
    let username = state.sessions.username_for(&session_id).await?;
    // Defense in depth: a persisted session of a since-deleted (or
    // corruption-reset) user must not authenticate.
    if !state.users.contains(&username).await {
        state.sessions.remove(&session_id).await;
        return None;
    }
    Some(Authed {
        session_id,
        username,
    })
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

#[derive(Deserialize)]
struct LoginForm {
    username: String,
    password: String,
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
    if unit.is_empty() {
        return Err("no units are configured yet; add one in the console's Units tab".to_string());
    }
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

// ---------------- helpers ----------------

fn health_label(ok: bool) -> &'static str {
    if ok {
        "Healthy"
    } else {
        "Offline"
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

fn kind_label(k: TicketKind) -> &'static str {
    match k {
        TicketKind::Incoming => "Incoming",
        TicketKind::Outgoing => "Outgoing",
    }
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

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
