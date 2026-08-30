import { Amount } from "@cashu/cashu-ts"
import { initializeCoco, type HistoryEntry, type Manager } from "@cashu/coco-core"
import { IndexedDbRepositories } from "@cashu/coco-indexeddb"

import { MINT_URL, UNIT, type DepositMethod } from "./branch-methods"
import type { CoreEvents } from "@cashu/coco-core"
import { subscribeWalletLogging, walletLog } from "./wallet-log"

export type { DepositMethod }
import { MeltBranchHandler } from "./melt-branch-handler"
import { MintBranchHandler } from "./mint-branch-handler"

export interface HistoryRow {
  id?: number
  type: "deposit" | "withdraw"
  amount: number
  description: string
  created_at: number
  pending?: boolean
}

export interface DepositQuote {
  method: DepositMethod
  quoteId: string
  tail: string
  /** branch: the MINT- ticket id; ln: the bolt11 invoice; btc: the address. */
  request: string
  amount: number
  /** btc: the sats the payer must send, from the processor via extra. */
  expectedSat?: number
}

export interface WithdrawResult {
  quoteId: string
  tail: string
  amount: number
  submitted: boolean
}

const SEED_STORAGE_KEY = "giftcard-coco-seed-v1"

let cocoInstance: Promise<Manager> | null = null

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function fromHex(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  return arr
}

function loadSeed(): Uint8Array {
  const stored = window.localStorage.getItem(SEED_STORAGE_KEY)
  if (stored && stored.length === 128) {
    return fromHex(stored)
  }
  const seed = new Uint8Array(64)
  crypto.getRandomValues(seed)
  window.localStorage.setItem(SEED_STORAGE_KEY, toHex(seed))
  return seed
}

export function getCoco(): Promise<Manager> {
  if (cocoInstance === null) {
    cocoInstance = (async () => {
      const repo = new IndexedDbRepositories({ name: "giftcard-coco-wallet" })
      const coco = await initializeCoco({
        repo,
        seedGetter: () => Promise.resolve(loadSeed()),
      })
      coco.registerMeltMethod("branch", new MeltBranchHandler())
      coco.registerMintMethod("branch", new MintBranchHandler("branch", coco.keyRingService))
      coco.registerMintMethod("ln", new MintBranchHandler("ln", coco.keyRingService))
      coco.registerMintMethod("btc", new MintBranchHandler("btc", coco.keyRingService))
      subscribeWalletLogging(coco)
      await coco.mint.addMint(MINT_URL(), { trusted: true })
      return coco
    })()
  }
  return cocoInstance
}

export async function getBalanceCents(): Promise<number> {
  const coco = await getCoco()
  const balances = await coco.wallet.balances.byUnit({ mintUrls: [MINT_URL()] })
  const nok = balances[UNIT]
  return Number(nok?.spendable.toBigInt() ?? 0n)
}

export async function getHistory(limit = 15): Promise<HistoryRow[]> {
  const coco = await getCoco()
  const entries = await coco.history.getPaginatedHistory(0, limit)
  return entries.map(mapHistoryEntry).filter((row): row is HistoryRow => row !== null)
}

const STALE_AFTER_MS = 45 * 60 * 1000 // mint quotes expire at 30 min

export function mapHistoryEntry(entry: HistoryEntry): HistoryRow | null {
  const createdAt = entry.createdAt
  const stale = Date.now() - createdAt > STALE_AFTER_MS
  if (entry.type === "mint") {
    if (entry.state === "failed") return null
    return {
      type: "deposit",
      amount: Number(entry.amount.toBigInt()),
      description: stale && entry.state !== "finalized" ? "Expired" : "Deposit",
      created_at: createdAt,
      pending: entry.state !== "finalized" && !stale,
    }
  }
  if (entry.type === "melt") {
    return {
      type: "withdraw",
      amount: Number(entry.amount.toBigInt()),
      description: stale && entry.state !== "finalized" ? "Expired" : "Withdraw",
      created_at: createdAt,
      pending: entry.state !== "finalized" && !stale,
    }
  }
  return null
}

export async function createDepositQuote(
  amountInput: number,
  method: DepositMethod = "branch",
): Promise<DepositQuote> {
  const coco = await getCoco()
  const amount = Math.round(amountInput * 100)

  const quote = await coco.quotes.mint.create({
    mintUrl: MINT_URL(),
    method,
    amount: amount,
    unit: UNIT,
    description: "Wallet deposit",
    locked: true,
  })

  const operation = await coco.ops.mint.prepare({ quote, amount: amount })
  void coco.ops.mint.execute(operation.id).catch((err: unknown) => {
    console.warn("mint execute background:", err)
  })

  const expectedSat = (
    quote as { quoteData?: { expected_sat?: number } }
  ).quoteData?.expected_sat
  return {
    method,
    quoteId: quote.quoteId,
    tail: quote.quoteId.slice(-6).toUpperCase(),
    request: quote.request,
    amount,
    ...(expectedSat !== undefined ? { expectedSat } : {}),
  }
}

export async function pollAndMint(quoteId: string): Promise<boolean> {
  const coco = await getCoco()
  const operations = await coco.ops.mint.listByQuote({
    mintUrl: MINT_URL(),
    quoteId,
  })
  const operation = operations[0]
  if (!operation) return false
  if (operation.state === "finalized" || operation.state === "failed") return true

  try {
    const refreshed = await coco.ops.mint.refresh(operation.id)
    return refreshed.state === "finalized" || refreshed.state === "failed"
  } catch {
    // Lock contention with the background watcher or transient poll failure;
    // the watcher drives the operation to completion either way.
    return false
  }
}

export async function createWithdraw(amountInput: number, recipient: string): Promise<WithdrawResult> {
  const coco = await getCoco()
  const amount = Math.round(amountInput * 100)

  const quote = await coco.quotes.melt.create({
    mintUrl: MINT_URL(),
    method: "branch",
    methodData: { amount: Amount.from(amount), description: recipient },
    unit: UNIT,
  })

  const prepared = await coco.ops.melt.prepare({ quote })

  // The teller can only pay out once this wallet has locked funds at the
  // mint, so the code must not appear before that. The melt is async
  // (NUT-05 prefer_async): execute resolves as soon as the mint's setup
  // completes — inputs burned, quote PENDING — which IS the lock.
  const lockStarted = Date.now()
  const settled = await Promise.race([
    coco.ops.melt
      .execute(prepared.id)
      .then((op) => ({ state: op.state, error: null }))
      .catch((err: unknown) => ({ state: "error", error: String(err) })),
    new Promise<{ state: "timeout"; error: null }>((resolve) =>
      setTimeout(() => resolve({ state: "timeout", error: null }), 30_000),
    ),
  ])
  walletLog(
    settled.state === "error" || settled.state === "timeout" ? "warn" : "info",
    "withdraw fund-lock result",
    {
      quoteId: quote.quoteId,
      state: settled.state,
      waitedMs: Date.now() - lockStarted,
      error: settled.error,
    },
  )

  return {
    quoteId: quote.quoteId,
    tail: quote.quoteId.slice(-6).toUpperCase(),
    amount,
    submitted: true,
  }
}

export async function pollWithdraw(quoteId: string): Promise<string | null> {
  const coco = await getCoco()
  const operation = await coco.ops.melt.getByQuote({
    mintUrl: MINT_URL(),
    quoteId,
  })
  if (!operation) return null
  if (operation.state === "finalized") {
    return readPreimage(operation)
  }
  if (operation.state === "failed" || operation.state === "rolled_back") {
    return "FAILED"
  }

  try {
    const refreshed = await coco.ops.melt.refresh(operation.id)
    if (refreshed.state === "finalized") {
      return readPreimage(refreshed)
    }
  } catch {
    // Lock contention with the background watcher or transient poll failure;
    // the watcher drives the operation to completion either way.
  }
  return null
}

function readPreimage(operation: unknown): string {
  const finalized = operation as { finalizedData?: { preimage?: string } }
  return String(finalized.finalizedData?.preimage ?? "PAID")
}

export async function isWalletInitialized(): Promise<boolean> {
  return window.localStorage.getItem(SEED_STORAGE_KEY) !== null
}

const RESUME_POLL_MS = 3000
const RESUME_TIMEOUT_MS = 180_000

/**
 * After a page reload mid-operation, nothing polls the pending quotes: the
 * UI card state is gone and the settlement watcher's interests have no
 * active poll source. Prepared melt operations are stranded too — coco
 * leaves them for manual rollback, but the withdraw was already accepted
 * (the teller ticket waits on it), so execute them once and let the
 * settlement watcher drive the resulting operation. Terminal operations are
 * refreshed to completion; `onSettled` fires once anything settles so the
 * UI can reload balance and history.
 */
export async function resumePendingOperations(
  onSettled?: () => void,
): Promise<boolean> {
  const coco = await getCoco()
  const [melts, mints, preparedMelts] = await Promise.all([
    coco.ops.melt.listInFlight(),
    coco.ops.mint.listInFlight(),
    coco.ops.melt.listPrepared(),
  ])
  const pending: Array<{ id: string; kind: "melt" | "mint" | "prepared-melt" }> = [
    ...melts.map((op) => ({ id: op.id, kind: "melt" as const })),
    ...mints.map((op) => ({ id: op.id, kind: "mint" as const })),
  ]
  if (pending.length === 0 && preparedMelts.length === 0) return false

  for (const op of preparedMelts) {
    try {
      await coco.ops.melt.execute(op.id)
      walletLog("info", "resumed prepared melt executed", { opId: op.id })
    } catch {
      // Another driver may hold the operation lock, or the op moved on
      // already — the watcher owns it from here either way.
      walletLog("warn", "resumed prepared melt execute failed", { opId: op.id })
    }
  }

  await resumeStrandedWithdrawQuotes(coco, melts, preparedMelts)

  void (async () => {
    const deadline = Date.now() + RESUME_TIMEOUT_MS
    let settledAny = false
    while (pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS))
      for (const op of [...pending]) {
        try {
          const refreshed =
            op.kind === "melt"
              ? await coco.ops.melt.refresh(op.id)
              : await coco.ops.mint.refresh(op.id)
          if (
            refreshed.state === "finalized" ||
            refreshed.state === "failed" ||
            refreshed.state === "rolled_back"
          ) {
            pending.splice(pending.indexOf(op), 1)
            settledAny = true
          }
        } catch {
          // Lock contention with the background watcher or transient poll failure;
          // the watcher drives the operation to completion either way.
        }
      }
    }
    if (settledAny) onSettled?.()
  })()
  return true
}

/**
 * A page death between quote creation and prepare strands the quote with no
 * operation: the teller ticket waits forever on a fund lock that will never
 * come. Re-bind fresh stranded branch quotes to a new op and execute it —
 * the withdraw the user already accepted continues instead of silently
 * dying with the reload.
 */
async function resumeStrandedWithdrawQuotes(
  coco: Awaited<ReturnType<typeof getCoco>>,
  inFlight: Array<{ quoteId?: string }>,
  prepared: Array<{ quoteId?: string }>,
): Promise<void> {
  const known = new Set(
    [...inFlight, ...prepared]
      .map((op) => op.quoteId)
      .filter((id): id is string => typeof id === "string"),
  )
  const staleCutoff = Date.now() - 45 * 60 * 1000
  let stranded: Array<{
    mintUrl: string
    quoteId: string
    method: string
    createdAt: number
  }> = []
  try {
    stranded = (await coco.quotes.melt.listPending()).filter(
      (q) =>
        q.mintUrl === MINT_URL() &&
        q.method === "branch" &&
        q.quoteId &&
        !known.has(q.quoteId) &&
        q.createdAt > staleCutoff,
    )
  } catch {
    // quote enumeration is best-effort; the watcher owns listed ops anyway
    return
  }
  for (const q of stranded) {
    try {
      const op = await coco.ops.melt.prepare({
        quote: { mintUrl: q.mintUrl, quoteId: q.quoteId, method: "branch" },
      })
      await coco.ops.melt.execute(op.id)
      walletLog("info", "resumed stranded withdraw quote", { quoteId: q.quoteId })
    } catch (err) {
      walletLog("warn", "stranded withdraw quote resume failed", {
        quoteId: q.quoteId,
        error: String(err),
      })
    }
  }
}

/**
 * Returns the wallet's in-flight deposit (if any) so the UI can restore
 * the pending card after a page reload — the user shouldn't lose visual
 * context just because they refreshed.
 */
export async function getPendingDeposit(): Promise<DepositQuote | null> {
  const coco = await getCoco()
  const ops = await coco.ops.mint.listInFlight()
  const staleCutoff = Date.now() - 45 * 60 * 1000
  const op = ops.find(
    (o) =>
      (o.state === "pending" || o.state === "executing") &&
      o.unit === UNIT &&
      o.createdAt > staleCutoff,
  )
  if (!op || !op.quoteId) return null

  const quote = await coco.quotes.mint.get({
    mintUrl: MINT_URL(),
    quoteId: op.quoteId,
  })
  if (!quote) return null

  const expectedSat = (
    quote as { quoteData?: { expected_sat?: number } }
  ).quoteData?.expected_sat

  return {
    method: op.method as DepositMethod,
    quoteId: op.quoteId,
    tail: op.quoteId.slice(-6).toUpperCase(),
    request: quote.request,
    amount: Number(
      (quote as { amount?: { toBigInt(): bigint } }).amount?.toBigInt?.() ?? 0,
    ),
    ...(expectedSat !== undefined ? { expectedSat } : {}),
  }
}

/**
 * Returns the wallet's in-flight withdrawal (if any) for the same reason.
 */
export async function getPendingWithdraw(): Promise<{
  quoteId: string
  tail: string
} | null> {
  const coco = await getCoco()
  const ops = await coco.ops.melt.listInFlight()
  const staleCutoff = Date.now() - 45 * 60 * 1000
  const op = ops.find(
    (o) =>
      (o.state === "executing" || o.state === "pending") &&
      o.unit === UNIT &&
      o.createdAt > staleCutoff,
  )
  if (!op || !op.quoteId) return null
  return {
    quoteId: op.quoteId,
    tail: op.quoteId.slice(-6).toUpperCase(),
  }
}

// ---------------------------------------------------------------------------
// Developer tools (signet/test only — never enable on a value-carrying mint)
// ---------------------------------------------------------------------------

export const DEV_WALLET_TOOLS = true

export interface WalletDump {
  exportedAt: string
  unit: string
  seed: string | null
  mintUrl: string
  proofs: Array<Record<string, unknown>>
  mintOperations: Array<Record<string, unknown>>
  meltOperations: Array<Record<string, unknown>>
  history: Array<Record<string, unknown>>
}

export async function exportWalletDump(): Promise<WalletDump> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("giftcard-coco-wallet")
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const getAll = (store: string) =>
    new Promise<Array<Record<string, unknown>>>((resolve) => {
      const tx = db.transaction(store, "readonly")
      const req = tx.objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>)
      req.onerror = () => resolve([])
    })
  const stringify = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        out[k] = v instanceof Uint8Array ? Array.from(v) : v
      }
      return out
    })
  return {
    exportedAt: new Date().toISOString(),
    unit: UNIT,
    seed: window.localStorage.getItem(SEED_STORAGE_KEY),
    mintUrl: MINT_URL(),
    proofs: stringify(await getAll("coco_cashu_proofs")),
    mintOperations: stringify(await getAll("coco_cashu_mint_operations")),
    meltOperations: stringify(await getAll("coco_cashu_melt_operations")),
    history: stringify(await getAll("coco_cashu_history")),
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

/**
 * Permanently deletes all wallet state (IndexedDB + localStorage seed).
 * The page must reload afterward — the wallet is unusable until then.
 */
export async function forceClearWallet(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("giftcard-coco-wallet")
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
  window.localStorage.removeItem(SEED_STORAGE_KEY)
}
