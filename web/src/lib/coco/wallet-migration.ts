// One-time migration for wallets whose state predates the {currency}/v1
// path convention: every coco IndexedDB store is keyed by mint URL, and
// the legacy EUR mint lived at the origin root — a URL that now 404s.
// Without this, pre-migration browsers show a zero balance, restore
// pending cards that can never resolve, and would re-derive output
// secrets from counter 0 (already spent under the old URL).
//
// Re-keying follows coco's own schema-upgrade pattern (delete old key,
// insert new) because IndexedDB primary keys — several of them compound
// with mintUrl — cannot be mutated in place.

const MIGRATION_FLAG = "pecan-minturl-migrated-v1"

const STORES = [
  "coco_cashu_mints",
  "coco_cashu_keysets",
  "coco_cashu_counters",
  "coco_cashu_proofs",
  "coco_cashu_mint_quotes",
  "coco_cashu_melt_quotes",
  "coco_cashu_history",
  "coco_cashu_mint_operations",
  "coco_cashu_melt_operations",
] as const

/**
 * New primary key for a row moving `from` → `to`, or null when the key
 * does not embed the legacy URL (the row only needs its mintUrl field
 * updated in place).
 */
export function remapKey(
  key: unknown,
  from: string,
  to: string,
): unknown | null {
  if (key === from) return to
  if (Array.isArray(key) && key[0] === from) return [to, ...key.slice(1)]
  return null
}

/** Counters must never move backwards — secret derivation depends on them. */
function mergeCounterValue(
  existing: { counter?: number } | undefined,
  migrated: { counter?: number },
): number {
  return Math.max(existing?.counter ?? 0, migrated.counter ?? 0)
}

async function migrateStore(
  db: IDBDatabase,
  storeName: string,
  from: string,
  to: string,
): Promise<number> {
  const tx = db.transaction(storeName, "readwrite")
  const store = tx.objectStore(storeName)
  const rows: Array<{ key: IDBValidKey; value: Record<string, unknown> }> =
    await new Promise((resolve, reject) => {
      const out: typeof rows = []
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return resolve(out)
        const value = cursor.value as Record<string, unknown>
        if (value?.mintUrl === from || cursor.key === from) {
          out.push({ key: cursor.key, value })
        }
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })

  for (const { key, value } of rows) {
    const nextKey = remapKey(key, from, to)
    const nextValue = { ...value, mintUrl: to }
    if (nextKey === null) {
      // mintUrl is not part of the primary key — in-place update
      store.put(nextValue, key)
    } else {
      const clash = await new Promise<boolean>((resolve) => {
        const g = store.getKey(nextKey as IDBValidKey)
        g.onsuccess = () => resolve(g.result !== undefined)
        g.onerror = () => resolve(false)
      })
      if (clash && storeName === "coco_cashu_counters") {
        const existing = await new Promise<{ counter?: number } | undefined>(
          (resolve) => {
            const g = store.get(nextKey as IDBValidKey)
            g.onsuccess = () => resolve(g.result)
            g.onerror = () => resolve(undefined)
          },
        )
        store.put(
          {
            ...nextValue,
            counter: mergeCounterValue(existing, nextValue as { counter?: number }),
          },
          nextKey as IDBValidKey,
        )
      } else if (!clash) {
        store.put(nextValue, nextKey as IDBValidKey)
      }
      // on clash (non-counter): the row already exists under the new URL —
      // keep it, just drop the legacy copy
      store.delete(key)
    }
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  return rows.length
}

/**
 * Re-keys all legacy-URL rows to the target URL. Runs at most once per
 * browser (localStorage flag); safe to call on every boot.
 */
export async function migrateLegacyMintUrls(
  legacyUrl: string,
  targetUrl: string,
): Promise<void> {
  if (typeof window === "undefined") return
  if (window.localStorage.getItem(MIGRATION_FLAG)) return
  window.localStorage.setItem(MIGRATION_FLAG, "1")
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("giftcard-coco-wallet")
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      let moved = 0
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) continue
        moved += await migrateStore(db, name, legacyUrl, targetUrl)
      }
      if (moved > 0) {
        console.info(
          `[pecan] migrated ${moved} rows from legacy mint URL ${legacyUrl} to ${targetUrl}`,
        )
      }
    } finally {
      db.close()
    }
  } catch {
    // fresh wallet (no DB yet) or transient access — nothing to migrate
  }
}
