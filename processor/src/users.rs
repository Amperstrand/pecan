//! Persistent operator accounts (username + password hash).
//!
//! Modeled on `state::BranchState`: `Arc<Inner>` around a `RwLock`ed map with
//! whole-file atomic persistence. User CRUD mutates the live store and never
//! restarts the process, unlike config changes.
//!
//! Seeding rules on load:
//!   * missing file + legacy operator hash → migrate it as user "admin"
//!   * missing file + installer-provided initial password → user "admin"
//!     with that password (no demo-credential window on public installs)
//!   * missing file, neither of the above → demo credentials admin/admin
//!   * unparseable file → preserved as users.json.corrupt-<ts>, then reseeded
//!     through the same matrix (this is an appliance; refusing to boot would
//!     brick the whole stack, and anyone who can corrupt the file can already
//!     rewrite the processor config that lives in the same directory)

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::{hash_password, validate_operator_password, verify_password, write_atomic};

pub const DEMO_USERNAME: &str = "admin";
const DEMO_PASSWORD: &str = "admin";
const MAX_USERNAME_LEN: usize = 32;

/// Domain errors the web layer maps to HTTP statuses.
#[derive(Debug, thiserror::Error)]
pub enum UserError {
    /// 400: bad username or password shape.
    #[error("{0}")]
    Invalid(String),
    /// 409: username taken.
    #[error("user {0} already exists")]
    Duplicate(String),
    /// 404: no such user.
    #[error("unknown user {0}")]
    Unknown(String),
    /// 409: a session may not remove its own user.
    #[error("cannot delete the signed-in user")]
    DeleteSelf,
    /// 409: at least one account must remain able to sign in.
    #[error("cannot delete the last user")]
    DeleteLast,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRecord {
    pub username: String,
    pub password_hash: String,
    pub created_at: u64,
    /// True while the account still uses a password the operator did not
    /// choose themselves (the installer-provisioned first-boot password).
    /// Cleared the first time the user sets their own password.
    #[serde(default)]
    pub must_change_password: bool,
    /// `"admin"` gates user/settings management; `None` is a plain teller
    /// who can only match and settle tickets. The seeded account is admin;
    /// pre-role installs migrate the `admin` username to admin.
    #[serde(default)]
    pub role: Option<String>,
}

/// Snapshot-safe projection: never carries the hash.
#[derive(Debug, Clone, Serialize)]
pub struct PublicUser {
    pub username: String,
    pub created_at: u64,
    pub role: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsersFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    users: BTreeMap<String, UserRecord>,
}

#[derive(Clone)]
pub struct UserStore {
    inner: Arc<Inner>,
}

struct Inner {
    users: RwLock<BTreeMap<String, UserRecord>>,
    /// Cached "admin still uses the demo password" flag. Recomputed only on
    /// mutation — a 120k-round verify must never run per snapshot request.
    demo_password_active: RwLock<bool>,
    path: PathBuf,
}

impl UserStore {
    /// Load or seed the user store. `legacy_hash` carries the deprecated
    /// single-operator password hash from setup.json; when the store does not
    /// exist yet, that hash becomes user "admin" so existing instances keep
    /// their password across the migration. `initial_password` carries
    /// CDK_BRANCH_PROCESSOR_INITIAL_ADMIN_PASSWORD, a first-boot provisioning
    /// knob for the installer: it seeds "admin" only when no store exists and
    /// no legacy hash applies, and is ignored ever after — it is not a
    /// password-reset mechanism.
    pub async fn load(
        path: PathBuf,
        legacy_hash: Option<String>,
        initial_password: Option<String>,
    ) -> Result<Self> {
        let mut users: Option<BTreeMap<String, UserRecord>> = None;
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            let raw = tokio::fs::read(&path)
                .await
                .with_context(|| format!("read {}", path.display()))?;
            match serde_json::from_slice::<UsersFile>(&raw) {
                Ok(file) if !file.users.is_empty() => users = Some(file.users),
                Ok(_) => {
                    tracing::warn!("{} contains no users; reseeding", path.display());
                }
                Err(e) => {
                    let quarantine = path.with_extension(format!("json.corrupt-{}", unix_now()));
                    tracing::error!(
                        "could not parse {} ({e}); preserving it as {} and reseeding",
                        path.display(),
                        quarantine.display()
                    );
                    tokio::fs::rename(&path, &quarantine)
                        .await
                        .with_context(|| format!("quarantine {}", path.display()))?;
                }
            }
        }

        let (mut users, seeded) = match users {
            Some(users) => {
                if initial_password.is_some() {
                    tracing::info!(
                        "{} already exists; CDK_BRANCH_PROCESSOR_INITIAL_ADMIN_PASSWORD is ignored",
                        path.display()
                    );
                }
                (users, false)
            }
            None => {
                let (hash, must_change_password) = match (legacy_hash, initial_password) {
                    // An existing install's chosen password always wins; the
                    // env var provisions first boots, it never resets.
                    (Some(hash), _) => {
                        tracing::info!(
                            "seeding {} from the existing operator password as user {DEMO_USERNAME:?}",
                            path.display()
                        );
                        (hash, false)
                    }
                    (None, Some(password)) => {
                        // Fail hard on an invalid value: nothing exists yet
                        // that could be bricked, and silently falling back to
                        // admin/admin on a public install would be worse than
                        // an error the installer's health wait surfaces.
                        validate_operator_password(&password, &password).map_err(|e| {
                            anyhow!(
                                "CDK_BRANCH_PROCESSOR_INITIAL_ADMIN_PASSWORD: {e}; \
                                 refusing to seed the first operator account"
                            )
                        })?;
                        tracing::info!(
                            "seeding {} for user {DEMO_USERNAME:?} from \
                             CDK_BRANCH_PROCESSOR_INITIAL_ADMIN_PASSWORD",
                            path.display()
                        );
                        // The deployer explicitly chose this password.
                        (hash_password(&password), false)
                    }
                    (None, None) => {
                        use rand::Rng;
                        let random: String = rand::thread_rng()
                            .sample_iter(&rand::distributions::Alphanumeric)
                            .take(20)
                            .map(char::from)
                            .collect();
                        // Persist the credential on the config volume instead of
                        // stdout logs: container log lines do not survive
                        // `compose up --force-recreate`, and docker logs are
                        // readable by the whole docker group (CWE-532).
                        let secret_path = path
                            .parent()
                            .map(|dir| dir.join("initial-admin-password.txt"))
                            .context("users.json path has no parent directory")?;
                        let written = std::fs::write(&secret_path, format!("{random}\n"))
                            .and_then(|()| {
                                use std::os::unix::fs::PermissionsExt;
                                std::fs::set_permissions(
                                    &secret_path,
                                    std::fs::Permissions::from_mode(0o600),
                                )
                            });
                        match written {
                            Ok(()) => tracing::warn!(
                                "no password configured — generated random admin password; \
                                 saved to {} (mode 0600). Delete the file after first login.",
                                secret_path.display()
                            ),
                            Err(err) => tracing::warn!(
                                "no password configured — generated random admin password: \
                                 {random} (could not persist to {}: {err}; this line is the \
                                 only record — logs do not survive container recreation)",
                                secret_path.display()
                            ),
                        }
                        tracing::info!(
                            "set CDK_BRANCH_PROCESSOR_INITIAL_ADMIN_PASSWORD to override"
                        );
                        (hash_password(&random), false)
                    }
                };
                let mut users = BTreeMap::new();
                users.insert(
                    DEMO_USERNAME.to_string(),
                    UserRecord {
                        username: DEMO_USERNAME.to_string(),
                        password_hash: hash,
                        created_at: unix_now(),
                        must_change_password,
                        role: Some("admin".into()),
                    },
                );
                (users, true)
            }
        };

        // Pre-role installs: the seeded `admin` account predates the role
        // field; grant it admin so an upgrade never locks out management.
        if let Some(admin) = users.get_mut(DEMO_USERNAME) {
            if admin.role.is_none() {
                admin.role = Some("admin".into());
            }
        }

        let demo_password_active = users
            .get(DEMO_USERNAME)
            .is_some_and(|user| verify_password(DEMO_PASSWORD, &user.password_hash));

        let store = Self {
            inner: Arc::new(Inner {
                users: RwLock::new(users),
                demo_password_active: RwLock::new(demo_password_active),
                path,
            }),
        };
        if seeded {
            store.persist().await?;
        }
        Ok(store)
    }

    /// Constant-shape credential check: unknown usernames still burn a full
    /// verify against a dummy hash so they are not distinguishable by timing.
    pub async fn verify(&self, username: &str, password: &str) -> bool {
        let username = normalize_username(username);
        let hash = {
            let users = self.inner.users.read().await;
            users.get(&username).map(|user| user.password_hash.clone())
        };
        match hash {
            Some(hash) => verify_password(password, &hash),
            None => {
                verify_password(password, dummy_hash());
                false
            }
        }
    }

    pub async fn contains(&self, username: &str) -> bool {
        self.inner
            .users
            .read()
            .await
            .contains_key(&normalize_username(username))
    }

    pub async fn list(&self) -> Vec<PublicUser> {
        self.inner
            .users
            .read()
            .await
            .values()
            .map(|user| PublicUser {
                username: user.username.clone(),
                created_at: user.created_at,
                role: user.role.clone(),
            })
            .collect()
    }

    pub async fn is_admin(&self, username: &str) -> bool {
        self.inner
            .users
            .read()
            .await
            .get(&normalize_username(username))
            .is_some_and(|user| user.role.as_deref() == Some("admin"))
    }

    pub async fn demo_password_active(&self) -> bool {
        *self.inner.demo_password_active.read().await
    }

    /// Whether this account is still on its installer-provisioned password
    /// and must set its own before using the console.
    pub async fn must_change_password(&self, username: &str) -> bool {
        self.inner
            .users
            .read()
            .await
            .get(&normalize_username(username))
            .is_some_and(|user| user.must_change_password)
    }

    pub async fn create(
        &self,
        username: &str,
        password: &str,
        password_confirm: &str,
    ) -> Result<PublicUser> {
        let username = validate_username(username)?;
        validate_operator_password(password, password_confirm)
            .map_err(|e| UserError::Invalid(e.to_string()))?;
        let record = UserRecord {
            username: username.clone(),
            password_hash: hash_password(password),
            created_at: unix_now(),
            must_change_password: false,
            role: None,
        };
        {
            let mut users = self.inner.users.write().await;
            if users.contains_key(&username) {
                return Err(UserError::Duplicate(username).into());
            }
            users.insert(username.clone(), record.clone());
        }
        self.persist().await?;
        Ok(PublicUser {
            username: record.username,
            created_at: record.created_at,
            role: record.role,
        })
    }

    pub async fn delete(&self, username: &str, acting_user: &str) -> Result<()> {
        let username = normalize_username(username);
        {
            // Self/last-user guards live inside the write lock: no TOCTOU
            // between the count check and the removal.
            let mut users = self.inner.users.write().await;
            if username == acting_user {
                return Err(UserError::DeleteSelf.into());
            }
            if !users.contains_key(&username) {
                return Err(UserError::Unknown(username).into());
            }
            if users.len() == 1 {
                return Err(UserError::DeleteLast.into());
            }
            users.remove(&username);
        }
        self.persist().await
    }

    pub async fn set_password(
        &self,
        username: &str,
        password: &str,
        password_confirm: &str,
    ) -> Result<()> {
        let username = normalize_username(username);
        validate_operator_password(password, password_confirm)
            .map_err(|e| UserError::Invalid(e.to_string()))?;
        {
            let mut users = self.inner.users.write().await;
            let user = users
                .get_mut(&username)
                .ok_or(UserError::Unknown(username.clone()))?;
            user.password_hash = hash_password(password);
            // Any successful change means the account now runs on a password
            // someone deliberately set — the provisioning flag has done its job.
            user.must_change_password = false;
        }
        if username == DEMO_USERNAME {
            // The complexity rule makes literal "admin" unreachable here.
            *self.inner.demo_password_active.write().await = false;
        }
        self.persist().await
    }

    async fn persist(&self) -> Result<()> {
        let users = self.inner.users.read().await.clone();
        let file = UsersFile { version: 1, users };
        let bytes = serde_json::to_vec_pretty(&file)?;
        write_atomic(&self.inner.path, &bytes)
            .await
            .with_context(|| format!("persist {}", self.inner.path.display()))
    }
}

fn normalize_username(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

fn validate_username(username: &str) -> Result<String> {
    let username = normalize_username(username);
    if username.is_empty() || username.len() > MAX_USERNAME_LEN {
        return Err(UserError::Invalid(format!(
            "username must be 1-{MAX_USERNAME_LEN} characters"
        ))
        .into());
    }
    if !username
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        return Err(UserError::Invalid("username must start with a letter or digit".into()).into());
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return Err(UserError::Invalid(
            "username may only contain lowercase letters, digits, '.', '_', and '-'".into(),
        )
        .into());
    }
    Ok(username)
}

/// Valid-format hash of a random string, used to equalize timing for unknown
/// usernames. Computed once per process.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password(&uuid::Uuid::new_v4().to_string()))
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

    fn temp_path(name: &str) -> PathBuf {
        // Unique directory per test: loads with no initial password write
        // initial-admin-password.txt next to users.json, and parallel tests
        // sharing one temp dir would race on that file.
        let dir = std::env::temp_dir().join(format!(
            "cdk-branch-users-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir.join("users.json")
    }

    #[tokio::test]
    async fn seeds_random_admin_and_persists() {
        let path = temp_path("seed");
        let secret_path = path.parent().unwrap().join("initial-admin-password.txt");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        // First boot without INITIAL_ADMIN_PASSWORD: a random credential the
        // demo password must NOT match, persisted to a 0600 file.
        assert!(!store.verify(DEMO_USERNAME, DEMO_PASSWORD).await);
        assert!(!store.verify(DEMO_USERNAME, "wrong").await);
        assert!(!store.verify("nobody", DEMO_PASSWORD).await);
        assert!(!store.demo_password_active().await);
        assert!(!store.must_change_password(DEMO_USERNAME).await);
        let users = store.list().await;
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, DEMO_USERNAME);
        assert_eq!(users[0].role.as_deref(), Some("admin"));
        assert!(store.is_admin(DEMO_USERNAME).await);
        let secret = tokio::fs::read_to_string(&secret_path).await.expect("secret file");
        assert!(store.verify(DEMO_USERNAME, secret.trim()).await);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = tokio::fs::metadata(&secret_path)
                .await
                .expect("secret metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Reload uses the persisted file, not reseeding.
        let reloaded = UserStore::load(path.clone(), None, None)
            .await
            .expect("reload");
        assert!(reloaded.verify(DEMO_USERNAME, secret.trim()).await);
        assert_eq!(reloaded.list().await.len(), 1);
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(&secret_path).await;
    }

    #[tokio::test]
    async fn migration_reuses_legacy_hash() {
        let path = temp_path("migrate");
        let legacy = hash_password("Old-passw0rd!");
        let store = UserStore::load(path.clone(), Some(legacy), None)
            .await
            .expect("load");
        assert!(store.verify("admin", "Old-passw0rd!").await);
        assert!(!store.verify("admin", DEMO_PASSWORD).await);
        assert!(!store.demo_password_active().await);
        // Once the file exists, a later legacy hash is ignored.
        let again = UserStore::load(path.clone(), Some(hash_password("Other-pass-2!")), None)
            .await
            .expect("reload");
        assert!(again.verify("admin", "Old-passw0rd!").await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn create_validates_and_rejects_duplicates() {
        let path = temp_path("create");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        assert!(store.create("teller1", "weak", "weak").await.is_err());
        assert!(store
            .create("Bad Name!", "Te11er-pass!", "Te11er-pass!")
            .await
            .is_err());
        store
            .create("Teller1", "Te11er-pass!", "Te11er-pass!")
            .await
            .expect("create");
        assert!(store.verify("teller1", "Te11er-pass!").await);
        let err = store
            .create("teller1", "Te11er-pass!", "Te11er-pass!")
            .await
            .expect_err("duplicate");
        assert!(matches!(
            err.downcast_ref::<UserError>(),
            Some(UserError::Duplicate(_))
        ));
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn delete_guards_self_and_last_user() {
        let path = temp_path("delete");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        let err = store.delete("admin", "admin").await.expect_err("self");
        assert!(matches!(
            err.downcast_ref::<UserError>(),
            Some(UserError::DeleteSelf)
        ));
        store
            .create("teller1", "Te11er-pass!", "Te11er-pass!")
            .await
            .expect("create");
        store.delete("teller1", "admin").await.expect("delete");
        let err = store.delete("teller1", "admin").await.expect_err("unknown");
        assert!(matches!(
            err.downcast_ref::<UserError>(),
            Some(UserError::Unknown(_))
        ));
        // admin is now the last user; another session cannot delete it either.
        let err = store
            .delete("admin", "someone-else")
            .await
            .expect_err("last");
        assert!(matches!(
            err.downcast_ref::<UserError>(),
            Some(UserError::DeleteLast)
        ));
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn password_change_updates_credential_and_keeps_role() {
        let path = temp_path("password");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        assert!(store.set_password("admin", "weak", "weak").await.is_err());
        store
            .set_password("admin", "Str0ng-pass-9!", "Str0ng-pass-9!")
            .await
            .expect("change");
        assert!(!store.demo_password_active().await);
        assert!(!store.verify("admin", DEMO_PASSWORD).await);
        assert!(store.verify("admin", "Str0ng-pass-9!").await);
        assert!(store.is_admin("admin").await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn corrupt_file_is_quarantined_and_reseeded() {
        let path = temp_path("quarantine");
        tokio::fs::write(&path, b"{ not json").await.expect("write");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        let users = store.list().await;
        assert_eq!(users.len(), 1, "reseeds a single admin after quarantine");
        assert_eq!(users[0].role.as_deref(), Some("admin"));
        assert!(!store.verify(DEMO_USERNAME, DEMO_PASSWORD).await);
        let stem = path
            .file_stem()
            .and_then(|n| n.to_str())
            .expect("stem")
            .to_string();
        let dir = path.parent().expect("parent");
        let mut found_quarantine = false;
        let mut entries = tokio::fs::read_dir(dir).await.expect("read dir");
        while let Some(entry) = entries.next_entry().await.expect("entry") {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&stem) && name.contains(".json.corrupt-") {
                found_quarantine = true;
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
        assert!(found_quarantine, "expected a quarantined corrupt file");
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn initial_password_seeds_admin_without_forced_change() {
        let path = temp_path("initial");
        let store = UserStore::load(path.clone(), None, Some("installer-secret".into()))
            .await
            .expect("load");
        assert!(store.verify(DEMO_USERNAME, "installer-secret").await);
        assert!(!store.verify(DEMO_USERNAME, DEMO_PASSWORD).await);
        assert!(!store.demo_password_active().await);
        // The deployer explicitly chose this password: no forced change.
        assert!(!store.must_change_password(DEMO_USERNAME).await);
        assert!(store.is_admin(DEMO_USERNAME).await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn forced_change_survives_reload_and_clears_on_set_password() {
        let path = temp_path("must-change");
        // Seed the flag directly: no current boot path sets it, but the
        // mechanism (persisted flag gates the console until cleared) must
        // survive restarts for accounts provisioned with it.
        let file = UsersFile {
            version: 1,
            users: [(
                DEMO_USERNAME.to_string(),
                UserRecord {
                    username: DEMO_USERNAME.to_string(),
                    password_hash: hash_password("Provisioned-1!"),
                    created_at: unix_now(),
                    must_change_password: true,
                    role: Some("admin".into()),
                },
            )]
            .into_iter()
            .collect(),
        };
        tokio::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap())
            .await
            .expect("write");
        let reloaded = UserStore::load(path.clone(), None, None).await.expect("reload");
        assert!(reloaded.must_change_password(DEMO_USERNAME).await);
        reloaded
            .set_password(DEMO_USERNAME, "Chosen-pass-1!", "Chosen-pass-1!")
            .await
            .expect("change");
        assert!(!reloaded.must_change_password(DEMO_USERNAME).await);
        drop(reloaded);
        let again = UserStore::load(path.clone(), None, None).await.expect("reload");
        assert!(!again.must_change_password(DEMO_USERNAME).await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn demo_and_legacy_seeds_do_not_force_a_change() {
        let path = temp_path("no-force-demo");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        assert!(!store.must_change_password(DEMO_USERNAME).await);
        let _ = tokio::fs::remove_file(&path).await;

        let path = temp_path("no-force-legacy");
        let legacy = hash_password("Old-passw0rd!");
        let store = UserStore::load(path.clone(), Some(legacy), None)
            .await
            .expect("load");
        assert!(!store.must_change_password(DEMO_USERNAME).await);
        assert!(!store.must_change_password("unknown-user").await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn legacy_hash_wins_over_initial_password() {
        let path = temp_path("initial-vs-legacy");
        let legacy = hash_password("Old-passw0rd!");
        let store = UserStore::load(path.clone(), Some(legacy), Some("installer-secret".into()))
            .await
            .expect("load");
        assert!(store.verify("admin", "Old-passw0rd!").await);
        assert!(!store.verify("admin", "installer-secret").await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn existing_store_ignores_initial_password() {
        let path = temp_path("initial-ignored");
        let store = UserStore::load(path.clone(), None, None).await.expect("load");
        store
            .set_password("admin", "Chosen-pass-1!", "Chosen-pass-1!")
            .await
            .expect("change");
        drop(store);
        let reloaded = UserStore::load(path.clone(), None, Some("installer-secret".into()))
            .await
            .expect("reload");
        assert!(reloaded.verify("admin", "Chosen-pass-1!").await);
        assert!(!reloaded.verify("admin", "installer-secret").await);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn short_initial_password_fails_the_boot_without_writing() {
        let path = temp_path("initial-short");
        let err = match UserStore::load(path.clone(), None, Some("short".into())).await {
            Ok(_) => panic!("must refuse a short initial password"),
            Err(err) => err,
        };
        assert!(err
            .to_string()
            .contains("CDK_BRANCH_PROCESSOR_INITIAL_ADMIN_PASSWORD"));
        assert!(!tokio::fs::try_exists(&path).await.unwrap_or(true));
    }

    #[tokio::test]
    async fn corrupt_file_reseeds_from_the_initial_password() {
        let path = temp_path("quarantine-initial");
        tokio::fs::write(&path, b"{ not json").await.expect("write");
        let store = UserStore::load(path.clone(), None, Some("installer-secret".into()))
            .await
            .expect("load");
        assert!(store.verify(DEMO_USERNAME, "installer-secret").await);
        assert!(!store.demo_password_active().await);
        let dir = path.parent().expect("parent");
        let stem = path
            .file_stem()
            .and_then(|n| n.to_str())
            .expect("stem")
            .to_string();
        let mut entries = tokio::fs::read_dir(dir).await.expect("read dir");
        while let Some(entry) = entries.next_entry().await.expect("entry") {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&stem) && name.contains(".json.corrupt-") {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
        let _ = tokio::fs::remove_file(&path).await;
    }
}
