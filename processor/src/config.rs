//! Persistent lifecycle configuration for the browser-managed mint.
//!
//! This file is the boundary between first-run setup and normal operations.
//! The recovery seed is immutable after provisioning. Units are managed through
//! explicit lifecycle migrations so the generated mint configuration, payment
//! backend, advertised NUT settings, and keysets stay aligned.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use bip39::{Language, Mnemonic};
use bitcoin_hashes::{sha256, Hash};
use serde::{Deserialize, Serialize};

pub const PASSWORD_MIN_LENGTH: usize = 12;

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

    pub fn mint_config_path(&self) -> &Path {
        &self.mint_config_path
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
    pub auth: AuthConfig,
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

#[derive(Debug, Clone)]
pub struct SetupDraft {
    pub name: String,
    pub description: String,
    pub description_long: String,
    pub unit: String,
    pub method: String,
    pub public_url: String,
    pub password: String,
    pub password_confirm: String,
    pub mnemonic: String,
    pub rollover_enabled: bool,
    pub keyset_lifetime_days: u64,
    pub rotate_before_expiry_days: u64,
    pub input_fee_ppk: u64,
    pub amounts: Vec<u64>,
    pub backup_confirmed: bool,
}

impl AppConfig {
    pub fn from_draft(
        draft: SetupDraft,
        configured_at: u64,
        mint_http_url: String,
        mint_rpc_url: String,
        processor_grpc_addr: String,
        processor_grpc_port: u16,
    ) -> Result<Self> {
        validate_slug("unit", &draft.unit)?;
        validate_slug("method", &draft.method)?;
        validate_url("public URL", &draft.public_url)?;

        if draft.name.trim().is_empty() {
            bail!("mint name is required");
        }
        if draft.description.trim().is_empty() {
            bail!("short description is required");
        }
        validate_operator_password(&draft.password, &draft.password_confirm)?;
        if !draft.backup_confirmed {
            bail!("confirm that the recovery phrase has been backed up");
        }
        if draft.keyset_lifetime_days < 2 {
            bail!("keyset lifetime must be at least 2 days");
        }
        if draft.rotate_before_expiry_days == 0
            || draft.rotate_before_expiry_days >= draft.keyset_lifetime_days
        {
            bail!("rotate-before-expiry must be shorter than the keyset lifetime");
        }
        if draft.amounts.is_empty() {
            bail!("at least one denomination amount is required");
        }
        if draft.amounts.iter().any(|a| *a == 0) {
            bail!("denomination amounts must be greater than zero");
        }

        let mnemonic = normalize_mnemonic(&draft.mnemonic)?;

        let rollover = RolloverPolicy {
            enabled: draft.rollover_enabled,
            keyset_lifetime_days: draft.keyset_lifetime_days,
            rotate_before_expiry_days: draft.rotate_before_expiry_days,
            input_fee_ppk: draft.input_fee_ppk,
            amounts: draft.amounts,
        };
        let unit = draft.unit.trim().to_ascii_lowercase();
        let seed_fingerprint = mnemonic_fingerprint(&mnemonic);

        Ok(Self {
            version: 2,
            configured_at,
            mint: MintSetup {
                name: draft.name.trim().to_string(),
                description: draft.description.trim().to_string(),
                description_long: draft.description_long.trim().to_string(),
                unit: unit.clone(),
                method: draft.method.trim().to_ascii_lowercase(),
                mnemonic,
            },
            auth: AuthConfig {
                password_hash: hash_password(&draft.password),
            },
            endpoints: EndpointConfig {
                public_url: draft.public_url.trim().trim_end_matches('/').to_string(),
                mint_http_url,
                mint_rpc_url,
                processor_grpc_addr,
                processor_grpc_port,
            },
            rollover: rollover.clone(),
            units: vec![ManagedUnit {
                unit,
                lifecycle: UnitLifecycle::Active,
                configured_at,
                rollover,
            }],
            seed_fingerprint,
        })
    }

    pub fn verify_password(&self, password: &str) -> bool {
        verify_password(password, &self.auth.password_hash)
    }

    pub fn upgrade(&mut self) {
        if self.units.is_empty() {
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
        self.version = 2;
    }

    pub fn validate_integrity(&self) -> Result<()> {
        let actual = mnemonic_fingerprint(&self.mint.mnemonic);
        if self.seed_fingerprint != actual {
            bail!(
                "configured recovery seed does not match the immutable seed fingerprint; refusing to continue"
            );
        }
        if self.units.is_empty() {
            bail!("at least one managed unit is required");
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

fn normalize_mnemonic(raw: &str) -> Result<String> {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|e| anyhow!("recovery phrase is not a valid English BIP39 phrase: {e}"))?;
    Ok(mnemonic.to_string())
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

fn validate_url(label: &str, value: &str) -> Result<()> {
    let value = value.trim();
    if !(value.starts_with("http://") || value.starts_with("https://")) {
        bail!("{label} must start with http:// or https://");
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

async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
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

    fn test_config() -> AppConfig {
        AppConfig::from_draft(
            SetupDraft {
                name: "Branch mint".into(),
                description: "Test".into(),
                description_long: "Test mint".into(),
                unit: "ora".into(),
                method: "branch".into(),
                public_url: "http://localhost:8089".into(),
                password: "correct horse 7!".into(),
                password_confirm: "correct horse 7!".into(),
                mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".into(),
                rollover_enabled: true,
                keyset_lifetime_days: 30,
                rotate_before_expiry_days: 7,
                input_fee_ppk: 0,
                amounts: vec![1, 2, 4, 8],
                backup_confirmed: true,
            },
            1,
            "http://mint:8089".into(),
            "http://mint:8091".into(),
            "processor".into(),
            50051,
        )
        .expect("valid config")
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
