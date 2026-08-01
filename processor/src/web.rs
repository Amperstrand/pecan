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
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio::time::{sleep, Duration};
use tokio_stream::wrappers::BroadcastStream;

use crate::backend::BranchBackend;
use crate::clients::{MintHttpClient, MintRpcClient};
use crate::config::{
    parse_amounts, AppConfig, ConfigStore, RolloverPolicy, UnitLifecycle, PASSWORD_MIN_LENGTH,
};
use crate::sessions::SessionStore;
use crate::state::{
    normalize_match_input, BranchState, MatchResult, Ticket, TicketKind, TicketStatus,
};
use crate::supply::{per_unit_supply, SupplyReader};
use crate::users::{PublicUser, UserError, UserStore};

#[derive(Clone)]
pub struct WebState {
    pub branch: BranchState,
    pub backend: Arc<BranchBackend>,
    pub mint_rpc: MintRpcClient,
    pub mint_http: MintHttpClient,
    pub supply: SupplyReader,
    pub config: Arc<AppConfig>,
    pub users: UserStore,
    pub sessions: SessionStore,
    pub method: Arc<String>,
    pub default_amounts: Arc<Vec<u64>>,
    pub config_store: ConfigStore,
    /// Image/build version (CDK_BRANCH_PROCESSOR_VERSION), "dev" outside CI.
    pub version: Arc<String>,
}

impl WebState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        branch: BranchState,
        backend: Arc<BranchBackend>,
        mint_rpc: MintRpcClient,
        mint_http: MintHttpClient,
        supply: SupplyReader,
        config: AppConfig,
        config_store: ConfigStore,
        users: UserStore,
        sessions: SessionStore,
        version: String,
    ) -> Self {
        let method = config.mint.method.clone();
        let default_amounts = config.rollover.amounts.clone();
        Self {
            branch,
            backend,
            mint_rpc,
            mint_http,
            supply,
            config: Arc::new(config),
            users,
            sessions,
            method: Arc::new(method),
            default_amounts: Arc::new(default_amounts),
            config_store,
            version: Arc::new(version),
        }
    }
}

pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/", get(spa_page))
        .route("/teller", get(spa_page))
        .route("/login", get(spa_page))
        // Unauthenticated liveness probe for container healthchecks and the
        // installer's wait loop.
        .route("/healthz", get(healthz))
        .route("/api/app", get(api_app))
        .route("/api/login", post(api_login))
        .route("/api/logout", post(api_logout))
        .route("/api/quotes/match", post(api_match_quote))
        .route("/api/tickets/{id}/mark-paid", post(api_mark_paid))
        .route("/api/tickets/{id}/mark-failed", post(api_mark_failed))
        .route("/api/keysets/rotate", post(api_rotate_keyset))
        .route("/api/units", post(api_add_unit))
        .route("/api/units/{unit}/lifecycle", post(api_set_unit_lifecycle))
        .route("/api/units/{unit}/policy", post(api_set_unit_policy))
        .route("/api/settings/identity", post(api_update_identity))
        .route("/api/settings/mint-connection", post(api_set_mint_connection))
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

#[derive(Serialize)]
struct HealthzBody {
    status: &'static str,
    version: String,
}

/// Liveness only, deliberately: mint "Standby" (zero units yet) is a normal
/// long-lived state and must not fail container health, and this is polled
/// every few seconds — no store reads, no mint probes, no auth. Subsystem
/// truth lives in the authenticated /api/app health tiles. The version lets
/// the installer confirm which build is answering after an update.
async fn healthz(State(state): State<WebState>) -> Response {
    let mut resp = Json(HealthzBody {
        status: "ok",
        version: state.version.as_ref().clone(),
    })
    .into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    resp
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

#[derive(Serialize)]
struct LoginResponse {
    message: &'static str,
    must_change_password: bool,
    /// The login page renders the set-a-new-password step before any
    /// authenticated snapshot exists, so the rule ships with the response.
    password_min_length: usize,
}

fn api_error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ApiError { error: msg.into() })).into_response()
}

/// The resolved identity behind a valid session cookie.
struct Authed {
    session_id: String,
    username: String,
    /// Still on the installer-provisioned password; must set their own first.
    must_change_password: bool,
}

/// Session-only check for the routes that must stay usable while a forced
/// password change is pending: the snapshot (the change screen renders from
/// it) and the password-change endpoint itself.
async fn require_api_session(state: &WebState, headers: &HeaderMap) -> Result<Authed, Response> {
    match authenticated(state, headers).await {
        Some(authed) => Ok(authed),
        None => Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized")),
    }
}

/// Default auth for API handlers. A pending forced password change locks the
/// account down to `/api/app` and `/api/me/password` — every other route lands
/// here so a newly added handler is gated unless it opts out deliberately.
async fn require_api_auth(state: &WebState, headers: &HeaderMap) -> Result<Authed, Response> {
    let authed = require_api_session(state, headers).await?;
    if authed.must_change_password {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "set your own password before continuing",
        ));
    }
    Ok(authed)
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
    supply: ApiSupply,
    circulation: Vec<CirculationPoint>,
    open_quotes: Vec<ApiOpenQuote>,
    recent_done: Vec<ApiTicket>,
    units: Vec<ApiManagedUnit>,
    capabilities: Vec<ApiCapability>,
    consistency: ApiConsistency,
    users: Vec<PublicUser>,
    demo_password_active: bool,
    password_min_length: usize,
    version: String,
    mint_connection: ApiMintConnection,
}

#[derive(Serialize)]
struct ApiMintConnection {
    /// "bundled" | "unset" | "external"
    mode: &'static str,
    http_url: Option<String>,
    rpc_url: Option<String>,
    advertised_grpc: Option<String>,
    /// Feature availability in this mode, stated instead of implied.
    supply_audit: bool,
    management_rpc: bool,
    /// External mode: the mint.toml fragment for the operator's cdk-mintd.
    external_snippet: Option<String>,
}

#[derive(Serialize)]
struct ApiSessionInfo {
    username: String,
    /// Mirrors the login response so a reload mid-flow still lands on the
    /// forced-change screen instead of the console.
    must_change_password: bool,
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

/// Audited supply straight from the mint database (per-keyset issued minus
/// redeemed, split by keyset expiry). `available: false` with no error means
/// auditing is disabled or the mint has not created its database yet.
#[derive(Serialize)]
struct ApiSupply {
    available: bool,
    error: Option<String>,
    units: Vec<ApiUnitSupply>,
}

#[derive(Serialize)]
struct ApiUnitSupply {
    unit: String,
    /// Redeemable ecash outstanding under non-expired keysets.
    live: u64,
    /// Ecash stranded under keysets past their final expiry.
    demonetized: u64,
    /// Value burned as input fees.
    fee_collected: u64,
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

/// Full ticket view. Ships to the browser only for settled tickets and as the
/// response to a successful match — never for the open-quote list, whose ids
/// must stay off the operator's screen.
#[derive(Serialize)]
struct ApiTicket {
    id: String,
    short_id: String,
    /// The mint's quote id — what the customer's wallet displays.
    quote_id: Option<String>,
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
}

/// Redacted row for the teller's open-quote list. `prefix` is the leading 13
/// characters of the quote id — the UUIDv7 timestamp section — so rows are
/// tellable apart while the random tail used for matching never renders.
#[derive(Serialize)]
struct ApiOpenQuote {
    prefix: String,
    kind: TicketKind,
    kind_label: &'static str,
    amount: u64,
    unit: String,
    status: TicketStatus,
    status_label: &'static str,
    created_at: u64,
    expires_at: Option<u64>,
}

impl ApiOpenQuote {
    fn from_ticket(ticket: &Ticket) -> Self {
        let prefix = ticket
            .quote_id
            .as_deref()
            .map(|quote_id| quote_id.chars().take(13).collect())
            .unwrap_or_else(|| short_id(&ticket.id));
        Self {
            prefix,
            kind: ticket.kind,
            kind_label: kind_label(ticket.kind),
            amount: ticket.amount,
            unit: ticket.unit.clone(),
            status: ticket.status,
            status_label: status_label(ticket.kind, ticket.status),
            created_at: ticket.created_at,
            expires_at: ticket.expires_at,
        }
    }
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
    // Session-only: the forced-password-change screen renders from this
    // snapshot, so it must stay readable while the change is pending.
    let authed = match require_api_session(&state, &headers).await {
        Ok(authed) => authed,
        Err(r) => return r,
    };

    // With no non-retired unit the generated mint.toml has no payment backend
    // and cdk-mintd cannot start (the supervisor waits) — the mint services
    // being down is the expected state, not an outage.
    let standby = !state
        .config
        .units
        .iter()
        .any(|unit| unit.lifecycle != UnitLifecycle::Retired);

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

    let open_quotes = tickets
        .iter()
        .filter(|t| t.status.is_active())
        .map(ApiOpenQuote::from_ticket)
        .collect();
    let recent_done = tickets
        .iter()
        .filter(|t| !t.status.is_active())
        .take(50)
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
    // Audited supply: requires the keyset listing (unit + expiry per keyset)
    // to classify the audit rows — without it the numbers would be wrong, so
    // report unavailable instead.
    let supply = if keysets.ok {
        match state.supply.read().await {
            Ok(Some(rows)) => ApiSupply {
                available: true,
                error: None,
                units: per_unit_supply(&rows, &keyset_items, now)
                    .into_iter()
                    .map(|unit| ApiUnitSupply {
                        unit: unit.unit,
                        live: unit.live,
                        demonetized: unit.demonetized,
                        fee_collected: unit.fee_collected,
                    })
                    .collect(),
            },
            Ok(None) => ApiSupply {
                available: false,
                error: None,
                units: Vec::new(),
            },
            Err(e) => ApiSupply {
                available: false,
                error: Some(e.to_string()),
                units: Vec::new(),
            },
        }
    } else {
        ApiSupply {
            available: false,
            error: Some("keyset listing unavailable".to_string()),
            units: Vec::new(),
        }
    };

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
            must_change_password: authed.must_change_password,
        },
        users: state.users.list().await,
        demo_password_active: state.users.demo_password_active().await,
        password_min_length: PASSWORD_MIN_LENGTH,
        version: state.version.as_ref().clone(),
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
            mint_http: standby_aware(
                health_item(info_health.as_ref().map(|_| ())),
                standby,
                &state.config.mint_connection,
            ),
            management_rpc: management_rpc_health(
                &state,
                health_item(rpc_health.as_ref().map(|_| ())),
                standby,
            ),
            payment_backend: payment_backend_health(&state, standby),
        },
        keysets,
        active_keyset,
        summary,
        unit_summaries,
        supply,
        circulation: circulation_points(&primary_tickets),
        open_quotes,
        recent_done,
        units,
        capabilities,
        consistency: ApiConsistency {
            ok: consistency_issues.is_empty(),
            issues: consistency_issues,
        },
        mint_connection: api_mint_connection(&state),
    })
    .into_response()
}

fn api_mint_connection(state: &WebState) -> ApiMintConnection {
    use crate::config::MintConnection;
    match &state.config.mint_connection {
        MintConnection::Bundled => ApiMintConnection {
            mode: "bundled",
            http_url: None,
            rpc_url: None,
            advertised_grpc: None,
            supply_audit: true,
            management_rpc: true,
            external_snippet: None,
        },
        MintConnection::Unset => ApiMintConnection {
            mode: "unset",
            http_url: None,
            rpc_url: None,
            advertised_grpc: None,
            supply_audit: false,
            management_rpc: false,
            external_snippet: None,
        },
        MintConnection::External {
            http_url,
            rpc_url,
            advertised_grpc,
        } => ApiMintConnection {
            mode: "external",
            http_url: Some(http_url.clone()),
            rpc_url: rpc_url.clone(),
            advertised_grpc: Some(advertised_grpc.clone()),
            supply_audit: false,
            management_rpc: rpc_url.is_some(),
            external_snippet: crate::config::render_external_mint_snippet(&state.config),
        },
    }
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

/// Honest payment-backend tile: report whether cdk-mintd has actually
/// attached to the gRPC payment stream since this processor started, instead
/// of the unconditional "Listening" it used to claim. The flag never clears
/// on a later mint outage — the mint_http/management_rpc tiles are the live
/// probes for that.
fn payment_backend_health(state: &WebState, standby: bool) -> ApiHealthItem {
    let grpc_endpoint = format!(
        "{}:{}",
        state.config.endpoints.processor_grpc_addr, state.config.endpoints.processor_grpc_port
    );
    if state.backend.payment_stream_attached() {
        ApiHealthItem {
            ok: true,
            label: "Connected".to_string(),
            detail: format!("cdk-mintd is attached to the payment stream ({grpc_endpoint})"),
        }
    } else {
        standby_aware(
            ApiHealthItem {
                ok: false,
                label: "Waiting".to_string(),
                detail: format!(
                    "the mint has not attached to {grpc_endpoint} since the processor started"
                ),
            },
            standby,
            &state.config.mint_connection,
        )
    }
}

/// The management-RPC tile: in external mode without an RPC URL the probe
/// is not failing, the feature is off — say that instead of alarming.
fn management_rpc_health(state: &WebState, item: ApiHealthItem, standby: bool) -> ApiHealthItem {
    use crate::config::MintConnection;
    if let MintConnection::External { rpc_url: None, .. } = &state.config.mint_connection {
        return ApiHealthItem {
            ok: true,
            label: "Not configured".to_string(),
            detail: "No management RPC for the external mint — keyset rotation and \
                     quote-TTL sync are disabled"
                .to_string(),
        };
    }
    standby_aware(item, standby, &state.config.mint_connection)
}

/// Reframe an expected outage as standby instead of an error: zero units on
/// an attached mint, or a processor-only install with nothing connected yet.
fn standby_aware(
    item: ApiHealthItem,
    standby: bool,
    connection: &crate::config::MintConnection,
) -> ApiHealthItem {
    use crate::config::MintConnection;
    if item.ok {
        return item;
    }
    match connection {
        MintConnection::Unset => ApiHealthItem {
            ok: false,
            label: "Not connected".to_string(),
            detail: "No mint is connected yet — choose one in the Mint tab".to_string(),
        },
        MintConnection::External { .. } if standby => ApiHealthItem {
            ok: false,
            label: "Standby".to_string(),
            detail: "Add the first unit, then apply the config snippet to your mint".to_string(),
        },
        MintConnection::Bundled if standby => ApiHealthItem {
            ok: false,
            label: "Standby".to_string(),
            detail: "The mint starts once the first unit is added".to_string(),
        },
        _ => item,
    }
}

impl ApiTicket {
    fn from_ticket(ticket: &Ticket, _state: &WebState) -> Self {
        Self {
            id: ticket.id.clone(),
            short_id: short_id(&ticket.id),
            quote_id: ticket.quote_id.clone(),
            kind: ticket.kind,
            kind_label: kind_label(ticket.kind),
            amount: ticket.amount,
            unit: ticket.unit.clone(),
            status: ticket.status,
            status_label: status_label(ticket.kind, ticket.status),
            created_at: ticket.created_at,
            paid_at: ticket.paid_at,
            expires_at: ticket.expires_at,
            description: ticket.description.clone(),
            notes: ticket.notes.clone(),
        }
    }
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

async fn api_login(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<LoginForm>,
) -> Response {
    let username = form.username.trim().to_ascii_lowercase();
    if !state.users.verify(&username, &form.password).await {
        return api_error(StatusCode::UNAUTHORIZED, "incorrect username or password");
    }
    let sid = uuid::Uuid::new_v4().to_string();
    state.sessions.insert(&sid, &username).await;
    let mut resp = Json(LoginResponse {
        message: "signed_in",
        // Tells the login page to go straight into the set-a-new-password
        // step instead of the console.
        must_change_password: state.users.must_change_password(&username).await,
        password_min_length: PASSWORD_MIN_LENGTH,
    })
    .into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(&sid, request_is_https(&headers))
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
        clear_session_cookie(request_is_https(&headers))
            .parse()
            .unwrap(),
    );
    resp
}

#[derive(Deserialize)]
struct MatchQuoteForm {
    code: String,
}

/// Resolve teller input (last 6+ characters typed from the customer's wallet,
/// or the full quote id from a scanner) to the one open quote it identifies.
/// The full ticket is revealed only here — the open-quote list stays redacted
/// so the code must come from the customer.
async fn api_match_quote(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<MatchQuoteForm>,
) -> Response {
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    let query = match normalize_match_input(&form.code) {
        Ok(query) => query,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };
    match state.branch.match_open(&query).await {
        MatchResult::Ambiguous(n) => api_error(
            StatusCode::CONFLICT,
            format!("{n} open quotes end with this code — type more characters or scan the full id"),
        ),
        MatchResult::None {
            inactive_match: true,
        } => api_error(
            StatusCode::NOT_FOUND,
            "this code matches a quote that is no longer open (settled, voided, or expired)",
        ),
        MatchResult::None {
            inactive_match: false,
        } => api_error(StatusCode::NOT_FOUND, "no open quote matches this code"),
        MatchResult::Unique(ticket) => {
            if ticket.expired(unix_now()) {
                return api_error(
                    StatusCode::NOT_FOUND,
                    "this quote has expired; ask the customer to create a fresh one",
                );
            }
            if let Err(r) = verify_with_mint(&state, &ticket).await {
                return r;
            }
            Json(ApiTicket::from_ticket(&ticket, &state)).into_response()
        }
    }
}

/// Cross-check a matched ticket against the mint's own record before the
/// operator sees a confirm card. Catches orphaned tickets (the mint died
/// before committing the quote), quotes already settled at the mint, and —
/// loudly, at the counter — a mint running without cdk-managed-units.patch.
/// Refuses when the mint is unreachable: confirming cash movements on stale
/// knowledge is worse than asking the customer to wait a moment.
async fn verify_with_mint(state: &WebState, ticket: &Ticket) -> Result<(), Response> {
    let Some(quote_id) = ticket.quote_id.as_deref() else {
        return Err(api_error(
            StatusCode::CONFLICT,
            "this ticket has no mint quote id and cannot be settled",
        ));
    };
    let method = state.method.as_str();
    match ticket.kind {
        TicketKind::Incoming => match state.mint_http.get_mint_quote(method, quote_id).await {
            Err(e) => Err(api_error(
                StatusCode::BAD_GATEWAY,
                format!("cannot verify the quote with the mint right now: {e}"),
            )),
            Ok(None) => Err(api_error(
                StatusCode::CONFLICT,
                "the mint does not know this quote — do not accept cash for it",
            )),
            Ok(Some(quote)) => {
                if quote.amount_paid > 0 || quote.amount_issued > 0 {
                    Err(api_error(
                        StatusCode::CONFLICT,
                        "this quote is already settled at the mint",
                    ))
                } else if quote.request != ticket.id
                    || quote.amount.is_some_and(|amount| amount != ticket.amount)
                    || quote.unit.as_deref().is_some_and(|unit| unit != ticket.unit)
                {
                    Err(api_error(
                        StatusCode::CONFLICT,
                        "the mint's record disagrees with this quote; do not settle it",
                    ))
                } else if quote.pubkey.as_deref().unwrap_or("").is_empty() {
                    // Cannot happen through a patched mint (creation refuses
                    // unlocked quotes) — seeing it means the mint build is wrong.
                    Err(api_error(
                        StatusCode::CONFLICT,
                        "this quote is not locked to a wallet key (NUT-20); do not accept cash for it",
                    ))
                } else {
                    Ok(())
                }
            }
        },
        TicketKind::Outgoing => match state.mint_http.get_melt_quote(method, quote_id).await {
            Err(e) => Err(api_error(
                StatusCode::BAD_GATEWAY,
                format!("cannot verify the quote with the mint right now: {e}"),
            )),
            Ok(None) => Err(api_error(
                StatusCode::CONFLICT,
                "the mint does not know this melt quote — do not pay out",
            )),
            Ok(Some(quote)) => {
                if quote.state.eq_ignore_ascii_case("paid") {
                    Err(api_error(
                        StatusCode::CONFLICT,
                        "this melt is already settled at the mint",
                    ))
                } else if quote.amount != ticket.amount
                    || quote.unit.as_deref().is_some_and(|unit| unit != ticket.unit)
                {
                    Err(api_error(
                        StatusCode::CONFLICT,
                        "the mint's record disagrees with this quote; do not settle it",
                    ))
                } else {
                    Ok(())
                }
            }
        },
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
    /// External mints only: retire even though the mint is unreachable and
    /// the keyset-expiry guard cannot run. The console asks for this
    /// explicitly so an operator is never locked into a dead external mint.
    #[serde(default)]
    force_unverified: bool,
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
    // Funded withdrawals hold locked customer proofs — those must be settled
    // or voided by hand. Open unfunded wallet quotes must NOT block console
    // actions (anyone can create them); they are voided here instead.
    let active = state.branch.active_tickets().await;
    let funded_melts = active
        .iter()
        .filter(|ticket| {
            ticket.unit == unit
                && ticket.kind == TicketKind::Outgoing
                && ticket.status == TicketStatus::Pending
        })
        .count();
    if funded_melts > 0 {
        return api_error(
            StatusCode::CONFLICT,
            format!(
                "{funded_melts} funded withdrawal(s) for {unit} await payout; settle or void them first"
            ),
        );
    }
    for ticket in active.iter().filter(|ticket| ticket.unit == unit) {
        if let Err(e) = state
            .branch
            .mark_failed(&ticket.id, Some("voided: unit lifecycle changed".into()))
            .await
        {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("void open {unit} quotes: {e}"),
            );
        }
    }
    if form.lifecycle == UnitLifecycle::Retired {
        let external = !state.config.mint_connection.is_bundled();
        let keysets = match state.mint_http.list_keysets().await {
            Ok(keysets) => keysets,
            // An unreachable EXTERNAL mint must not hold the config hostage:
            // with the explicit acknowledgement the expiry guard is skipped
            // (the funded-withdrawal guard above already ran). The bundled
            // mint is ours to reach — no override there.
            Err(_) if external && form.force_unverified => {
                tracing::warn!(
                    "retiring {unit} without the keyset-expiry check: the external \
                     mint is unreachable and the operator acknowledged it"
                );
                Vec::new()
            }
            Err(e) if external => {
                return api_error(
                    StatusCode::BAD_GATEWAY,
                    format!(
                        "mint unreachable: could not verify {unit} keyset expiry ({e}); \
                         bring your mint back up, or retire anyway if it is gone for good"
                    ),
                )
            }
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

#[derive(Deserialize)]
struct MintConnectionForm {
    /// "bundled" or "external" — Unset is an install-time state, never a target.
    mode: String,
    #[serde(default)]
    http_url: String,
    #[serde(default)]
    rpc_url: String,
    #[serde(default)]
    advertised_grpc: String,
}

async fn api_set_mint_connection(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(form): Json<MintConnectionForm>,
) -> Response {
    use crate::config::MintConnection;
    if let Err(r) = require_api_auth(&state, &headers).await {
        return r;
    }
    let next = match form.mode.as_str() {
        "bundled" => MintConnection::Bundled,
        "external" => {
            let rpc = form.rpc_url.trim().trim_end_matches('/');
            MintConnection::External {
                http_url: form.http_url.trim().trim_end_matches('/').to_string(),
                rpc_url: (!rpc.is_empty()).then(|| rpc.to_string()),
                advertised_grpc: form.advertised_grpc.trim().trim_end_matches('/').to_string(),
            }
        }
        other => {
            return api_error(
                StatusCode::BAD_REQUEST,
                format!("mode must be \"bundled\" or \"external\", not {other:?}"),
            )
        }
    };
    let mut config = (*state.config).clone();
    if config.mint_connection == next {
        return Json(ApiMessage {
            message: "unchanged",
        })
        .into_response();
    }
    if let Err(e) = config.set_mint_connection(next) {
        return api_error(StatusCode::CONFLICT, e.to_string());
    }
    // Keep setup.json's endpoint record coherent immediately; the restarted
    // process re-derives them anyway (env for bundled, config for external).
    if let MintConnection::External { http_url, rpc_url, .. } = &config.mint_connection {
        config.endpoints.mint_http_url = http_url.clone();
        config.endpoints.mint_rpc_url = rpc_url.clone().unwrap_or_default();
    }
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
    // Session-only: this is the one mutation a forced password change allows —
    // it is how the account gets out of that state.
    let authed = match require_api_session(&state, &headers).await {
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

/// True when the request reached us over HTTPS through the reverse proxy.
/// X-Forwarded-Proto is trusted as-is: the bundled Caddy always sets it, and
/// a client faking the header on a direct HTTP connection only marks its own
/// cookie Secure — its browser then refuses to store it, harming nobody else.
fn request_is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
}

/// SameSite=Lax (Strict would drop the cookie on top-level navigations and
/// bounce operators to /login); no `__Host-` prefix, which would forbid the
/// cookie entirely on plain-HTTP dev/LAN deployments.
fn session_cookie(session_id: &str, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("{COOKIE_NAME}={session_id}; Path=/; HttpOnly; SameSite=Lax{secure_attr}")
}

/// Cookie identity is name+path, so clearing works regardless of the Secure
/// attribute; carrying it keeps strict-secure-cookie browsers happy. The
/// server-side session removal is the real logout.
fn clear_session_cookie(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("{COOKIE_NAME}=deleted; Path=/; Max-Age=0{secure_attr}")
}

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
    let must_change_password = state.users.must_change_password(&username).await;
    Some(Authed {
        session_id,
        username,
        must_change_password,
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

fn status_label(kind: TicketKind, status: TicketStatus) -> &'static str {
    match (kind, status) {
        (_, TicketStatus::Waiting) => "Awaiting wallet",
        (TicketKind::Incoming, TicketStatus::Pending) => "Awaiting cash",
        (TicketKind::Outgoing, TicketStatus::Pending) => "Ready to pay out",
        (_, TicketStatus::Paid) => "Paid",
        (_, TicketStatus::Failed) => "Failed",
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_proto(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", value.parse().unwrap());
        headers
    }

    #[test]
    fn https_detection_follows_the_first_forwarded_proto() {
        assert!(!request_is_https(&HeaderMap::new()));
        assert!(request_is_https(&headers_with_proto("https")));
        assert!(request_is_https(&headers_with_proto("HTTPS")));
        assert!(request_is_https(&headers_with_proto(" https , http")));
        assert!(!request_is_https(&headers_with_proto("http")));
        assert!(!request_is_https(&headers_with_proto("http, https")));
    }

    #[test]
    fn session_cookies_carry_secure_only_over_https() {
        assert_eq!(
            session_cookie("sid-1", false),
            "branch_session=sid-1; Path=/; HttpOnly; SameSite=Lax"
        );
        assert_eq!(
            session_cookie("sid-1", true),
            "branch_session=sid-1; Path=/; HttpOnly; SameSite=Lax; Secure"
        );
        assert_eq!(
            clear_session_cookie(false),
            "branch_session=deleted; Path=/; Max-Age=0"
        );
        assert_eq!(
            clear_session_cookie(true),
            "branch_session=deleted; Path=/; Max-Age=0; Secure"
        );
    }
}
