//! Persistent login sessions.
//!
//! Config changes restart the whole process (persist + exit + docker restart);
//! keeping sessions in a file means operators stay signed in across those
//! restarts. A corrupt or missing file is harmless — everyone just signs in
//! again — so loading is parse-or-default (unlike the tickets store, which
//! quarantines an unreadable file because it is a settlement record). Writes
//! are whole-file atomic (tmp + rename): a login racing the 900 ms restart
//! window either fully persists or is simply lost, never torn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::write_atomic;

pub const SESSION_TTL_SECS: u64 = 12 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub username: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    sessions: HashMap<String, Session>,
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: RwLock<HashMap<String, Session>>,
    path: PathBuf,
}

impl SessionStore {
    pub async fn load(path: PathBuf) -> Result<Self> {
        let mut sessions = HashMap::new();
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            match tokio::fs::read(&path).await {
                Ok(raw) => match serde_json::from_slice::<SessionsFile>(&raw) {
                    Ok(file) => sessions = file.sessions,
                    Err(e) => {
                        tracing::warn!(
                            "could not parse {} ({e}); starting with no sessions",
                            path.display()
                        );
                    }
                },
                Err(e) => {
                    tracing::warn!(
                        "could not read {} ({e}); starting with no sessions",
                        path.display()
                    );
                }
            }
        }
        let now = unix_now();
        sessions.retain(|_, session| session.expires_at > now);
        let store = Self {
            inner: Arc::new(Inner {
                sessions: RwLock::new(sessions),
                path,
            }),
        };
        store.persist().await;
        Ok(store)
    }

    pub async fn insert(&self, session_id: &str, username: &str) -> Session {
        let now = unix_now();
        let session = Session {
            username: username.to_string(),
            created_at: now,
            expires_at: now + SESSION_TTL_SECS,
        };
        {
            let mut sessions = self.inner.sessions.write().await;
            // Opportunistic prune bounds file growth without a sweeper task.
            sessions.retain(|_, existing| existing.expires_at > now);
            sessions.insert(session_id.to_string(), session.clone());
        }
        self.persist().await;
        session
    }

    /// Resolve a session id to its username, lazily removing it once expired.
    pub async fn username_for(&self, session_id: &str) -> Option<String> {
        let now = unix_now();
        let expired = {
            let sessions = self.inner.sessions.read().await;
            match sessions.get(session_id) {
                Some(session) if session.expires_at > now => return Some(session.username.clone()),
                Some(_) => true,
                None => return None,
            }
        };
        if expired {
            self.inner.sessions.write().await.remove(session_id);
            self.persist().await;
        }
        None
    }

    pub async fn remove(&self, session_id: &str) {
        let removed = self.inner.sessions.write().await.remove(session_id);
        if removed.is_some() {
            self.persist().await;
        }
    }

    /// Drop every session belonging to `username`, except an optional survivor
    /// (the caller's own session on a self password change).
    pub async fn remove_for_user(&self, username: &str, keep: Option<&str>) {
        {
            let mut sessions = self.inner.sessions.write().await;
            sessions.retain(|sid, session| {
                session.username != username || keep.is_some_and(|k| k == sid)
            });
        }
        self.persist().await;
    }

    /// Best-effort persistence: an auth-path cleanup must never fail a read
    /// because the disk write did.
    async fn persist(&self) {
        let sessions = self.inner.sessions.read().await.clone();
        let file = SessionsFile {
            version: 1,
            sessions,
        };
        let bytes = match serde_json::to_vec_pretty(&file) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!("serialize sessions: {e}");
                return;
            }
        };
        if let Err(e) = write_atomic(&self.inner.path, &bytes).await {
            tracing::warn!("persist {}: {e}", self.inner.path.display());
        }
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

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cdk-branch-sessions-{name}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    #[tokio::test]
    async fn sessions_survive_a_reload() {
        let path = temp_path("roundtrip");
        let store = SessionStore::load(path.clone()).await.expect("load");
        store.insert("sid-1", "admin").await;
        drop(store);
        let reloaded = SessionStore::load(path.clone()).await.expect("reload");
        assert_eq!(
            reloaded.username_for("sid-1").await.as_deref(),
            Some("admin")
        );
        assert_eq!(reloaded.username_for("sid-unknown").await, None);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn expired_sessions_are_pruned_on_load() {
        let path = temp_path("prune");
        let file = SessionsFile {
            version: 1,
            sessions: HashMap::from([(
                "sid-old".to_string(),
                Session {
                    username: "admin".to_string(),
                    created_at: 1,
                    expires_at: 2,
                },
            )]),
        };
        tokio::fs::write(&path, serde_json::to_vec(&file).expect("ser"))
            .await
            .expect("write");
        let store = SessionStore::load(path.clone()).await.expect("load");
        assert_eq!(store.username_for("sid-old").await, None);
        let _ = tokio::fs::remove_file(&path).await;
    }

    #[tokio::test]
    async fn remove_for_user_keeps_the_designated_session() {
        let path = temp_path("keep");
        let store = SessionStore::load(path.clone()).await.expect("load");
        store.insert("sid-a", "admin").await;
        store.insert("sid-b", "admin").await;
        store.insert("sid-c", "teller").await;
        store.remove_for_user("admin", Some("sid-a")).await;
        assert_eq!(store.username_for("sid-a").await.as_deref(), Some("admin"));
        assert_eq!(store.username_for("sid-b").await, None);
        assert_eq!(store.username_for("sid-c").await.as_deref(), Some("teller"));
        store.remove_for_user("teller", None).await;
        assert_eq!(store.username_for("sid-c").await, None);
        let _ = tokio::fs::remove_file(&path).await;
    }
}
