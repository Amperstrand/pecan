//! Read-only supply audit against the mint's own database.
//!
//! The circulation numbers the ticket ledger can produce (settled deposits
//! minus settled payouts) drift from redeemable reality: ecash under a keyset
//! that passed its final expiry is demonetized, swap fees burn value, and a
//! paid quote is not always minted. The mint keeps the exact per-keyset truth
//! in its `keyset_amounts` table (issued / redeemed / fee_collected, updated
//! on every signature and spend), so this module reads that one table.
//!
//! This is the processor's single deliberate exception to "talk to the mint
//! only through its APIs": the pinned cdk exposes these numbers over no API
//! (the management RPC only returns unit-mixing global sums). The read is
//! enforced read-only at the connection level; the coupling surface is one
//! four-column table, revalidated whenever the pinned CDK rev is bumped (see
//! README, "CDK Version").

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::clients::KeysetEntry;

/// One row of the mint's `keyset_amounts` audit table.
#[derive(Debug, Clone)]
pub struct KeysetAmounts {
    pub keyset_id: String,
    pub issued: u64,
    pub redeemed: u64,
    pub fee_collected: u64,
}

/// Redeemable-supply figures for one unit, split by keyset expiry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitSupply {
    pub unit: String,
    /// Outstanding ecash under keysets that can still be redeemed.
    pub live: u64,
    /// Outstanding ecash under keysets past their final expiry — issued,
    /// never redeemed, and no longer redeemable.
    pub demonetized: u64,
    /// Value burned as swap/melt input fees across the unit's keysets.
    pub fee_collected: u64,
}

/// Reads the mint's `keyset_amounts` table. `None` path = auditing disabled
/// (e.g. a local rig without access to the mint's work dir).
#[derive(Clone)]
pub struct SupplyReader {
    path: Option<Arc<PathBuf>>,
}

impl SupplyReader {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path: path.map(Arc::new),
        }
    }

    /// Fetch the audit rows. `Ok(None)` means "no data, not an error": either
    /// auditing is disabled or the mint has not created its database yet
    /// (first boot). Errors are real read failures worth surfacing.
    pub async fn read(&self) -> Result<Option<Vec<KeysetAmounts>>> {
        let Some(path) = self.path.clone() else {
            return Ok(None);
        };
        if !tokio::fs::try_exists(path.as_ref()).await.unwrap_or(false) {
            return Ok(None);
        }
        let rows = tokio::task::spawn_blocking(move || read_keyset_amounts(&path))
            .await
            .context("supply reader task")??;
        Ok(Some(rows))
    }
}

fn read_keyset_amounts(path: &Path) -> Result<Vec<KeysetAmounts>> {
    use rusqlite::{Connection, OpenFlags};

    // Read-only at the sqlite level. The database runs in WAL mode, so the
    // filesystem must still be writable (readers maintain the shared WAL
    // index); the connection itself cannot modify the database.
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open mint db {}", path.display()))?;
    conn.busy_timeout(Duration::from_millis(1500))?;
    conn.pragma_update(None, "query_only", true)?;

    let mut stmt = conn.prepare(
        "SELECT keyset_id, total_issued, total_redeemed, fee_collected FROM keyset_amounts",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KeysetAmounts {
                keyset_id: row.get::<_, String>(0)?,
                issued: row.get::<_, i64>(1)?.max(0) as u64,
                redeemed: row.get::<_, i64>(2)?.max(0) as u64,
                fee_collected: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Join the audit rows against the mint's keyset listing (which includes
/// expired keysets) and split each unit's outstanding ecash into live and
/// demonetized. Audit rows for keysets absent from the listing (only Auth
/// keysets, which live in a separate database anyway) are ignored.
pub fn per_unit_supply(
    rows: &[KeysetAmounts],
    keysets: &[KeysetEntry],
    now: u64,
) -> Vec<UnitSupply> {
    use std::collections::BTreeMap;

    let by_keyset: BTreeMap<String, &KeysetAmounts> = rows
        .iter()
        .map(|row| (row.keyset_id.to_ascii_lowercase(), row))
        .collect();

    let mut units: BTreeMap<String, UnitSupply> = BTreeMap::new();
    for keyset in keysets {
        let entry = units
            .entry(keyset.unit.clone())
            .or_insert_with(|| UnitSupply {
                unit: keyset.unit.clone(),
                live: 0,
                demonetized: 0,
                fee_collected: 0,
            });
        let Some(row) = by_keyset.get(&keyset.id.to_ascii_lowercase()) else {
            continue;
        };
        let outstanding = row.issued.saturating_sub(row.redeemed);
        let expired = keyset.final_expiry.is_some_and(|expiry| expiry <= now);
        if expired {
            entry.demonetized = entry.demonetized.saturating_add(outstanding);
        } else {
            entry.live = entry.live.saturating_add(outstanding);
        }
        entry.fee_collected = entry.fee_collected.saturating_add(row.fee_collected);
    }
    units.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyset(id: &str, unit: &str, final_expiry: Option<u64>) -> KeysetEntry {
        KeysetEntry {
            id: id.to_string(),
            unit: unit.to_string(),
            active: final_expiry.is_none(),
            input_fee_ppk: 0,
            final_expiry,
        }
    }

    fn row(id: &str, issued: u64, redeemed: u64, fee: u64) -> KeysetAmounts {
        KeysetAmounts {
            keyset_id: id.to_string(),
            issued,
            redeemed,
            fee_collected: fee,
        }
    }

    #[test]
    fn splits_live_and_demonetized_per_unit() {
        let now = 1_000_000;
        let keysets = vec![
            keyset("00AAAA", "ora", Some(now - 1)), // expired
            keyset("00bbbb", "ora", Some(now + 1)), // still redeemable
            keyset("00cccc", "ora", None),          // active, no expiry
            keyset("00dddd", "usd", Some(now + 5)),
        ];
        let rows = vec![
            row("00aaaa", 1000, 400, 3), // 600 died with the keyset (id case differs)
            row("00bbbb", 500, 100, 2),
            row("00cccc", 250, 0, 0),
            row("00dddd", 80, 90, 1), // redeemed > issued must not underflow
        ];

        let supply = per_unit_supply(&rows, &keysets, now);
        assert_eq!(
            supply,
            vec![
                UnitSupply {
                    unit: "ora".into(),
                    live: 650,
                    demonetized: 600,
                    fee_collected: 5,
                },
                UnitSupply {
                    unit: "usd".into(),
                    live: 0,
                    demonetized: 0,
                    fee_collected: 1,
                },
            ]
        );
    }

    #[test]
    fn keysets_without_audit_rows_count_zero() {
        let supply = per_unit_supply(&[], &[keyset("00eeee", "ora", None)], 0);
        assert_eq!(
            supply,
            vec![UnitSupply {
                unit: "ora".into(),
                live: 0,
                demonetized: 0,
                fee_collected: 0,
            }]
        );
    }

    #[tokio::test]
    async fn reads_fixture_database_and_tolerates_absence() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("supply-test-{}.sqlite", uuid::Uuid::new_v4()));

        // absent file → Ok(None), not an error (mint may not have booted yet)
        let reader = SupplyReader::new(Some(path.clone()));
        assert!(reader.read().await.unwrap().is_none());

        // disabled reader → Ok(None)
        assert!(SupplyReader::new(None).read().await.unwrap().is_none());

        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE keyset_amounts (
                    keyset_id TEXT PRIMARY KEY NOT NULL,
                    total_issued INTEGER NOT NULL DEFAULT 0,
                    total_redeemed INTEGER NOT NULL DEFAULT 0,
                    fee_collected INTEGER NOT NULL DEFAULT 0
                 );
                 INSERT INTO keyset_amounts VALUES ('00abcd', 700, 200, 4);",
            )
            .unwrap();
        }

        let rows = reader.read().await.unwrap().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].keyset_id, "00abcd");
        assert_eq!(rows[0].issued, 700);
        assert_eq!(rows[0].redeemed, 200);
        assert_eq!(rows[0].fee_collected, 4);

        let _ = std::fs::remove_file(&path);
    }
}
