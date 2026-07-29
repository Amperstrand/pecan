//! Persistent lifecycle configuration for the browser-managed mint.
//!
//! First boot bootstraps a complete configuration from env + defaults (no
//! setup wizard) with zero units: the mint runs but advertises nothing until
//! the operator adds the first unit from the console. The recovery seed is
//! immutable after provisioning. Units are managed through explicit lifecycle
//! migrations so the generated mint configuration, payment backend, advertised
//! NUT settings, and keysets stay aligned.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use bip39::{Language, Mnemonic};
use bitcoin_hashes::{sha256, Hash};
use serde::{Deserialize, Serialize};

pub const PASSWORD_MIN_LENGTH: usize = 12;

/// Lifetime of a wallet-created mint quote. Rendered into mint.toml, asserted
/// over the management RPC on every boot, and mirrored by the processor's
/// ticket expiry — a customer has this long to hand over cash at the counter.
pub const MINT_QUOTE_TTL_SECS: u64 = 30 * 60;

/// Lifetime of a wallet-created melt quote (cdk's default of 60 s is far too
/// tight for a counter visit). Same three uses as [`MINT_QUOTE_TTL_SECS`].
pub const MELT_QUOTE_TTL_SECS: u64 = 15 * 60;

#[derive(Clone, Debug)]
pub struct ConfigStore {
    app_config_path: PathBuf,
    mint_config_path: PathBuf,
    backup_path: Option<PathBuf>,
}

impl ConfigStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            app_config_path: config_dir.join("setup.json"),
            mint_config_path: config_dir.join("mint.toml"),
            backup_path: None,
        }
    }

    pub fn with_backup_path(mut self, backup_path: PathBuf) -> Self {
        self.backup_path = Some(backup_path);
        self
    }

    pub fn app_config_path(&self) -> &Path {
        &self.app_config_path
    }

    pub async fn load(&self) -> Result<Option<AppConfig>> {
        if !tokio::fs::try_exists(&self.app_config_path)
            .await
            .unwrap_or(false)
        {
            let Some(backup_path) = self.backup_path.as_ref() else {
                return Ok(None);
            };
            if !tokio::fs::try_exists(backup_path).await.unwrap_or(false) {
                return Ok(None);
            }
            let raw = tokio::fs::read(backup_path)
                .await
                .with_context(|| format!("read recovery backup {}", backup_path.display()))?;
            let mut config: AppConfig = serde_json::from_slice(&raw)
                .with_context(|| format!("parse recovery backup {}", backup_path.display()))?;
            config.upgrade();
            config.validate_integrity()?;
            self.save(&config).await?;
            return Ok(Some(config));
        }
        let raw = tokio::fs::read(&self.app_config_path)
            .await
            .with_context(|| format!("read {}", self.app_config_path.display()))?;
        let mut config: AppConfig = serde_json::from_slice(&raw)
            .with_context(|| format!("parse {}", self.app_config_path.display()))?;
        config.upgrade();
        config.validate_integrity()?;
        Ok(Some(config))
    }

    pub async fn save(&self, config: &AppConfig) -> Result<()> {
        config.validate_integrity()?;
        if let Some(parent) = self.app_config_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(config)?;
        write_atomic(&self.app_config_path, &bytes).await?;
        if let Some(backup_path) = self.backup_path.as_ref() {
            if let Some(parent) = backup_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            write_atomic(backup_path, &bytes).await?;
        }
        Ok(())
    }

    pub async fn write_mint_config(&self, config: &AppConfig) -> Result<()> {
        if let Some(parent) = self.mint_config_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let rendered = render_mint_toml(config);
        write_atomic(&self.mint_config_path, rendered.as_bytes()).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub version: u32,
    pub configured_at: u64,
    pub mint: MintSetup,
    /// Deprecated single-operator password from the pre-user-database era.
    /// Optional so old setup.json files still parse; main migrates the hash
    /// into users.json as user "admin" and strips this field on save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthConfig>,
    pub endpoints: EndpointConfig,
    pub rollover: RolloverPolicy,
    #[serde(default)]
    pub units: Vec<ManagedUnit>,
    #[serde(default)]
    pub seed_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MintSetup {
    pub name: String,
    pub description: String,
    pub description_long: String,
    pub unit: String,
    pub method: String,
    pub mnemonic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    pub password_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointConfig {
    pub public_url: String,
    pub mint_http_url: String,
    pub mint_rpc_url: String,
    pub processor_grpc_addr: String,
    pub processor_grpc_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolloverPolicy {
    pub enabled: bool,
    pub keyset_lifetime_days: u64,
    pub rotate_before_expiry_days: u64,
    pub input_fee_ppk: u64,
    pub amounts: Vec<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitLifecycle {
    Active,
    RedemptionOnly,
    Retired,
}

impl UnitLifecycle {
    pub fn can_mint(self) -> bool {
        self == Self::Active
    }

    pub fn can_melt(self) -> bool {
        matches!(self, Self::Active | Self::RedemptionOnly)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedUnit {
    pub unit: String,
    pub lifecycle: UnitLifecycle,
    pub configured_at: u64,
    pub rollover: RolloverPolicy,
}

/// Endpoint values baked into a bootstrapped config, sourced from env vars
/// (all of which have defaults) in main.
#[derive(Debug, Clone)]
pub struct BootstrapEndpoints {
    pub public_url: String,
    pub mint_http_url: String,
    pub mint_rpc_url: String,
    pub processor_grpc_addr: String,
    pub processor_grpc_port: u16,
}

/// Build a complete first-run configuration with generated defaults — a fresh
/// recovery mnemonic, the "branch" method, the stock rollover policy, and no
/// units. Replaces the browser setup wizard: the stack comes up working with
/// zero interaction, the mint advertises nothing until the operator adds the
/// first unit from the console, and everything here except the recovery seed
/// stays editable from the operator UI.
pub fn bootstrap_config(endpoints: BootstrapEndpoints, configured_at: u64) -> Result<AppConfig> {
    let mnemonic = generate_mnemonic()?;
    let rollover = RolloverPolicy {
        enabled: true,
        keyset_lifetime_days: 90,
        rotate_before_expiry_days: 14,
        input_fee_ppk: 0,
        amounts: default_amounts(),
    };
    let seed_fingerprint = mnemonic_fingerprint(&mnemonic);
    let config = AppConfig {
        version: 3,
        configured_at,
        mint: MintSetup {
            name: "Custom Unit Mint".to_string(),
            description: "Cashu mint for a custom unit with branch settlement.".to_string(),
            description_long: "A stock cdk-mintd instance managed from the browser UI. Mint and melt quotes settle manually through the branch operator workflow.".to_string(),
            // The primary unit is claimed by the first unit the operator adds.
            unit: String::new(),
            method: "branch".to_string(),
            mnemonic,
        },
        auth: None,
        endpoints: EndpointConfig {
            public_url: endpoints
                .public_url
                .trim()
                .trim_end_matches('/')
                .to_string(),
            mint_http_url: endpoints.mint_http_url,
            mint_rpc_url: endpoints.mint_rpc_url,
            processor_grpc_addr: endpoints.processor_grpc_addr,
            processor_grpc_port: endpoints.processor_grpc_port,
        },
        rollover: rollover.clone(),
        units: Vec::new(),
        seed_fingerprint,
    };
    config.validate_integrity()?;
    Ok(config)
}

impl AppConfig {
    pub fn upgrade(&mut self) {
        // Wizard-era configs predate the units list but always carried a
        // primary unit; migrate it. Bootstrapped configs with no units yet
        // have an empty primary, which is a valid state, not a legacy one.
        if self.units.is_empty() && !self.mint.unit.is_empty() {
            self.units.push(ManagedUnit {
                unit: self.mint.unit.clone(),
                lifecycle: UnitLifecycle::Active,
                configured_at: self.configured_at,
                rollover: self.rollover.clone(),
            });
        }
        if self.seed_fingerprint.is_empty() {
            self.seed_fingerprint = mnemonic_fingerprint(&self.mint.mnemonic);
        }
        self.version = 3;
    }

    pub fn validate_integrity(&self) -> Result<()> {
        let actual = mnemonic_fingerprint(&self.mint.mnemonic);
        if self.seed_fingerprint != actual {
            bail!(
                "configured recovery seed does not match the immutable seed fingerprint; refusing to continue"
            );
        }
        for managed in &self.units {
            validate_slug("unit", &managed.unit)?;
            validate_rollover(&managed.rollover)?;
        }
        Ok(())
    }

    pub fn managed_unit(&self, unit: &str) -> Option<&ManagedUnit> {
        self.units.iter().find(|candidate| candidate.unit == unit)
    }

    pub fn add_unit(
        &mut self,
        unit: &str,
        rollover: RolloverPolicy,
        configured_at: u64,
    ) -> Result<()> {
        validate_slug("unit", unit)?;
        validate_rollover(&rollover)?;
        let unit = unit.trim().to_ascii_lowercase();
        if self.managed_unit(&unit).is_some() {
            bail!("unit {unit} is already managed");
        }
        // The first unit ever added claims the primary slot (a fresh install
        // bootstraps with none), putting the config in the same shape the
        // wizard used to produce. The legacy top-level policy mirrors it.
        if self.mint.unit.is_empty() {
            self.mint.unit = unit.clone();
            self.rollover = rollover.clone();
        }
        self.units.push(ManagedUnit {
            unit,
            lifecycle: UnitLifecycle::Active,
            configured_at,
            rollover,
        });
        self.units.sort_by(|a, b| a.unit.cmp(&b.unit));
        Ok(())
    }

    pub fn set_unit_lifecycle(&mut self, unit: &str, lifecycle: UnitLifecycle) -> Result<()> {
        let managed = self
            .units
            .iter_mut()
            .find(|candidate| candidate.unit == unit)
            .ok_or_else(|| anyhow!("unit {unit} is not managed"))?;
        managed.lifecycle = lifecycle;
        Ok(())
    }

    /// Replace an existing unit's rollover policy. Future rotations (manual and
    /// automatic) use the new policy after the restart that follows.
    pub fn set_unit_rollover(&mut self, unit: &str, rollover: RolloverPolicy) -> Result<()> {
        validate_rollover(&rollover)?;
        let managed = self
            .units
            .iter_mut()
            .find(|candidate| candidate.unit == unit)
            .ok_or_else(|| anyhow!("unit {unit} is not managed"))?;
        managed.rollover = rollover.clone();
        if self.mint.unit == unit {
            // The legacy top-level policy mirrors the primary unit.
            self.rollover = rollover;
        }
        Ok(())
    }
}

pub fn default_amounts() -> Vec<u64> {
    (0..32).map(|i| 2u64.pow(i)).collect()
}

pub fn generate_mnemonic() -> Result<String> {
    let mnemonic = Mnemonic::generate_in(Language::English, 24)?;
    Ok(mnemonic.to_string())
}

pub fn parse_amounts(raw: &str) -> Result<Vec<u64>> {
    let mut amounts: Vec<u64> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u64>().map_err(|e| anyhow!("{s}: {e}")))
        .collect::<Result<_>>()?;
    amounts.sort_unstable();
    amounts.dedup();
    if amounts.is_empty() {
        bail!("at least one amount is required");
    }
    Ok(amounts)
}

pub fn validate_operator_password(password: &str, password_confirm: &str) -> Result<()> {
    if password.chars().count() < PASSWORD_MIN_LENGTH {
        bail!("operator password must be at least {PASSWORD_MIN_LENGTH} characters");
    }
    if !password.chars().any(char::is_alphabetic) {
        bail!("operator password must include a letter");
    }
    if !password.chars().any(|c| c.is_ascii_digit()) {
        bail!("operator password must include a number");
    }
    if !password
        .chars()
        .any(|c| !c.is_alphanumeric() && !c.is_whitespace())
    {
        bail!("operator password must include a symbol");
    }
    if password != password_confirm {
        bail!("operator passwords do not match");
    }
    Ok(())
}

// Upgrade slot: to move to a vetted KDF (argon2id), add an "argon2id:" branch
// in `verify_password`, switch this function's output format, and rehash
// opportunistically on successful login in `UserStore::verify`.
pub fn hash_password(password: &str) -> String {
    let salt = uuid::Uuid::new_v4().to_string();
    let digest = password_digest(&salt, password);
    format!("sha256:120000:{salt}:{digest}")
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split(':').collect();
    if parts.len() != 4 || parts[0] != "sha256" {
        return false;
    }
    let iterations = parts[1].parse::<usize>().unwrap_or(0);
    if iterations == 0 {
        return false;
    }
    let digest = password_digest_with_iterations(parts[2], password, iterations);
    constant_time_eq(digest.as_bytes(), parts[3].as_bytes())
}

fn password_digest(salt: &str, password: &str) -> String {
    password_digest_with_iterations(salt, password, 120_000)
}

fn password_digest_with_iterations(salt: &str, password: &str, iterations: usize) -> String {
    let mut input = format!("{salt}:{password}").into_bytes();
    let mut hash = sha256::Hash::hash(&input).to_byte_array().to_vec();
    for _ in 1..iterations {
        input.clear();
        input.extend_from_slice(salt.as_bytes());
        input.push(b':');
        input.extend_from_slice(&hash);
        hash = sha256::Hash::hash(&input).to_byte_array().to_vec();
    }
    bytes_to_hex(&hash)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn mnemonic_fingerprint(mnemonic: &str) -> String {
    let digest = sha256::Hash::hash(mnemonic.as_bytes()).to_string();
    format!("sha256:{}", &digest[..16])
}

fn validate_rollover(rollover: &RolloverPolicy) -> Result<()> {
    if rollover.keyset_lifetime_days < 2 {
        bail!("keyset lifetime must be at least 2 days");
    }
    if rollover.rotate_before_expiry_days == 0
        || rollover.rotate_before_expiry_days >= rollover.keyset_lifetime_days
    {
        bail!("rotate-before-expiry must be shorter than the keyset lifetime");
    }
    if rollover.amounts.is_empty() || rollover.amounts.contains(&0) {
        bail!("denomination amounts must be greater than zero");
    }
    Ok(())
}

fn validate_slug(label: &str, value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{label} is required");
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        bail!("{label} may only contain lowercase letters, digits, hyphen, and underscore");
    }
    Ok(())
}

fn render_mint_toml(config: &AppConfig) -> String {
    let mut ln_entries = String::new();
    let mut supported_units = Vec::new();
    let mut unit_keysets = String::new();
    for managed in config
        .units
        .iter()
        .filter(|unit| unit.lifecycle != UnitLifecycle::Retired)
    {
        supported_units.push(format!("\"{}\"", toml_escape(&managed.unit)));
        let max_mint = if managed.lifecycle.can_mint() {
            500_000
        } else {
            0
        };
        ln_entries.push_str(&format!(
            r#"
[[ln]]
ln_backend = "grpcprocessor"
unit = "{unit}"
min_mint = {min_mint}
max_mint = {max_mint}
min_melt = 1
max_melt = 500000
"#,
            unit = toml_escape(&managed.unit),
            min_mint = if max_mint == 0 { 0 } else { 1 },
            max_mint = max_mint,
        ));
        let amounts = managed
            .rollover
            .amounts
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let initial_final_expiry = managed
            .configured_at
            .saturating_add(managed.rollover.keyset_lifetime_days.saturating_mul(86_400));
        unit_keysets.push_str(&format!(
            r#"
[grpc_processor.unit_keysets.{unit}]
amounts = [{amounts}]
input_fee_ppk = {input_fee_ppk}
initial_final_expiry = {initial_final_expiry}
"#,
            unit = toml_escape(&managed.unit),
            amounts = amounts,
            input_fee_ppk = managed.rollover.input_fee_ppk,
            initial_final_expiry = initial_final_expiry,
        ));
    }

    format!(
        r#"# Generated by the Custom Unit Mint setup UI.
# Do not edit this file directly while the lifecycle UI manages the mint.

[info]
url = "{public_url}"
listen_host = "0.0.0.0"
listen_port = 8089
mnemonic = "{mnemonic}"

[info.http_cache]
backend = "memory"
ttl = 60
tti = 60

# Seeds a fresh mint database; existing databases are updated over the
# management RPC at processor boot (QuoteTTL is DB-persisted).
[info.quote_ttl]
mint_ttl = {mint_quote_ttl}
melt_ttl = {melt_quote_ttl}

[mint_info]
name = "{name}"
description = "{description}"
description_long = "{description_long}"

[database]
engine = "sqlite"

{ln_entries}

[grpc_processor]
supported_units = [{supported_units}]
addr = "{processor_grpc_addr}"
port = {processor_grpc_port}
{unit_keysets}

[mint_management_rpc]
enabled = true
address = "0.0.0.0"
port = 8091

[limits]
max_inputs = 1000
max_outputs = 1000
"#,
        public_url = toml_escape(&config.endpoints.public_url),
        mnemonic = toml_escape(&config.mint.mnemonic),
        mint_quote_ttl = MINT_QUOTE_TTL_SECS,
        melt_quote_ttl = MELT_QUOTE_TTL_SECS,
        name = toml_escape(&config.mint.name),
        description = toml_escape(&config.mint.description),
        description_long = toml_escape(&config.mint.description_long),
        ln_entries = ln_entries,
        supported_units = supported_units.join(", "),
        processor_grpc_addr = toml_escape(&config.endpoints.processor_grpc_addr),
        processor_grpc_port = config.endpoints.processor_grpc_port,
        unit_keysets = unit_keysets,
    )
}

fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub(crate) async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, bytes)
        .await
        .with_context(|| format!("write {}", tmp.display()))?;
    tokio::fs::rename(&tmp, path)
        .await
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_endpoints() -> BootstrapEndpoints {
        BootstrapEndpoints {
            public_url: "http://localhost:8089".into(),
            mint_http_url: "http://mint:8089".into(),
            mint_rpc_url: "http://mint:8091".into(),
            processor_grpc_addr: "processor".into(),
            processor_grpc_port: 50051,
        }
    }

    fn test_config() -> AppConfig {
        let mut config = bootstrap_config(test_endpoints(), 1).expect("valid config");
        config.mint.name = "Branch mint".into();
        let rollover = RolloverPolicy {
            enabled: true,
            keyset_lifetime_days: 30,
            rotate_before_expiry_days: 7,
            input_fee_ppk: 0,
            amounts: vec![1, 2, 4, 8],
        };
        config.add_unit("ora", rollover, 1).expect("add first unit");
        config
    }

    #[test]
    fn bootstrap_produces_a_valid_unitless_config() {
        let config = bootstrap_config(test_endpoints(), 42).expect("bootstrap");
        assert!(config.validate_integrity().is_ok());
        assert!(config.auth.is_none());
        assert_eq!(config.version, 3);
        assert_eq!(config.mint.unit, "");
        assert_eq!(config.mint.method, "branch");
        assert_eq!(config.mint.mnemonic.split_whitespace().count(), 24);
        assert!(config.units.is_empty());
        let rendered = render_mint_toml(&config);
        assert!(!rendered.contains("[[ln]]"));
        assert!(!rendered.contains("unit_keysets"));
        assert!(rendered.contains("supported_units = []"));
    }

    #[test]
    fn first_added_unit_claims_the_primary_slot() {
        let mut config = bootstrap_config(test_endpoints(), 42).expect("bootstrap");
        let policy = RolloverPolicy {
            enabled: true,
            keyset_lifetime_days: 30,
            rotate_before_expiry_days: 7,
            input_fee_ppk: 3,
            amounts: vec![1, 2, 4, 8],
        };
        config
            .add_unit("ora", policy.clone(), 43)
            .expect("add first unit");
        assert_eq!(config.mint.unit, "ora");
        assert_eq!(config.rollover.input_fee_ppk, 3);
        let rendered = render_mint_toml(&config);
        assert!(rendered.contains("[grpc_processor.unit_keysets.ora]"));
        assert!(rendered.contains("supported_units = [\"ora\"]"));

        config.add_unit("usd", policy, 44).expect("add second unit");
        assert_eq!(config.mint.unit, "ora");
    }

    #[test]
    fn upgrade_migrates_wizard_units_but_keeps_bootstrap_empty() {
        let mut wizard_era = test_config();
        wizard_era.units.clear();
        wizard_era.version = 2;
        wizard_era.upgrade();
        assert_eq!(wizard_era.units.len(), 1);
        assert_eq!(wizard_era.units[0].unit, "ora");

        let mut fresh = bootstrap_config(test_endpoints(), 42).expect("bootstrap");
        fresh.upgrade();
        assert!(fresh.units.is_empty());
    }

    #[test]
    fn v2_config_with_auth_parses_and_auth_is_omitted_when_none() {
        let mut config = test_config();
        config.version = 2;
        config.auth = Some(AuthConfig {
            password_hash: hash_password("Old-passw0rd!"),
        });
        let raw = serde_json::to_vec_pretty(&config).expect("serialize");
        assert!(String::from_utf8_lossy(&raw).contains("\"auth\""));

        let mut parsed: AppConfig = serde_json::from_slice(&raw).expect("parse v2");
        assert!(parsed.auth.is_some());
        parsed.upgrade();
        assert_eq!(parsed.version, 3);
        // Stripping auth is main's job (after seeding users.json); upgrade keeps it.
        assert!(parsed.auth.is_some());

        parsed.auth = None;
        let raw = serde_json::to_vec_pretty(&parsed).expect("serialize authless");
        assert!(!String::from_utf8_lossy(&raw).contains("\"auth\""));
        let reparsed: AppConfig = serde_json::from_slice(&raw).expect("parse authless");
        assert!(reparsed.auth.is_none());
    }

    #[test]
    fn set_unit_rollover_updates_unit_and_primary_mirror() {
        let mut config = test_config();
        let policy = RolloverPolicy {
            enabled: false,
            keyset_lifetime_days: 60,
            rotate_before_expiry_days: 10,
            input_fee_ppk: 5,
            amounts: vec![1, 2, 4],
        };
        config
            .set_unit_rollover("ora", policy.clone())
            .expect("edit policy");
        assert_eq!(
            config.managed_unit("ora").unwrap().rollover.amounts,
            policy.amounts
        );
        assert_eq!(config.rollover.input_fee_ppk, 5);
        assert!(config.set_unit_rollover("nope", policy.clone()).is_err());
        let bad = RolloverPolicy {
            keyset_lifetime_days: 1,
            ..policy
        };
        assert!(config.set_unit_rollover("ora", bad).is_err());
    }

    #[test]
    fn renders_each_lifecycle_without_advertising_retired_units() {
        let mut config = test_config();
        config
            .add_unit(
                "usd",
                RolloverPolicy {
                    enabled: true,
                    keyset_lifetime_days: 14,
                    rotate_before_expiry_days: 3,
                    input_fee_ppk: 2,
                    amounts: vec![1, 5, 10],
                },
                2,
            )
            .expect("add unit");
        config
            .set_unit_lifecycle("ora", UnitLifecycle::RedemptionOnly)
            .expect("change lifecycle");
        let rendered = render_mint_toml(&config);
        assert!(rendered.contains("unit = \"ora\"\nmin_mint = 0\nmax_mint = 0"));
        assert!(rendered.contains("unit = \"usd\"\nmin_mint = 1\nmax_mint = 500000"));
        assert!(rendered.contains(&format!(
            "[info.quote_ttl]\nmint_ttl = {MINT_QUOTE_TTL_SECS}\nmelt_ttl = {MELT_QUOTE_TTL_SECS}"
        )));
        assert!(rendered.contains(
            "[grpc_processor.unit_keysets.usd]\namounts = [1, 5, 10]\ninput_fee_ppk = 2\ninitial_final_expiry = 1209602"
        ));

        config
            .set_unit_lifecycle("ora", UnitLifecycle::Retired)
            .expect("retire");
        let rendered = render_mint_toml(&config);
        assert!(!rendered.contains("unit = \"ora\""));
        assert!(rendered.contains("supported_units = [\"usd\"]"));
    }

    #[test]
    fn rejects_a_changed_recovery_seed() {
        let mut config = test_config();
        config.mint.mnemonic =
            "legal winner thank year wave sausage worth useful legal winner thank yellow".into();
        assert!(config.validate_integrity().is_err());
    }
}
