import { Amount, getDecodedToken, getEncodedToken, normalizeMintUrl } from "@cashu/cashu-ts"
import { CURRENCIES, consoleUrl, mintUrl } from "./currency"
import { getCoco } from "./coco-wallet"
import { raceTimeout } from "./timeout"
import { walletLog } from "./wallet-log"
import { futureTagOfSecret, type FutureMintQuoteResponse } from "./future-methods"

/**
 * Farm API types (processor /api/farm/*) — the Sarah-facing surface of the
 * NUT-32 egg-futures spike.
 */
export interface FarmSeriesInfo {
  date: string
  unit: string
  maturity: number
  capacity: number
  issued: number
  redeemed: number
  available: number
  price_sats: number
  actual_production: number | null
  terms_uri: string
  terms_sha256: string
  matured: boolean
}

export interface FarmOverview {
  name: string
  commodity: string
  price_sats_per_unit: number
  series: FarmSeriesInfo[]
}

export interface FarmPurchaseInfo {
  purchase_id: string
  series: string
  date: string
  unit: string
  quantity: number
  price_per_egg_sats: number
  total_sats: number
  state: "open" | "paid" | "authorized" | "minted" | "expired" | "failed"
  pubkey?: string
  payment_state: string
  capacity_reservation: string
  future_issuance: string
  mint_quote?: string
  error?: string
  expires_at: number
  created_at: number
  payment?: { bolt11: string; payment_hash: string }
}

export const FARM_TERMS_MAP_KEY = "pecan-farm-terms"
const PURCHASE_LOCK_MAP_KEY = "pecan-farm-purchase-locks"

function farmConsole(): string {
  const base = consoleUrl("farm")
  if (!base) throw new Error("farm console path missing from currency registry")
  return base
}

export function farmMintUrl(): string {
  return mintUrl("farm")
}

/** Remember unit → terms URI so mint/swap outputs can carry the tag. */
export function rememberTerms(unit: string, termsUri: string): void {
  try {
    const map = JSON.parse(window.localStorage.getItem(FARM_TERMS_MAP_KEY) ?? "{}") as Record<string, string>
    map[unit] = termsUri
    window.localStorage.setItem(FARM_TERMS_MAP_KEY, JSON.stringify(map))
  } catch {
    // best-effort; the farm tab re-fetches the overview on load
  }
}

export function termsUriFor(unit: string): string | null {
  try {
    const map = JSON.parse(window.localStorage.getItem(FARM_TERMS_MAP_KEY) ?? "{}") as Record<string, string>
    return map[unit] ?? null
  } catch {
    return null
  }
}

async function farmFetch(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${farmConsole()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!r.ok) {
    const body = await r.text().catch(() => "")
    throw new Error(`farm ${path}: HTTP ${r.status} ${body.slice(0, 200)}`)
  }
  return r
}

export async function fetchFarmOverview(): Promise<FarmOverview> {
  const r = await farmFetch("/api/farm")
  const overview = (await r.json()) as FarmOverview
  for (const series of overview.series) {
    rememberTerms(series.unit, series.terms_uri)
  }
  return overview
}

export async function fetchFarmOracle(date: string): Promise<FarmSeriesInfo & { reserved: number; remaining_issuable: number }> {
  const r = await farmFetch(`/api/farm/${date}`)
  return await r.json()
}

export async function fetchFarmTermsBlob(sha256: string): Promise<string> {
  const r = await farmFetch(`/terms/${sha256}`)
  return await r.text()
}

export async function createFarmPurchase(
  productionDate: string,
  quantity: number,
): Promise<FarmPurchaseInfo & { payment: { bolt11: string; payment_hash: string } }> {
  const coco = await getCoco()
  // The purchase binds issuance to THIS wallet via a per-purchase NUT-20
  // lock key — the quote payment itself never becomes a bearer credential.
  const keypair = await coco.keyRingService.generateMintQuoteKeyPair()
  const r = await farmFetch("/api/farm/futures/quote", {
    method: "POST",
    body: JSON.stringify({
      production_date: productionDate,
      quantity,
      pubkey: keypair.publicKeyHex,
    }),
  })
  const purchase = (await r.json()) as FarmPurchaseInfo & {
    pubkey: string
    payment: { bolt11: string; payment_hash: string }
  }
  rememberPurchaseLock(purchase.purchase_id, purchase.pubkey)
  return purchase
}

/** purchase id → its NUT-20 lock key (the wallet-generated key the
 * purchase bound issuance to — the mint quote must be locked with the
 * SAME key, or the processor refuses). */
export function rememberPurchaseLock(purchaseId: string, pubkey: string): void {
  try {
    const map = JSON.parse(window.localStorage.getItem(PURCHASE_LOCK_MAP_KEY) ?? "{}") as Record<string, string>
    map[purchaseId] = pubkey
    window.localStorage.setItem(PURCHASE_LOCK_MAP_KEY, JSON.stringify(map))
  } catch {
    // best-effort
  }
}

export function purchaseLockFor(purchaseId: string): string | null {
  try {
    const map = JSON.parse(window.localStorage.getItem(PURCHASE_LOCK_MAP_KEY) ?? "{}") as Record<string, string>
    return map[purchaseId] ?? null
  } catch {
    return null
  }
}

export async function getFarmPurchase(id: string): Promise<FarmPurchaseInfo> {
  const r = await farmFetch(`/api/farm/futures/purchase/${id}`)
  return await r.json()
}

export interface MintedFuture {
  purchaseId: string
  unit: string
  quantity: number
  quoteId: string
}

/**
 * The issuance leg: once the purchase is `authorized`, create the
 * NUT-20-locked `future` mint quote (the processor links it to the
 * purchase and flips it PAID — the signet payment settled before the
 * quote existed), then mint the tagged proofs.
 */
export async function mintFuture(purchase: FarmPurchaseInfo): Promise<MintedFuture> {
  const coco = await getCoco()
  // The purchase id rides the create call's `description` slot — the
  // generic quote-create input has no custom-field passthrough, and the
  // handler remaps it into the flattened `purchase` extra field the
  // processor binds issuance to.
  const quote = await raceTimeout(
    coco.quotes.mint.create({
      mintUrl: farmMintUrl(),
      method: "future",
      amount: { amount: BigInt(purchase.quantity), unit: purchase.unit },
      description: purchase.purchase_id,
      locked: true,
    }),
    20_000,
    "future mint quote",
  )
  const operation = await raceTimeout(
    coco.ops.mint.prepare({ quote, amount: purchase.quantity }),
    15_000,
    "future mint prepare",
  )
  await raceTimeout(coco.ops.mint.execute(operation.id), 30_000, "future mint execute")
  walletLog("info", "future mint executed", {
    purchaseId: purchase.purchase_id,
    quoteId: quote.quoteId,
    unit: purchase.unit,
    quantity: purchase.quantity,
  })
  return {
    purchaseId: purchase.purchase_id,
    unit: purchase.unit,
    quantity: purchase.quantity,
    quoteId: quote.quoteId,
  }
}

export interface FutureBalance {
  unit: string
  amount: number
  termsUri: string | null
  date: string | null
  maturity: number | null
}

/** All future-unit balances at the farm mint, decoded from proof secrets. */
export async function futureBalances(): Promise<FutureBalance[]> {
  const coco = await getCoco()
  const balances = await coco.wallet.balances.byUnit({ mintUrls: [farmMintUrl()] })
  const out: FutureBalance[] = []
  for (const [unit, entry] of Object.entries(balances)) {
    if (!unit.startsWith("future:")) continue
    out.push({
      unit,
      amount: Number(entry.spendable.toBigInt()),
      termsUri: null,
      date: unit.match(/:(\d{8})t/i)?.[1]?.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") ?? null,
      maturity: null,
    })
  }
  for (const balance of out) {
    balance.termsUri = termsUriFor(balance.unit)
  }
  return out.sort((a, b) => a.unit.localeCompare(b.unit))
}

export interface SendFutureResult {
  token: string
  keepAmount: number
  sentAmount: number
}

/**
 * Sarah → Bob: split the series balance with a NUT-32-aware swap (every
 * replacement proof keeps the future tag) and export the sent proofs as a
 * bearer Cashu token. The farm never learns who holds what.
 */
export async function sendFuture(unit: string, quantity: number): Promise<SendFutureResult> {
  const coco = await getCoco()
  const termsUri = termsUriFor(unit)
  if (!termsUri) {
    throw new Error(`No terms URI known for ${unit} — refresh the farm tab first`)
  }
  const balances = await futureBalances()
  const balance = balances.find((b) => b.unit === unit)
  if (!balance || balance.amount < quantity) {
    throw new Error(`Not enough claims: ${balance?.amount ?? 0} of ${quantity} available`)
  }
  const { send } = await coco.swapFutureUnits(farmMintUrl(), unit, [["future", "1", termsUri]], {
    keep: BigInt(balance.amount - quantity),
    send: BigInt(quantity),
  })
  const token = getEncodedToken({
    mint: farmMintUrl(),
    proofs: send,
    unit,
  })
  return {
    token,
    keepAmount: balance.amount - quantity,
    sentAmount: quantity,
  }
}

async function farmKeysetIds(): Promise<string[]> {
  const r = await fetch(`${farmMintUrl()}/v1/keysets`)
  if (!r.ok) return []
  const keysets = (await r.json()) as { keysets?: Array<{ id?: string }> }
  return keysets.keysets?.map((k) => k.id).filter((id): id is string => !!id) ?? []
}

export async function receiveFutureToken(token: string): Promise<number> {
  const coco = await getCoco()
  // V3 binary tokens resolve their proof keysets against the supplied id
  // list; the farm mint's live keysets cover every series.
  const keysetIds = await farmKeysetIds()
  const decoded = getDecodedToken(token, keysetIds)
  if (!decoded.mint || !decoded.unit) {
    throw new Error("token is missing its mint or unit")
  }
  if (normalizeMintUrl(decoded.mint) !== farmMintUrl()) {
    throw new Error(`token is from ${decoded.mint}, not the farm mint`)
  }
  const unit: string = decoded.unit
  if (!unit.startsWith("future:")) {
    throw new Error(`token unit ${unit} is not a farm future`)
  }
  const termsUri = termsUriFor(unit)
  if (!termsUri) {
    throw new Error(`no terms known for ${unit} — refresh the farm tab first`)
  }
  // Bypasses the generic receive pipeline (it wedges fresh contexts on
  // this stack): receive = swap the token's proofs into fresh tagged
  // proofs bound to this wallet.
  await coco.receiveFutureUnits(farmMintUrl(), unit, [["future", "1", termsUri]], decoded.proofs)
  const balances = await futureBalances()
  return balances.reduce((sum, b) => sum + b.amount, 0)
}


export interface RedemptionStart {
  quoteId: string
  tail: string
  quantity: number
  unit: string
}

/**
 * Redemption leg 1 — the wallet locks (burns) its proofs into a
 * `future` melt quote; the teller matches the code, hands over eggs, and
 * settles. Returns the teller code to show.
 */
export async function startRedemption(unit: string, quantity: number): Promise<RedemptionStart> {
  const coco = await getCoco()
  const quote = await raceTimeout(
    coco.quotes.melt.create({
      mintUrl: farmMintUrl(),
      method: "future",
      methodData: { amount: Amount.from(quantity), description: "farm redemption" },
      unit,
    }),
    20_000,
    "redemption melt quote",
  )
  const prepared = await raceTimeout(coco.ops.melt.prepare({ quote }), 15_000, "redemption melt prepare")
  const settled = await Promise.race([
    coco.ops.melt
      .execute(prepared.id)
      .then((op) => ({ state: op.state as string, error: null as string | null }))
      .catch((err: unknown) => ({ state: "error", error: String(err) })),
    new Promise<{ state: "timeout"; error: null }>((resolve) =>
      setTimeout(() => resolve({ state: "timeout", error: null }), 30_000),
    ),
  ])
  walletLog(
    settled.state === "error" || settled.state === "timeout" ? "warn" : "info",
    "redemption fund-lock result",
    { quoteId: quote.quoteId, state: settled.state, error: settled.error },
  )
  return {
    quoteId: quote.quoteId,
    tail: quote.quoteId.slice(-6).toUpperCase(),
    quantity,
    unit,
  }
}

/** Redemption leg 2 — poll for the FARM receipt (the settle preimage). */
export async function pollRedemption(quoteId: string): Promise<string | null> {
  const coco = await getCoco()
  const operation = await raceTimeout(
    coco.ops.melt.getByQuote({ mintUrl: farmMintUrl(), quoteId }),
    10_000,
    "redemption poll",
  ).catch(() => null)
  if (!operation) return null
  if (operation.state === "finalized") {
    const finalized = operation as { finalizedData?: { preimage?: string } }
    return String(finalized.finalizedData?.preimage ?? "PAID")
  }
  if (operation.state === "failed" || operation.state === "rolled_back") {
    return "FAILED"
  }
  try {
    const refreshed = await coco.ops.melt.refresh(operation.id)
    if (refreshed.state === "finalized") {
      const finalized = refreshed as { finalizedData?: { preimage?: string } }
      return String(finalized.finalizedData?.preimage ?? "PAID")
    }
  } catch {
    // lock contention with the background watcher; next tick retries
  }
  return null
}

export type { FutureMintQuoteResponse }
export { CURRENCIES }
