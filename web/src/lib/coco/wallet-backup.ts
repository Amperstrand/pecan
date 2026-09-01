// Wallet backup: the JSON dump is the wallet's seed plus EVERY IndexedDB
// store coco's schema defines (v2; v1 carried only the four money stores —
// its dumps still parse). Serialization is type-tagged so Uint8Array and
// Date values survive the JSON round-trip unambiguously — plain number
// arrays stay arrays, byte arrays and dates come back as themselves.
//
// Import semantics: clear() then put() through a raw connection opened
// next to coco's Dexie connection. deleteDatabase is NOT used — an open
// Dexie connection blocks it (the dev-tools force-clear only works
// because the page reloads straight after). Known stores use in-line
// keys ([mintUrl+secret], id, ++id), so put() restores rows with their
// original keys intact; stores the running schema does not know are
// skipped.

import { activeCurrency, mintUrl } from "./currency"
import { getCoco, SEED_STORAGE_KEY } from "./coco-wallet"

export interface WalletDump {
  formatVersion: 2
  exportedAt: string
  unit: string
  seed: string | null
  mintUrl: string
  stores: Record<string, Array<Record<string, unknown>>>
}

/** A dump proven to carry a seed — only these can be restored. */
export type RestorableDump = WalletDump & { seed: string }

const V1_STORE_KEYS = [
  ["proofs", "coco_cashu_proofs"],
  ["mintOperations", "coco_cashu_mint_operations"],
  ["meltOperations", "coco_cashu_melt_operations"],
  ["history", "coco_cashu_history"],
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isByteList(value: unknown[]): boolean {
  return value.every(
    (n) =>
      typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255,
  )
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __u8: Array.from(value) }
  if (value instanceof Date) return { __date: value.toISOString() }
  if (Array.isArray(value)) return value.map(serializeValue)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v)
    return out
  }
  return value
}

function reviveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveValue)
  if (isRecord(value)) {
    if (Array.isArray(value.__u8) && isByteList(value.__u8)) {
      return Uint8Array.from(value.__u8)
    }
    if (typeof value.__date === "string") return new Date(value.__date)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = reviveValue(v)
    return out
  }
  return value
}

export function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = serializeValue(v)
  return out
}

export function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = reviveValue(v)
  return out
}

export async function exportWalletDump(): Promise<WalletDump> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("giftcard-coco-wallet")
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const stores: Record<string, Array<Record<string, unknown>>> = {}
  for (const store of Array.from(db.objectStoreNames)) {
    stores[store] = await new Promise<Array<Record<string, unknown>>>(
      (resolve) => {
        const tx = db.transaction(store, "readonly")
        const req = tx.objectStore(store).getAll()
        req.onsuccess = () =>
          resolve(
            (req.result as Array<Record<string, unknown>>).map(serializeRow),
          )
        req.onerror = () => resolve([])
      },
    )
  }
  db.close()
  return {
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
    unit: activeCurrency(),
    seed: window.localStorage.getItem(SEED_STORAGE_KEY),
    mintUrl: mintUrl(),
    stores,
  }
}

export function downloadWalletDump(dump: WalletDump): void {
  const blob = new Blob([JSON.stringify(dump, null, 2)], {
    type: "application/json",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `giftcard-wallet-dump-${dump.exportedAt.replace(/[:.]/g, "-")}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function isRowList(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord)
}

/**
 * Parses an untrusted backup file into a typed value. Accepts v2 dumps
 * (stores map) and v1 dumps (the four money-store fields). Throws Error
 * with an operator-readable message when the file is not restorable.
 */
export function parseWalletDump(raw: unknown): RestorableDump {
  if (!isRecord(raw)) {
    throw new Error("this file is not a wallet backup")
  }
  const { exportedAt, unit, seed, mintUrl: dumpMintUrl } = raw
  if (typeof exportedAt !== "string") {
    throw new Error("backup is missing its export timestamp")
  }
  if (typeof unit !== "string" || typeof dumpMintUrl !== "string") {
    throw new Error("backup is missing its mint information")
  }
  if (typeof seed !== "string" || !/^[0-9a-f]{128}$/.test(seed)) {
    throw new Error("backup has no wallet seed — export a new backup instead")
  }
  const header = { exportedAt, unit, seed, mintUrl: dumpMintUrl }
  if (raw.formatVersion === 2 || isRecord(raw.stores)) {
    if (!isRecord(raw.stores)) {
      throw new Error("backup has a stores field that is not an object")
    }
    const stores: Record<string, Array<Record<string, unknown>>> = {}
    for (const [store, rows] of Object.entries(raw.stores)) {
      if (!isRowList(rows)) {
        throw new Error(`backup store ${store} does not hold records`)
      }
      stores[store] = rows
    }
    if (stores["coco_cashu_proofs"] === undefined) {
      throw new Error("backup has no proofs store — nothing to restore")
    }
    return { formatVersion: 2, ...header, stores }
  }
  const stores: Record<string, Array<Record<string, unknown>>> = {}
  for (const [key, store] of V1_STORE_KEYS) {
    const rows = raw[key]
    if (!isRowList(rows)) {
      throw new Error(`backup is missing its ${key} records`)
    }
    stores[store] = rows
  }
  return { formatVersion: 2, ...header, stores }
}

/**
 * Replaces this browser's wallet state with the dump's: every store the
 * dump carries and the running schema knows is cleared and re-filled,
 * and the seed is overwritten. The page must reload afterwards — the
 * running wallet still holds the old state.
 */
export async function importWalletDump(dump: RestorableDump): Promise<void> {
  // Guarantees the Dexie schema exists before the raw connection looks
  // for its stores (a restore into a never-opened wallet would otherwise
  // find an empty database).
  await getCoco()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("giftcard-coco-wallet")
    req.onsuccess = () => {
      const db = req.result
      const storeNames = Object.keys(dump.stores).filter((store) =>
        db.objectStoreNames.contains(store),
      )
      if (!storeNames.includes("coco_cashu_proofs")) {
        db.close()
        reject(new Error("wallet storage has no proofs store to restore into"))
        return
      }
      const tx = db.transaction(storeNames, "readwrite")
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error ?? new Error("restore transaction failed"))
      }
      tx.onabort = () => {
        db.close()
        reject(tx.error ?? new Error("restore transaction aborted"))
      }
      for (const store of storeNames) {
        const os = tx.objectStore(store)
        os.clear()
        for (const row of dump.stores[store] ?? []) {
          os.put(reviveRow(row))
        }
      }
    }
    req.onerror = () => reject(req.error ?? new Error("wallet storage did not open"))
  })
  window.localStorage.setItem(SEED_STORAGE_KEY, dump.seed)
}
