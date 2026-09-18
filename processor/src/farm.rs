//! The `farm` rail: physical egg futures (NUT-32 draft spike).
//!
//! Sarah's purchase is a durable cross-unit/resource saga — real signet
//! sats in, scarce dated bearer futures out:
//!
//! ```text
//! quote 5 eggs → reserve 5 of 10 capacity → bolt11 5000 sat (raw, no FX)
//!   → payment confirmed on CLN → purchase PAID → wallet creates a
//!   NUT-20-locked `future` mint quote referencing the purchase →
//!   processor validates + links it (AUTHORIZED) → wallet mints 5 units
//!   → quote state ISSUED at the mint → MINTED, capacity accounting final.
//! ```
//!
//! Redemptions ride the existing teller melt machinery: a `future`-method
//! melt quote becomes a ticket the operator matches, hands eggs over for,
//! and settles — proofs burn at the mint, a FARM receipt comes back, and
//! the series' redeemed count follows the ticket store (the authoritative
//! record of the burn).
//!
//! Ownership is never recorded: the state here is aggregate series
//! accounting plus in-flight purchases (a purchase pubkey is a per-quote
//! NUT-20 lock key, not an identity). After issuance, who holds what lives
//! exclusively in bearer proofs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};

use crate::clients::MintHttpClient;
use crate::ln::ClnClient;

/// Invoice lifetime on the node; matches the fiat pairs' quote TTL.
const INVOICE_EXPIRY_SECS: u64 = 1800;
const PAYMENT_POLL_INTERVAL_SECS: u64 = 3;
const BOOTSTRAP_INTERVAL_SECS: u64 = 600;
const MINTED_POLL_INTERVAL_SECS: u64 = 5;

#[derive(Debug, Clone)]
pub struct FarmConfig {
    pub price_sats: u64,
    pub capacity: u64,
    pub horizon_days: u64,
    /// Public base for terms blobs + oracle (…/farm-console).
    pub public_base_url: String,
    /// The mint as wallets address it — the terms' `mint` field.
    pub mint_public_url: String,
    /// mintd admin surface (…:8100) with the NUT-32 fork routes.
    pub mintd_admin_url: String,
    pub mintd_admin_token: String,
    /// Hour embedded in the unit string (NUT-32 grammar requires one).
    /// Purely structural: delivery is best-effort with no promised
    /// times — nothing in the rails or the terms schedules on it.
    pub maturity_hour_utc: u32,
    pub base: String,
    pub quote: String,
    pub commodity: String,
    pub producer: String,
}

impl FarmConfig {
    pub fn from_env() -> Option<Self> {
        let on = std::env::var("CDK_BRANCH_PROCESSOR_FARM")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        if !on {
            return None;
        }
        let num = |k: &str, d: u64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(d)
        };
        Some(Self {
            price_sats: num("CDK_BRANCH_PROCESSOR_FARM_PRICE_SATS", 1000),
            capacity: num("CDK_BRANCH_PROCESSOR_FARM_CAPACITY", 10),
            horizon_days: num("CDK_BRANCH_PROCESSOR_FARM_HORIZON_DAYS", 7),
            public_base_url: std::env::var("CDK_BRANCH_PROCESSOR_FARM_PUBLIC_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:9091".into()),
            mint_public_url: std::env::var("CDK_BRANCH_PROCESSOR_FARM_MINT_PUBLIC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8100".into()),
            mintd_admin_url: std::env::var("CDK_BRANCH_PROCESSOR_FARM_MINTD_ADMIN_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8100".into()),
            mintd_admin_token: std::env::var("CDK_BRANCH_PROCESSOR_FARM_MINTD_ADMIN_TOKEN")
                .unwrap_or_default(),
            maturity_hour_utc: num("CDK_BRANCH_PROCESSOR_FARM_MATURITY_HOUR_UTC", 6) as u32,
            base: "farm".into(),
            quote: "egg".into(),
            commodity: "egg".into(),
            producer: "farm".into(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseState {
    /// Reserved + invoiced, waiting for signet payment.
    Open,
    /// Payment confirmed on signet; issuance on wallet claim.
    Paid,
    /// A NUT-20-locked `future` mint quote is linked; the wallet may mint.
    Authorized,
    /// The linked quote reports issuance — capacity accounting final.
    Minted,
    Expired,
    Failed,
}

impl PurchaseState {
    fn reserves_capacity(self) -> bool {
        matches!(
            self,
            PurchaseState::Open | PurchaseState::Paid | PurchaseState::Authorized
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermsRecord {
    pub uri: String,
    pub sha256: String,
    /// The exact signed envelope bytes (canonical JSON), content-addressed
    /// by `sha256` and served verbatim at `uri`.
    pub blob: String,
    pub signature: String,
    pub mint_pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FarmSeries {
    pub date: String,
    pub unit: String,
    pub maturity: u64,
    pub capacity: u64,
    pub price_sats: u64,
    pub issued: u64,
    /// Redeemed count is RE-DERIVED from the teller ticket store (the
    /// authoritative burn record); this cached copy refreshes on boot and
    /// on every settle.
    pub redeemed: u64,
    /// `None` = expected production; `Some(n < capacity)` simulates a
    /// shortfall (remaining claims are explicitly defaulted, never
    /// silently settled).
    pub actual_production: Option<u64>,
    pub terms: TermsRecord,
    /// Admin/test-only override flagging the series as collectable
    /// (informational only — nothing gates on it anymore).
    #[serde(default)]
    pub matured_override: bool,
}

impl FarmSeries {
    pub fn available(&self, reserved: u64) -> u64 {
        self.capacity
            .saturating_sub(self.issued)
            .saturating_sub(reserved)
    }

    pub fn redeemable_cap(&self) -> u64 {
        self.actual_production.unwrap_or(self.capacity)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FarmPurchase {
    pub id: String,
    pub series_date: String,
    pub unit: String,
    pub quantity: u64,
    pub price_per_egg_sats: u64,
    pub total_sats: u64,
    /// Per-purchase NUT-20 lock key (compressed hex) — the only wallet
    /// binding, and not an identity.
    pub pubkey: String,
    pub state: PurchaseState,
    pub bolt11: String,
    pub payment_hash: String,
    pub invoice_expires_at: u64,
    pub created_at: u64,
    #[serde(default)]
    pub paid_at: Option<u64>,
    #[serde(default)]
    pub quote_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct FarmFile {
    #[serde(default)]
    series: BTreeMap<String, FarmSeries>,
    #[serde(default)]
    purchases: BTreeMap<String, FarmPurchase>,
}

/// Shared farm state: one JSON file, single-writer RwLock — the same
/// transactional pattern as the ticket store. Reservation checks and
/// inserts happen under one write guard, so concurrent purchases cannot
/// over-reserve capacity.
#[derive(Clone)]
pub struct FarmState {
    inner: Arc<FarmInner>,
}

struct FarmInner {
    state: RwLock<FarmFile>,
    path: PathBuf,
    terms_dir: PathBuf,
    config: FarmConfig,
}

impl FarmState {
    pub async fn load(work_dir: &Path, config: FarmConfig) -> Result<Self> {
        tokio::fs::create_dir_all(work_dir).await.ok();
        let path = work_dir.join("farm.json");
        let terms_dir = work_dir.join("terms");
        tokio::fs::create_dir_all(&terms_dir).await?;
        let state = if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            serde_json::from_slice(
                &tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("read {}", path.display()))?,
            )
            .with_context(|| format!("parse {}", path.display()))?
        } else {
            FarmFile::default()
        };
        Ok(Self {
            inner: Arc::new(FarmInner {
                state: RwLock::new(state),
                path,
                terms_dir,
                config,
            }),
        })
    }

    pub fn config(&self) -> &FarmConfig {
        &self.inner.config
    }

    async fn persist(&self) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let snapshot: FarmFile = (*self.inner.state.read().await).clone();
        let bytes = serde_json::to_vec_pretty(&snapshot)?;
        let tmp = self.inner.path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await?;
        tokio::fs::rename(&tmp, &self.inner.path).await?;
        Ok(())
    }

    fn reserved_of(file: &FarmFile, series_date: &str) -> u64 {
        file.purchases
            .values()
            .filter(|p| p.series_date == series_date && p.state.reserves_capacity())
            .map(|p| p.quantity)
            .sum()
    }

    pub async fn series_snapshot(&self) -> Vec<FarmSeries> {
        self.inner.state.read().await.series.values().cloned().collect()
    }

    pub async fn series_for_date(&self, date: &str) -> Option<FarmSeries> {
        self.inner.state.read().await.series.get(date).cloned()
    }

    pub async fn purchase(&self, id: &str) -> Option<FarmPurchase> {
        self.inner.state.read().await.purchases.get(id).cloned()
    }

    pub async fn purchases(&self) -> Vec<FarmPurchase> {
        self.inner.state.read().await.purchases.values().cloned().collect()
    }

    fn unit_for_date(config: &FarmConfig, date: &str) -> String {
        // Lowercase whole: Cashu unit identifiers lowercase by established
        // practice (cdk normalizes custom units) — the NUT-32 draft is
        // aligned with it.
        format!(
            "future:{}-{}:{}t{:02}0000z",
            config.base, config.quote, date.replace('-', ""),
            config.maturity_hour_utc
        )
    }

    /// Atomically reserve capacity and record the purchase. The invoice
    /// must already exist (created outside the lock); a failed reservation
    /// leaves the invoice to expire on the node.
    pub async fn insert_purchase(
        &self,
        purchase_id: &str,
        series_date: &str,
        quantity: u64,
        pubkey: &str,
        bolt11: String,
        payment_hash: String,
    ) -> Result<FarmPurchase> {
        if quantity == 0 {
            bail!("quantity must be greater than zero");
        }
        let mut guard = self.inner.state.write().await;
        let now = unix_now();
        let series = guard
            .series
            .get(series_date)
            .ok_or_else(|| anyhow!("no farm series for {series_date}"))?
            .clone();
        // Egg-vending semantics: the day's eggs sell for the WHOLE
        // production day (same-day purchase is the demo path), not only
        // until the collection hour. Sales close at the day's UTC
        // midnight; matured_override (a collectability flag) must not
        // close issuance.
        if now >= maturity_unix(series_date, 24)? {
            bail!("sales closed: the {series_date} production day has ended");
        }
        let reserved = Self::reserved_of(&guard, series_date);
        if series.issued + reserved + quantity > series.capacity {
            bail!(
                "capacity: {} of {} eggs remain for {}",
                series.available(reserved),
                series.capacity,
                series_date
            );
        }
        let purchase = FarmPurchase {
            id: purchase_id.to_string(),
            series_date: series_date.to_string(),
            unit: series.unit.clone(),
            quantity,
            price_per_egg_sats: series.price_sats,
            total_sats: series.price_sats * quantity,
            pubkey: pubkey.to_string(),
            state: PurchaseState::Open,
            bolt11,
            payment_hash,
            invoice_expires_at: now + INVOICE_EXPIRY_SECS,
            created_at: now,
            paid_at: None,
            quote_id: None,
            error: None,
        };
        guard
            .purchases
            .insert(purchase.id.clone(), purchase.clone());
        drop(guard);
        self.persist().await?;
        Ok(purchase)
    }

    /// CLN observed the invoice settled. At-most-once: only an
    /// `Open → Paid` transition lands; replays are no-ops.
    pub async fn mark_purchase_paid(&self, id: &str) -> Result<FarmPurchase> {
        let mut guard = self.inner.state.write().await;
        let purchase = guard
            .purchases
            .get_mut(id)
            .ok_or_else(|| anyhow!("unknown purchase {id}"))?;
        match purchase.state {
            PurchaseState::Open => {
                purchase.state = PurchaseState::Paid;
                purchase.paid_at = Some(unix_now());
            }
            _ => return Ok(purchase.clone()),
        }
        let updated = purchase.clone();
        drop(guard);
        self.persist().await?;
        tracing::info!("farm purchase {id} paid ({} sat)", updated.total_sats);
        Ok(updated)
    }

    /// The wallet showed up with a NUT-20-locked `future` mint quote that
    /// references this purchase. One quote per purchase, ever; unit,
    /// amount, and lock key must match the purchase exactly.
    pub async fn authorize_issuance(
        &self,
        purchase_id: &str,
        quote_id: &str,
        unit: &str,
        amount: u64,
        pubkey: &str,
    ) -> Result<FarmPurchase> {
        let mut guard = self.inner.state.write().await;
        let purchase = guard
            .purchases
            .get_mut(purchase_id)
            .ok_or_else(|| anyhow!("unknown purchase {purchase_id}"))?;
        if let Some(existing) = &purchase.quote_id {
            if existing == quote_id {
                return Ok(purchase.clone());
            }
            bail!(
                "purchase {purchase_id} already has mint quote {existing}; \
                 one payment cannot mint twice"
            );
        }
        if purchase.state != PurchaseState::Paid {
            bail!(
                "purchase {purchase_id} is {:?}; issuance needs a paid purchase",
                purchase.state
            );
        }
        if purchase.unit != unit {
            bail!(
                "quote unit {unit} does not match purchase unit {}",
                purchase.unit
            );
        }
        if purchase.quantity != amount {
            bail!(
                "quote amount {amount} does not match purchased quantity {}",
                purchase.quantity
            );
        }
        if !pubkey_eq(&purchase.pubkey, pubkey) {
            bail!("quote is not locked to the purchase's wallet key");
        }
        purchase.state = PurchaseState::Authorized;
        purchase.quote_id = Some(quote_id.to_string());
        let updated = purchase.clone();
        drop(guard);
        self.persist().await?;
        tracing::info!("farm purchase {purchase_id} authorized quote {quote_id}");
        Ok(updated)
    }

    /// The mint reports the linked quote as issued — the issuance is real.
    pub async fn mark_purchase_minted(&self, quote_id: &str) -> Result<()> {
        let mut guard = self.inner.state.write().await;
        let Some(purchase) = guard
            .purchases
            .values_mut()
            .find(|p| p.quote_id.as_deref() == Some(quote_id))
        else {
            return Ok(());
        };
        if purchase.state != PurchaseState::Authorized {
            return Ok(());
        }
        purchase.state = PurchaseState::Minted;
        let (date, qty) = (purchase.series_date.clone(), purchase.quantity);
        drop(guard);
        if let Some(series) = self.inner.state.write().await.series.get_mut(&date) {
            series.issued += qty;
        }
        self.persist().await?;
        tracing::info!("farm series {date}: {qty} future units minted");
        Ok(())
    }

    /// Claim window: a PAID purchase the wallet never converted into a
    /// mint quote releases its capacity after this long (the mint keeps
    /// the sats; a real deployment would need a refund rail — non-goal).
    const CLAIM_WINDOW_SECS: u64 = 86_400;

    /// Expire unpaid purchases past their invoice TTL, and paid-but-never-
    /// claimed purchases past the claim window — releasing their
    /// reservations. Returns the number expired.
    pub async fn sweep_expired(&self) -> usize {
        let now = unix_now();
        let mut guard = self.inner.state.write().await;
        let expired: Vec<String> = guard
            .purchases
            .values()
            .filter(|p| match p.state {
                PurchaseState::Open => now > p.invoice_expires_at,
                PurchaseState::Paid => now > p.invoice_expires_at + Self::CLAIM_WINDOW_SECS,
                _ => false,
            })
            .map(|p| p.id.clone())
            .collect();
        for id in &expired {
            if let Some(p) = guard.purchases.get_mut(id) {
                p.state = PurchaseState::Expired;
                if p.quote_id.is_none() {
                    p.error = Some("claim window closed".into());
                }
            }
        }
        drop(guard);
        if !expired.is_empty() {
            if let Err(e) = self.persist().await {
                tracing::error!("persist after farm sweep: {e}");
            }
            tracing::info!("farm expired {} unpaid purchase(s)", expired.len());
        }
        expired.len()
    }

    /// Redemption accounting follows the teller ticket store: every Paid
    /// outgoing ticket in a future unit is a completed burn. Recount on
    /// boot and after each settle — the visible-ambiguity rule for the
    /// physical handoff (a crash between ticket-settle and this recount
    /// self-heals on the next pass).
    pub async fn recount_redeemed(&self, paid_future_tickets: &[(String, u64)]) {
        let mut guard = self.inner.state.write().await;
        let mut by_date: BTreeMap<String, u64> = BTreeMap::new();
        for (unit, amount) in paid_future_tickets {
            if let Some(series) = guard.series.values().find(|s| &s.unit == unit) {
                *by_date.entry(series.date.clone()).or_insert(0) += amount;
            }
        }
        let mut changed = false;
        for (date, redeemed) in by_date {
            if let Some(series) = guard.series.get_mut(&date) {
                if series.redeemed != redeemed {
                    series.redeemed = redeemed;
                    changed = true;
                }
            }
        }
        drop(guard);
        if changed {
            if let Err(e) = self.persist().await {
                tracing::error!("persist after redeemed recount: {e}");
            }
        }
    }

    /// Settle-time gate for a redemption. Two enforced invariants: the
    /// DAY window — claims are collectable 24/7 on, and only on, their
    /// production date (claim-it-or-lose-it; a date's eggs neither
    /// redeem early nor after the day ends) — and actual production
    /// (shortfall claims are explicitly refused, never silently
    /// settled). No hour within the day is enforced.
    pub async fn redemption_gate(&self, unit: &str, quantity: u64) -> Result<FarmSeries> {
        let series = {
            let guard = self.inner.state.read().await;
            guard
                .series
                .values()
                .find(|s| s.unit == unit)
                .ok_or_else(|| anyhow!("unknown future series {unit}"))?
                .clone()
        };
        let now = unix_now();
        if now < maturity_unix(&series.date, 0)? {
            bail!(
                "claim-it-or-lose-it: {unit} redeems only on {} — come back on the day",
                series.date
            );
        }
        if now >= maturity_unix(&series.date, 24)? {
            bail!(
                "claim-it-or-lose-it: {} eggs could only be redeemed on {}; the claim is lost",
                series.date,
                series.date
            );
        }
        if series.redeemed + quantity > series.redeemable_cap() {
            bail!(
                "issuer default: {} claim(s) exceed actual production {} \
                 (redeemed {}); terms shortfall_policy=issuer-default",
                quantity,
                series.redeemable_cap(),
                series.redeemed
            );
        }
        Ok(series)
    }

    pub async fn set_actual_production(&self, date: &str, actual: Option<u64>) -> Result<()> {
        let mut guard = self.inner.state.write().await;
        let series = guard
            .series
            .get_mut(date)
            .ok_or_else(|| anyhow!("no series {date}"))?;
        if let Some(actual) = actual {
            if actual > series.capacity {
                bail!("actual production {actual} exceeds capacity {}", series.capacity);
            }
        }
        series.actual_production = actual;
        drop(guard);
        self.persist().await
    }

    /// Test/demo-only: treat the series as matured from now on.
    pub async fn set_matured_override(&self, date: &str, on: bool) -> Result<()> {
        let mut guard = self.inner.state.write().await;
        let series = guard
            .series
            .get_mut(date)
            .ok_or_else(|| anyhow!("no series {date}"))?;
        series.matured_override = on;
        drop(guard);
        self.persist().await
    }

    /// Create (or idempotently re-affirm) one day's series with signed,
    /// content-addressed terms; register it with the mintd NUT-32 fork.
    pub async fn ensure_series(&self, date: &str) -> Result<FarmSeries> {
        {
            let guard = self.inner.state.read().await;
            if let Some(series) = guard.series.get(date) {
                return Ok(series.clone());
            }
        }
        let config = &self.inner.config;
        let unit = Self::unit_for_date(config, date);
        let capacity = config.capacity;
        let price = config.price_sats;
        let terms = serde_json::json!({
            "unit": unit,
            "contract_size": "1",
            "commodity": config.commodity,
            "producer": config.producer,
            "production_date": date,
            "production_capacity": capacity.to_string(),
            "oracle": format!("{}/api/farm/{}", config.public_base_url.trim_end_matches('/'), date),
            "settlement_method": "physical",
            "settlement_unit": config.commodity,
            "purchase_currency": "signet-sat",
            "reference_price_sats": price.to_string(),
            "shortfall_policy": "issuer-default",
            "collection": "claims are collectable 24/7 during their \
                production date (UTC) — claim-it-or-lose-it: unclaimed \
                eggs expire when the date ends",
            "delivery": "best-effort — imaginary eggs are delivered on a \
                best-effort basis; what actually happened at handover is \
                recorded on the redemption ticket (delivered, condition) \
                for later analysis"
        });
        let mint_admin = MintAdminClient::new(
            config.mintd_admin_url.clone(),
            config.mintd_admin_token.clone(),
        );
        let signed = mint_admin
            .sign_terms(&config.mint_public_url, &terms)
            .await
            .context("mintd terms signing")?;
        let envelope = canonical_envelope(&config.mint_public_url, &signed.signature, &terms);
        let sha256 = sha256_hex(envelope.as_bytes());
        let digest_uri = format!(
            "{}/terms/{}",
            config.public_base_url.trim_end_matches('/'),
            sha256
        );
        let blob_path = self.inner.terms_dir.join(&sha256);
        if tokio::fs::try_exists(&blob_path).await.unwrap_or(false) {
            let existing = tokio::fs::read_to_string(&blob_path).await.unwrap_or_default();
            if existing != envelope {
                bail!("terms collision: {sha256} already addresses different bytes");
            }
        } else {
            let tmp = blob_path.with_extension("tmp");
            tokio::fs::write(&tmp, &envelope).await?;
            tokio::fs::rename(&tmp, &blob_path).await?;
        }
        mint_admin
            .register_series(&unit, &sha256)
            .await
            .context("mintd series registration")?;
        let maturity = maturity_unix(date, config.maturity_hour_utc)?;
        let series = FarmSeries {
            date: date.to_string(),
            unit,
            maturity,
            capacity,
            price_sats: price,
            issued: 0,
            redeemed: 0,
            actual_production: None,
            terms: TermsRecord {
                uri: digest_uri,
                sha256: sha256,
                blob: envelope,
                signature: signed.signature,
                mint_pubkey: signed.pubkey,
            },
            matured_override: false,
        };
        let mut guard = self.inner.state.write().await;
        guard.series.insert(date.to_string(), series.clone());
        drop(guard);
        self.persist().await?;
        tracing::info!("farm series {date} live: {} (capacity {capacity})", series.unit);
        Ok(series)
    }

    /// Serve an immutable terms blob by digest.
    pub async fn terms_blob(&self, sha256: &str) -> Option<String> {
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        tokio::fs::read_to_string(self.inner.terms_dir.join(sha256))
            .await
            .ok()
    }
}

pub struct FarmRail {
    pub state: FarmState,
    cln: Arc<ClnClient>,
    mint: MintHttpClient,
    events: broadcast::Sender<cdk_common::payment::Event>,
}

impl FarmRail {
    pub fn start(
        state: FarmState,
        cln: Arc<ClnClient>,
        mint_url: String,
        events: broadcast::Sender<cdk_common::payment::Event>,
    ) -> Arc<Self> {
        let rail = Arc::new(Self {
            state,
            cln,
            mint: MintHttpClient::new(mint_url),
            events,
        });
        rail.spawn_bootstrap();
        rail.spawn_payment_poller();
        rail.spawn_minted_poller();
        rail.spawn_sweeper();
        rail
    }

    fn spawn_bootstrap(&self) {
        let state = self.state.clone();
        tokio::spawn(async move {
            // Boot-order chicken-and-egg: mintd waits for this processor's
            // gRPC before serving HTTP, while series registration needs
            // mintd's admin routes — so failures retry fast (the mint is
            // probably mid-boot) until one pass succeeds, then relax to
            // the horizon-refresh cadence.
            let mut healthy = false;
            loop {
                let mut pass_ok = true;
                for date in upcoming_dates(state.config().horizon_days) {
                    if let Err(e) = state.ensure_series(&date).await {
                        tracing::warn!("farm series bootstrap {date}: {e:#}");
                        pass_ok = false;
                    }
                }
                healthy = healthy || pass_ok;
                let wait = if healthy {
                    BOOTSTRAP_INTERVAL_SECS
                } else {
                    15
                };
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            }
        });
    }

    fn spawn_payment_poller(&self) {
        let state = self.state.clone();
        let cln = self.cln.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(
                PAYMENT_POLL_INTERVAL_SECS,
            ));
            loop {
                tick.tick().await;
                let open: Vec<String> = state
                    .purchases()
                    .await
                    .into_iter()
                    .filter(|p| p.state == PurchaseState::Open)
                    .map(|p| p.id)
                    .collect();
                for id in open {
                    #[derive(serde::Deserialize)]
                    struct ListInvoicesResult {
                        #[serde(default)]
                        invoices: Vec<serde_json::Value>,
                    }
                    let Ok(list) = cln
                        .call::<ListInvoicesResult>(
                            "listinvoices",
                            serde_json::json!({"label": id}),
                        )
                        .await
                    else {
                        continue;
                    };
                    let paid = list
                        .invoices
                        .first()
                        .and_then(|i| i.get("status"))
                        .and_then(|s| s.as_str())
                        .map(|s| s == "paid")
                        .unwrap_or(false);
                    if paid {
                        if let Err(e) = state.mark_purchase_paid(&id).await {
                            tracing::error!("farm purchase {id} paid-mark failed: {e:#}");
                        }
                    }
                }
            }
        });
    }

    fn spawn_minted_poller(&self) {
        let state = self.state.clone();
        let mint = self.mint.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::Duration::from_secs(MINTED_POLL_INTERVAL_SECS);
            loop {
                tokio::time::sleep(tick).await;
                tick = std::time::Duration::from_secs(MINTED_POLL_INTERVAL_SECS);
                let pending: Vec<String> = state
                    .purchases()
                    .await
                    .into_iter()
                    .filter(|p| p.state == PurchaseState::Authorized)
                    .filter_map(|p| p.quote_id)
                    .collect();
                for quote_id in pending {
                    match mint.get_mint_quote("future", &quote_id).await {
                        Ok(Some(snapshot)) if snapshot.amount_issued > 0 => {
                            if let Err(e) = state.mark_purchase_minted(&quote_id).await {
                                tracing::error!("farm minted-mark {quote_id}: {e:#}");
                            }
                        }
                        Ok(_) => {}
                        Err(e) => tracing::debug!("farm minted poll {quote_id}: {e:#}"),
                    }
                }
            }
        });
    }

    fn spawn_sweeper(&self) {
        let state = self.state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                state.sweep_expired().await;
            }
        });
    }

    /// A raw-sat invoice for a purchase (no FX — the farm prices in sats).
    pub async fn create_invoice(&self, purchase_id: &str, total_sats: u64, description: &str) -> Result<(String, String)> {
        #[derive(serde::Deserialize)]
        struct InvoiceResult {
            bolt11: String,
            payment_hash: String,
        }
        let invoice: InvoiceResult = self
            .cln
            .call(
                "invoice",
                serde_json::json!({
                    "amount_msat": total_sats * 1000,
                    "label": purchase_id,
                    "description": description,
                    "expiry": INVOICE_EXPIRY_SECS,
                }),
            )
            .await
            .map_err(|e| anyhow!("cln invoice: {e}"))?;
        Ok((invoice.bolt11, invoice.payment_hash))
    }

    /// Announce a linked, authorized quote as PAID to the mint (the signet
    /// payment settled before the quote existed — this closes the loop).
    /// The event only lands if the mint has already COMMITTED its quote
    /// row, which happens right after create returns — so the first send
    /// is delayed briefly and retried; mint-side handling is idempotent.
    pub fn emit_payment_received(&self, quote_id: &str, purchase: &FarmPurchase) {
        let events = self.events.clone();
        let quote_id = quote_id.to_string();
        let payment_id = purchase.id.clone();
        let amount = cdk_common::Amount::new(
            purchase.quantity,
            cdk_common::CurrencyUnit::Custom(purchase.unit.as_str().into()),
        );
        tokio::spawn(async move {
            for delay_ms in [300_u64, 1_500, 4_000] {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                let _ = events.send(cdk_common::payment::Event::PaymentReceived(
                    cdk_common::payment::WaitPaymentResponse {
                        payment_identifier: cdk_common::payment::PaymentIdentifier::CustomId(
                            quote_id.clone(),
                        ),
                        payment_amount: amount.clone(),
                        payment_id: payment_id.clone(),
                    },
                ));
            }
        });
    }

    /// check_incoming_payment_status for linked future quotes. The
    /// payment id MUST equal the event path's (the purchase id) — the
    /// mint dedupes credits by it, so a second id would double-count the
    /// paid amount.
    pub async fn paid_quote(&self, quote_id: &str) -> Option<(u64, String, String)> {
        let purchase = self
            .state
            .purchases()
            .await
            .into_iter()
            .find(|p| p.quote_id.as_deref() == Some(quote_id))?;
        matches!(purchase.state, PurchaseState::Authorized | PurchaseState::Minted)
            .then_some((purchase.quantity, purchase.unit, purchase.id))
    }
}

#[derive(Deserialize)]
struct SignTermsResponse {
    signature: String,
    pubkey: String,
}

struct MintAdminClient {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl MintAdminClient {
    fn new(base: String, token: String) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    async fn sign_terms(
        &self,
        mint_url: &str,
        terms: &serde_json::Value,
    ) -> Result<SignTermsResponse> {
        let url = format!("{}/nut32/admin/sign-terms", self.base);
        let r = self
            .http
            .post(&url)
            .header("x-nut32-token", &self.token)
            .json(&serde_json::json!({"mint": mint_url, "terms": terms}))
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !r.status().is_success() {
            bail!("sign-terms: HTTP {} — {}", r.status(), r.text().await.unwrap_or_default());
        }
        Ok(r.json().await?)
    }

    async fn register_series(&self, unit: &str, terms_sha256: &str) -> Result<()> {
        let url = format!("{}/nut32/admin/series", self.base);
        let r = self
            .http
            .post(&url)
            .header("x-nut32-token", &self.token)
            .json(&serde_json::json!({"unit": unit, "terms_sha256": terms_sha256}))
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !r.status().is_success() {
            bail!(
                "register series {unit}: HTTP {} — {}",
                r.status(),
                r.text().await.unwrap_or_default()
            );
        }
        Ok(())
    }
}

/// Canonical, key-sorted, whitespace-free serialization of the signed
/// envelope (mirrors the cdk fork's canonical_json; string scalars only).
pub fn canonical_envelope(mint: &str, signature: &str, terms: &serde_json::Value) -> String {
    fn walk(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::Object(map) => {
                out.push('{');
                for (i, (k, val)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    walk(val, out);
                }
                out.push('}');
            }
            serde_json::Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    walk(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
        }
    }
    let envelope = serde_json::json!({
        "mint": mint,
        "signature": signature,
        "terms": terms,
    });
    let mut out = String::new();
    walk(&envelope, &mut out);
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use bitcoin_hashes::{sha256, Hash};
    sha256::Hash::hash(bytes).to_string()
}

fn pubkey_eq(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn hex_random(n: usize) -> String {
    use rand::Rng;
    (0..n)
        .map(|_| format!("{:02x}", rand::thread_rng().gen::<u8>()))
        .collect()
}

/// ISO date (UTC) `days` ahead of today, `0` = today.
pub fn date_offset(days: u64) -> String {
    let now = unix_now() + days * 86_400;
    let (y, m, d) = civil_from_unix(now);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn upcoming_dates(horizon_days: u64) -> Vec<String> {
    (0..horizon_days).map(date_offset).collect()
}

/// Resolve "next-friday" (or an explicit YYYY-MM-DD) against UTC.
pub fn resolve_production_date(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if !trimmed.eq_ignore_ascii_case("next-friday") {
        validate_date(trimmed)?;
        return Ok(trimmed.to_string());
    }
    // Days until the next Friday strictly ahead of today.
    let today = unix_now();
    let (.., weekday) = weekday_from_unix(today);
    let ahead = (5 - weekday + 7) % 7;
    let ahead = if ahead == 0 { 7 } else { ahead };
    Ok(date_offset(ahead as u64))
}

fn civil_from_unix(secs: u64) -> (i64, u32, u32) {
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

fn weekday_from_unix(secs: u64) -> (i64, u32, u32, u32) {
    // 1970-01-01 was a Thursday (4); ISO weekday Mon=1..Sun=7.
    let days = (secs / 86_400) as i64;
    let weekday = (days + 3).rem_euclid(7) + 1;
    let (y, m, d) = civil_from_unix(secs);
    (y, m, d, weekday as u32)
}

fn maturity_unix(date: &str, hour: u32) -> Result<u64> {
    validate_date(date)?;
    let (y, m, d) = split_date(date)?;
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok((days * 86_400 + hour as i64 * 3600) as u64)
}

fn split_date(date: &str) -> Result<(i64, i64, i64)> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        bail!("date must be YYYY-MM-DD");
    }
    Ok((
        parts[0].parse().context("year")?,
        parts[1].parse().context("month")?,
        parts[2].parse().context("day")?,
    ))
}

fn validate_date(date: &str) -> Result<()> {
    let (y, m, d) = split_date(date)?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        bail!("date {date} is not a real calendar date");
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => bail!("impossible month"),
    };
    if d > dim {
        bail!("date {date} is not a real calendar date");
    }
    Ok(())
}

/// The NUT-32 unit grammar, enforced identically to the cdk fork (the
/// processor keeps its own copy so it stays on published crates).
pub fn valid_future_unit(unit: &str) -> bool {
    let Some(rest) = unit.strip_prefix("future:") else {
        return false;
    };
    let Some((pair, stamp)) = rest.rsplit_once(':') else {
        return false;
    };
    let Some((base, quote)) = pair.split_once('-') else {
        return false;
    };
    let ident = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !ident(base) || !ident(quote) {
        return false;
    }
    let bytes = stamp.as_bytes();
    bytes.len() == 16
        && bytes[8] == b't'
        && bytes[15] == b'z'
        && bytes[..8]
            .iter()
            .chain(&bytes[9..15])
            .all(|b| b.is_ascii_digit())
        && maturity_unix(&format!(
            "{}-{}-{}",
            std::str::from_utf8(&bytes[0..4]).unwrap_or("x"),
            std::str::from_utf8(&bytes[4..6]).unwrap_or("x"),
            std::str::from_utf8(&bytes[6..8]).unwrap_or("x"),
        ), 0)
        .is_ok()
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

    async fn fresh_farm() -> FarmState {
        let dir = std::env::temp_dir().join(format!("pecan-farm-{}", uuid::Uuid::new_v4()));
        FarmState::load(
            &dir,
            FarmConfig {
                price_sats: 1000,
                capacity: 10,
                horizon_days: 3,
                public_base_url: "https://giftcard.cashu.exchange/farm-console".into(),
                mint_public_url: "https://giftcard.cashu.exchange/farm".into(),
                mintd_admin_url: "http://127.0.0.1:8100".into(),
                mintd_admin_token: "t".into(),
                maturity_hour_utc: 6,
                base: "farm".into(),
                quote: "egg".into(),
                commodity: "egg".into(),
                producer: "farm".into(),
            },
        )
        .await
        .unwrap()
    }

    async fn seeded_series(farm: &FarmState, date: &str) -> FarmSeries {
        seeded_series_matured(farm, date, false).await
    }

    async fn seeded_series_matured(farm: &FarmState, date: &str, matured: bool) -> FarmSeries {
        let terms = serde_json::json!({"unit": FarmState::unit_for_date(farm.config(), date)});
        let envelope = canonical_envelope("https://m", "sig01", &terms);
        let sha = sha256_hex(envelope.as_bytes());
        tokio::fs::write(farm.inner.terms_dir.join(&sha), &envelope).await.unwrap();
        let config = farm.config();
        let unit = FarmState::unit_for_date(config, date);
        let series = FarmSeries {
            date: date.into(),
            unit: unit.clone(),
            maturity: maturity_unix(date, 16).unwrap(),
            capacity: 10,
            price_sats: 1000,
            issued: 0,
            redeemed: 0,
            actual_production: None,
            terms: TermsRecord {
                uri: format!("https://x/terms/{sha}"),
                sha256: sha,
                blob: envelope,
                signature: "sig01".into(),
                mint_pubkey: "02aa".into(),
            },
            matured_override: matured,
        };
        farm.inner
            .state
            .write()
            .await
            .series
            .insert(date.into(), series.clone());
        series
    }

    fn purchase(series: &FarmSeries, id: &str, qty: u64, state: PurchaseState) -> FarmPurchase {
        FarmPurchase {
            id: id.into(),
            series_date: series.date.clone(),
            unit: series.unit.clone(),
            quantity: qty,
            price_per_egg_sats: series.price_sats,
            total_sats: series.price_sats * qty,
            pubkey: "02abc".into(),
            state,
            bolt11: "lnbc".into(),
            payment_hash: "ff".into(),
            invoice_expires_at: unix_now() + 1000,
            created_at: unix_now(),
            paid_at: None,
            quote_id: None,
            error: None,
        }
    }

    #[test]
    fn next_friday_is_a_real_upcoming_friday() {
        let d = resolve_production_date("next-friday").unwrap();
        validate_date(&d).unwrap();
        let (.., wd) = weekday_from_unix(maturity_unix(&d, 0).unwrap());
        assert_eq!(wd, 5, "next-friday must resolve to a Friday");
        // strictly ahead of today
        assert!(maturity_unix(&d, 0).unwrap() > unix_now() - 86_400);
    }

    #[test]
    fn unit_grammar_mirrors_the_draft() {
        assert!(valid_future_unit("future:farm-egg:20260918t160000z"));
        assert!(!valid_future_unit("future:farm-egg:20260918T160000Z"));
        assert!(!valid_future_unit("future:Farm-egg:20260918t160000z"));
        assert!(!valid_future_unit("future:farm-egg:20260230t160000z"));
        assert!(!valid_future_unit("future:farm-egg:20260918t160000+01:00"));
        assert!(!valid_future_unit("eur"));
    }

    #[tokio::test]
    async fn quote_for_five_costs_five_thousand_sats() {
        let farm = fresh_farm().await;
        let series = seeded_series(&farm, "2026-09-18").await;
        let p = farm
            .insert_purchase("FP-test5", "2026-09-18", 5, "02abc", "lnbc1".into(), "aa".into())
            .await
            .unwrap();
        assert_eq!(p.total_sats, 5000);
        assert_eq!(p.unit, series.unit);
        assert_eq!(p.state, PurchaseState::Open);
    }

    #[tokio::test]
    async fn unpaid_quote_reserves_capacity() {
        let farm = fresh_farm().await;
        seeded_series(&farm, "2026-09-18").await;
        farm.insert_purchase("FP-r1", "2026-09-18", 5, "02abc", "lnbc".into(), "aa".into())
            .await
            .unwrap();
        let snapshot = farm.series_for_date("2026-09-18").await.unwrap();
        // reserved derived live from the series' purchases: 10 - 5 open
        let reserved = farm
            .purchases()
            .await
            .iter()
            .filter(|p| p.series_date == "2026-09-18" && p.state.reserves_capacity())
            .map(|p| p.quantity)
            .sum::<u64>();
        assert_eq!(snapshot.available(reserved), 5);
        // a second 6-egg purchase cannot fit in the remaining 5
        assert!(farm
            .insert_purchase("FP-r2", "2026-09-18", 6, "02abc", "lnbc".into(), "bb".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn expired_unpaid_quote_releases_capacity() {
        let farm = fresh_farm().await;
        seeded_series(&farm, "2026-09-18").await;
        let p = farm
            .insert_purchase("FP-e1", "2026-09-18", 10, "02abc", "lnbc".into(), "aa".into())
            .await
            .unwrap();
        // force-expire it
        farm.inner
            .state
            .write()
            .await
            .purchases
            .get_mut(&p.id)
            .unwrap()
            .invoice_expires_at = unix_now() - 1;
        assert_eq!(farm.sweep_expired().await, 1);
        let reserved = farm
            .purchases()
            .await
            .iter()
            .filter(|p| p.series_date == "2026-09-18" && p.state.reserves_capacity())
            .map(|p| p.quantity)
            .sum::<u64>();
        assert_eq!(reserved, 0, "expired purchase must release its reservation");
        farm.insert_purchase("FP-e2", "2026-09-18", 10, "02abc", "lnbc".into(), "cc".into())
            .await
            .expect("capacity is free again");
    }

    #[tokio::test]
    async fn reservations_are_per_series() {
        let farm = fresh_farm().await;
        seeded_series(&farm, "2026-09-18").await;
        seeded_series(&farm, "2026-09-19").await;
        farm.insert_purchase("FP-x1", "2026-09-18", 10, "02abc", "lnbc".into(), "aa".into())
            .await
            .unwrap();
        // Friday being sold out must not touch Saturday's capacity.
        farm.insert_purchase("FP-x2", "2026-09-19", 10, "02abc", "lnbc".into(), "bb".into())
            .await
            .expect("a different day's eggs are a different series");
    }

    #[tokio::test]
    async fn eleventh_egg_claim_fails_tenth_succeeds() {
        let farm = fresh_farm().await;
        seeded_series(&farm, "2026-09-18").await;
        farm.insert_purchase("FP-t1", "2026-09-18", 10, "02abc", "lnbc".into(), "aa".into())
            .await
            .unwrap();
        assert!(farm
            .insert_purchase("FP-t2", "2026-09-18", 1, "02abc", "lnbc".into(), "bb".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn concurrent_purchases_cannot_over_reserve() {
        let farm = fresh_farm().await;
        seeded_series(&farm, "2026-09-18").await;
        let farm = Arc::new(farm);
        let mut handles = Vec::new();
        for i in 0..12u64 {
            let f = farm.clone();
            handles.push(tokio::spawn(async move {
                f.insert_purchase(
                    &format!("FP-c{i:02}"),
                    "2026-09-18",
                    1,
                    "02abc",
                    format!("lnbc{i}"),
                    format!("{i:02}"),
                )
                .await
            }));
        }
        let results: Vec<anyhow::Result<FarmPurchase>> =
            futures::future::join_all(handles)
                .await
                .into_iter()
                .map(|r| r.unwrap())
                .collect();
        let ok = results.iter().filter(|r| r.is_ok()).count();
        if ok != 10 {
            for r in &results {
                if let Err(e) = r {
                    eprintln!("failed purchase: {e:#}");
                }
            }
        }
        assert_eq!(ok, 10, "exactly the 10-egg capacity may be reserved");
    }

    #[tokio::test]
    async fn issuance_requires_payment_and_binds_the_quote() {
        let farm = fresh_farm().await;
        let series = seeded_series(&farm, "2026-09-18").await;
        let mut p = purchase(&series, "FP-1", 5, PurchaseState::Open);
        farm.inner.state.write().await.purchases.insert(p.id.clone(), p.clone());

        // issuance before payment fails
        assert!(farm
            .authorize_issuance("FP-1", "q1", &series.unit, 5, "02abc")
            .await
            .is_err());

        p.state = PurchaseState::Paid;
        farm.inner
            .state
            .write()
            .await
            .purchases
            .insert("FP-1".into(), p.clone());

        // wrong key / wrong amount / wrong unit refused
        assert!(farm
            .authorize_issuance("FP-1", "q1", &series.unit, 5, "02zz")
            .await
            .is_err());
        assert!(farm
            .authorize_issuance("FP-1", "q1", &series.unit, 4, "02abc")
            .await
            .is_err());
        assert!(farm
            .authorize_issuance("FP-1", "q1", "future:farm-egg:20260919t160000z", 5, "02abc")
            .await
            .is_err());

        let authorized = farm
            .authorize_issuance("FP-1", "q1", &series.unit, 5, "02ABC")
            .await
            .unwrap();
        assert_eq!(authorized.state, PurchaseState::Authorized);

        // the same payment cannot mint twice — a second quote is refused
        assert!(farm
            .authorize_issuance("FP-1", "q2", &series.unit, 5, "02abc")
            .await
            .is_err());
        // transport-level retry of the SAME quote is a no-op
        farm.authorize_issuance("FP-1", "q1", &series.unit, 5, "02abc")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn minted_accounting_lands_on_the_series() {
        let farm = fresh_farm().await;
        let series = seeded_series(&farm, "2026-09-18").await;
        let mut p = purchase(&series, "FP-1", 5, PurchaseState::Paid);
        p.quote_id = Some("q1".into());
        p.state = PurchaseState::Authorized;
        farm.inner.state.write().await.purchases.insert("FP-1".into(), p);
        farm.mark_purchase_minted("q1").await.unwrap();
        let s = farm.series_for_date("2026-09-18").await.unwrap();
        assert_eq!(s.issued, 5);
    }

    #[tokio::test]
    async fn redemption_gate_enforces_day_window_and_shortfall() {
        let farm = fresh_farm().await;
        // Today's series with the unit hour long past: redeemable at ANY
        // hour of the production day.
        let today = date_offset(0);
        let series = seeded_series(&farm, &today).await;
        farm.inner
            .state
            .write()
            .await
            .series
            .get_mut(&today)
            .unwrap()
            .maturity = unix_now() - 3600;
        farm.redemption_gate(&series.unit, 2)
            .await
            .expect("any hour of the production day redeems");

        // Tomorrow's series: not yet claimable.
        let tomorrow = date_offset(1);
        let mut s2 = series.clone();
        s2.date = tomorrow.clone();
        s2.unit = FarmState::unit_for_date(farm.config(), &tomorrow);
        farm.inner
            .state
            .write()
            .await
            .series
            .insert(tomorrow, s2.clone());
        let err = farm.redemption_gate(&s2.unit, 1).await.unwrap_err();
        assert!(err.to_string().contains("come back on the day"), "{err}");

        // Yesterday's series: the claim is lost.
        let (y, m, d) = civil_from_unix(unix_now() - 86_400);
        let yesterday = format!("{y:04}-{m:02}-{d:02}");
        let mut s3 = series.clone();
        s3.date = yesterday.clone();
        s3.unit = FarmState::unit_for_date(farm.config(), &yesterday);
        farm.inner
            .state
            .write()
            .await
            .series
            .insert(yesterday, s3.clone());
        let err = farm.redemption_gate(&s3.unit, 1).await.unwrap_err();
        assert!(err.to_string().contains("claim is lost"), "{err}");

        // Within the day, shortfall is still enforced: 7 eggs actually
        // produced, 6 already redeemed.
        farm.set_actual_production(&today, Some(7)).await.unwrap();
        farm.recount_redeemed(&[(series.unit.clone(), 6)]).await;
        assert!(farm.redemption_gate(&series.unit, 1).await.is_ok());
        let err = farm
            .redemption_gate(&series.unit, 2)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("issuer default"), "{err}");
    }

    #[tokio::test]
    async fn same_day_sales_stay_open_past_the_collection_hour() {
        let farm = fresh_farm().await;
        // Today's series with the collection hour already behind it.
        let today = date_offset(0);
        seeded_series(&farm, &today).await;
        farm.inner
            .state
            .write()
            .await
            .series
            .get_mut(&today)
            .unwrap()
            .maturity = unix_now() - 3600;
        farm.insert_purchase("FP-sd1", &today, 1, "02abc", "lnbc".into(), "aa".into())
            .await
            .expect("the production day is still live");

        // Yesterday's series: the production day has ended — sales closed.
        let (y, m, d) = civil_from_unix(unix_now() - 86_400);
        let yesterday = format!("{y:04}-{m:02}-{d:02}");
        seeded_series(&farm, &yesterday).await;
        let err = farm
            .insert_purchase("FP-sd2", &yesterday, 1, "02abc", "lnbc".into(), "bb".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("sales closed"), "{err}");
    }

    #[tokio::test]
    async fn terms_blob_is_content_addressed_and_immutable() {
        let farm = fresh_farm().await;
        let series = seeded_series(&farm, "2026-09-18").await;
        let blob = farm.terms_blob(&series.terms.sha256).await.unwrap();
        assert_eq!(sha256_hex(blob.as_bytes()), series.terms.sha256);
        assert!(farm.terms_blob("zz").await.is_none());
    }

    #[tokio::test]
    async fn state_file_records_aggregates_not_holders() {
        // The privacy property: after issuance the farm knows series
        // aggregates only — the purchase rows carry a per-quote lock key,
        // never a holder identity or balance table.
        let farm = fresh_farm().await;
        let series = seeded_series(&farm, "2026-09-18").await;
        let mut p = purchase(&series, "FP-1", 5, PurchaseState::Authorized);
        p.quote_id = Some("q1".into());
        farm.inner.state.write().await.purchases.insert("FP-1".into(), p);
        farm.mark_purchase_minted("q1").await.unwrap();
        let raw = tokio::fs::read_to_string(&farm.inner.path).await.unwrap();
        for holder in ["sarah", "bob", "owner", "holder", "identity"] {
            assert!(
                !raw.to_lowercase().contains(holder),
                "farm state must not mention '{holder}'"
            );
        }
        assert!(raw.contains("\"issued\": 5"));
    }
}
