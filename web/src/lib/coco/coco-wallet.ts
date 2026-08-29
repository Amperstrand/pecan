import { Amount } from "@cashu/cashu-ts"
import { initializeCoco, type HistoryEntry, type Manager } from "@cashu/coco-core"
import { IndexedDbRepositories } from "@cashu/coco-indexeddb"

import { MINT_URL, UNIT, type DepositMethod } from "./branch-methods"

export type { DepositMethod }
import { MeltBranchHandler } from "./melt-branch-handler"
import { MintBranchHandler } from "./mint-branch-handler"

export interface HistoryRow {
  id?: number
  type: "deposit" | "withdraw"
  amount_ore: number
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
  amountOre: number
  /** btc: the sats the payer must send, from the processor via extra. */
  expectedSat?: number
}

export interface WithdrawResult {
  quoteId: string
  tail: string
  amountOre: number
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
      await coco.mint.addMint(MINT_URL(), { trusted: true })
      return coco
    })()
  }
  return cocoInstance
}

export async function getBalanceOre(): Promise<number> {
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

export function mapHistoryEntry(entry: HistoryEntry): HistoryRow | null {
  const createdAt = entry.createdAt
  if (entry.type === "mint") {
    if (entry.state === "failed") return null
    return {
      type: "deposit",
      amount_ore: Number(entry.amount.toBigInt()),
      description: "Deposit",
      created_at: createdAt,
      pending: entry.state !== "finalized",
    }
  }
  if (entry.type === "melt") {
    return {
      type: "withdraw",
      amount_ore: Number(entry.amount.toBigInt()),
      description: "Withdraw",
      created_at: createdAt,
      pending: entry.state !== "finalized",
    }
  }
  return null
}

export async function createDepositQuote(
  amountKr: number,
  method: DepositMethod = "branch",
): Promise<DepositQuote> {
  const coco = await getCoco()
  const amountOre = Math.round(amountKr * 100)

  const quote = await coco.quotes.mint.create({
    mintUrl: MINT_URL(),
    method,
    amount: amountOre,
    unit: UNIT,
    description: "Wallet deposit",
    locked: true,
  })

  const operation = await coco.ops.mint.prepare({ quote, amount: amountOre })
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
    amountOre,
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

export async function createWithdraw(amountKr: number, recipient: string): Promise<WithdrawResult> {
  const coco = await getCoco()
  const amountOre = Math.round(amountKr * 100)

  const quote = await coco.quotes.melt.create({
    mintUrl: MINT_URL(),
    method: "branch",
    methodData: { amount: Amount.from(amountOre), description: recipient },
    unit: UNIT,
  })

  const prepared = await coco.ops.melt.prepare({ quote })
  void coco.ops.melt.execute(prepared.id).catch((err: unknown) => {
    console.warn("melt execute background:", err)
  })

  return {
    quoteId: quote.quoteId,
    tail: quote.quoteId.slice(-6).toUpperCase(),
    amountOre,
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
 * active poll source. Drive every persisted pending mint/melt operation to
 * a terminal state by refreshing on an interval; fire `onSettled` once any
 * operation settles so the UI can reload balance and history.
 */
export async function resumePendingOperations(
  onSettled?: () => void,
): Promise<boolean> {
  const coco = await getCoco()
  const [melts, mints] = await Promise.all([
    coco.ops.melt.listInFlight(),
    coco.ops.mint.listInFlight(),
  ])
  const pending = [
    ...melts.map((op) => ({ id: op.id, kind: "melt" as const })),
    ...mints.map((op) => ({ id: op.id, kind: "mint" as const })),
  ]
  if (pending.length === 0) return false

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
