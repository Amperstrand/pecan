//! Operator web UI for the branch payment backend.
//!
//! Auth: static password. POST /login → cookie session id (kept in process memory,
//! invalidated on restart). All other routes require a valid session cookie.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Form, Path as AxumPath, State};
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
use serde::Deserialize;
use std::convert::Infallible;
use tokio::sync::RwLock;
use tokio_stream::wrappers::BroadcastStream;

use crate::clients::{MintHttpClient, MintRpcClient};
use crate::state::{BranchState, Ticket, TicketKind, TicketStatus};

#[derive(Clone)]
pub struct WebState {
    pub branch: BranchState,
    pub mint_rpc: MintRpcClient,
    pub mint_http: MintHttpClient,
    pub password: Arc<String>,
    pub sessions: Arc<RwLock<HashSet<String>>>,
    pub unit: CurrencyUnit,
    pub method: Arc<String>,
    pub mint_public_url: Arc<String>,
    pub default_amounts: Arc<Vec<u64>>,
}

pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/", get(dashboard))
        .route("/login", get(login_page).post(login_submit))
        .route("/logout", post(logout))
        .route("/quotes", post(create_quote))
        .route("/tickets/{id}/mark-paid", post(mark_paid))
        .route("/tickets/{id}/mark-failed", post(mark_failed))
        .route("/keysets", get(keysets_page))
        .route("/keysets/rotate", post(rotate_keyset))
        // Server-sent events: the dashboard listens here and reloads when state changes.
        .route("/events", get(sse_events))
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
    state.sessions.read().await.contains(&c)
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

// ---------------- pages ----------------

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
        "Dashboard",
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
    if form.password != *state.password {
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
    state.sessions.write().await.insert(sid.clone());
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
    description: String,
}

async fn create_quote(
    State(state): State<WebState>,
    headers: HeaderMap,
    Form(form): Form<CreateQuoteForm>,
) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    if form.amount == 0 {
        return error_response("amount must be greater than zero");
    }
    if !state.branch.active_tickets().await.is_empty() {
        return error_response("finish the active quote before creating another");
    }

    let description = match form.description.trim() {
        "" => None,
        s => Some(s.to_string()),
    };

    let result = match form.kind.as_str() {
        "mint" => {
            let quote = match state
                .mint_http
                .create_mint_quote(state.method.as_str(), form.amount, &state.unit, description)
                .await
            {
                Ok(quote) => quote,
                Err(e) => return error_response(&format!("create mint quote: {e}")),
            };
            state
                .branch
                .attach_quote_id(&quote.request, quote.quote)
                .await
        }
        "melt" => {
            let quote = match state
                .mint_http
                .create_melt_quote(state.method.as_str(), form.amount, &state.unit)
                .await
            {
                Ok(quote) => quote,
                Err(e) => return error_response(&format!("create melt quote: {e}")),
            };
            let ticket_id = format!("MELT-{}", quote.quote);
            state.branch.attach_quote_id(&ticket_id, quote.quote).await
        }
        other => return error_response(&format!("unknown quote flow: {other}")),
    };

    if let Err(e) = result {
        return error_response(&format!("store quote id: {e}"));
    }

    Redirect::to("/").into_response()
}

#[derive(Deserialize)]
struct NotesForm {
    #[serde(default)]
    notes: String,
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
    let notes = if form.notes.trim().is_empty() {
        None
    } else {
        Some(form.notes)
    };
    if let Err(e) = state.branch.mark_paid(&id, notes).await {
        return error_response(&format!("mark_paid: {e}"));
    }
    Redirect::to("/").into_response()
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
    let notes = if form.notes.trim().is_empty() {
        None
    } else {
        Some(form.notes)
    };
    if let Err(e) = state.branch.mark_failed(&id, notes).await {
        return error_response(&format!("mark_failed: {e}"));
    }
    Redirect::to("/").into_response()
}

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

async fn rotate_keyset(
    State(state): State<WebState>,
    headers: HeaderMap,
    Form(form): Form<RotateForm>,
) -> Response {
    if let Err(r) = require_auth(&state, &headers).await {
        return r;
    }
    let amounts: Result<Vec<u64>, _> = form
        .amounts
        .split(',')
        .map(|s| s.trim().parse::<u64>())
        .collect();
    let amounts = match amounts {
        Ok(v) => v,
        Err(e) => return error_response(&format!("amounts: {e}")),
    };
    if let Err(e) = state
        .mint_rpc
        .rotate_next_keyset(form.unit, amounts, form.input_fee_ppk, form.final_expiry)
        .await
    {
        return error_response(&format!("rotate: {e}"));
    }
    Redirect::to("/keysets").into_response()
}

// ---------------- helpers ----------------

fn active_quote_panel(ticket: &Ticket, now: u64, state: &WebState) -> Markup {
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
    let quote_url = quote_status_url(ticket, state);

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

fn quote_status_url(ticket: &Ticket, state: &WebState) -> Option<String> {
    let quote_id = ticket.quote_id.as_ref()?;
    let quote_kind = match ticket.kind {
        TicketKind::Incoming => "mint",
        TicketKind::Outgoing => "melt",
    };
    Some(format!(
        "{}/v1/{}/quote/{}/{}",
        state.mint_public_url.trim_end_matches('/'),
        quote_kind,
        state.method.as_str(),
        quote_id
    ))
}

fn qr_code_markup(data: &str) -> Markup {
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
            html! { div.qr-frame { (PreEscaped(image)) } }
        }
        Err(e) => html! { div.alert.alert-error { "QR error: " (e) } },
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
                            a href="/" { "Dashboard" }
                            a href="/keysets" { "Keysets" }
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
select {
  font: inherit; font-size: 14px;
  padding: 9px 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--fg);
  width: 100%;
}
input::placeholder { color: var(--fg-subtle); }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
input[readonly] { background: var(--surface-2); color: var(--fg-muted); }

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

fn status_pill(s: TicketStatus) -> Markup {
    let (cls, label) = match s {
        TicketStatus::Waiting => ("pill pill-waiting", "Waiting"),
        TicketStatus::Pending => ("pill pill-pending", "Pending"),
        TicketStatus::Paid => ("pill pill-paid", "Paid"),
        TicketStatus::Failed => ("pill pill-failed", "Failed"),
    };
    html! { span class=(cls) { (label) } }
}

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
