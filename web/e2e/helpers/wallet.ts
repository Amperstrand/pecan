import { execSync } from "node:child_process"
import { expect, type Page } from "@playwright/test"

// ---------------------------------------------------------------------------
// Teller API helpers (operator side of the branch method)
// ---------------------------------------------------------------------------

export async function apiLogin(page: Page): Promise<void> {
  const password = process.env.PECAN_ADMIN_PASSWORD
  if (!password) {
    throw new Error(
      "PECAN_ADMIN_PASSWORD is not set — fetch the generated admin password " +
        "(scripts/e2e.sh does this) before running the suite",
    )
  }
  const resp = await page.request.post(`/api/login`, {
    headers: { "Content-Type": "application/json" },
    data: { username: "admin", password },
  })
  if (resp.status() !== 200) throw new Error(`admin login failed: ${resp.status()}`)
}

export async function matchAndSettle(
  page: Page,
  tellerCode: string,
  notes: string,
): Promise<{ id: string; kind: string; status: string; amount: number }> {
  const matchResp = await page.request.post(`/api/quotes/match`, {
    headers: { "Content-Type": "application/json" },
    data: { code: tellerCode },
  })
  const match = await matchResp.json()
  if (!match.id) {
    throw new Error(`match failed for ${tellerCode}: ${JSON.stringify(match).slice(0, 200)}`)
  }

  // Outgoing tickets sit in `waiting` until the wallet locks funds at the
  // mint — a swap-then-melt wallet needs two round trips, so poll until the
  // operator would actually be allowed to pay out.
  let ticket = match as { id: string; kind: string; status: string; amount: number }
  const deadline = Date.now() + 30_000
  while (ticket.status === "waiting" && Date.now() < deadline) {
    await page.waitForTimeout(500)
    const poll = await page.request.post(`/api/quotes/match`, {
      headers: { "Content-Type": "application/json" },
      data: { code: tellerCode },
    })
    ticket = await poll.json()
  }
  if (ticket.status === "waiting") {
    throw new Error(`ticket ${match.id} never left 'waiting' (wallet did not lock funds)`)
  }

  const settleResp = await page.request.post(`/api/tickets/${match.id}/mark-paid`, {
    headers: { "Content-Type": "application/json" },
    data: { notes },
  })
  if (settleResp.status() !== 200) {
    throw new Error(`mark-paid failed for ${match.id}: ${settleResp.status()} ${await settleResp.text()}`)
  }
  return settleResp.json()
}

// ---------------------------------------------------------------------------
// External wallet helpers (pay from lab nodes via SSH)
// ---------------------------------------------------------------------------

export function payLightningInvoiceFrom(node: string, invoice: string): string {
  let out: string
  try {
    out = execSync(
      `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`,
      { timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] },
    ).toString()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
    throw new Error(`lightning pay via ${node} failed: ${stderr.slice(0, 300)}`)
  }
  const match = out.match(/"payment_preimage":\s*"([0-9a-f]+)"/)
  if (!match) throw new Error(`payment did not complete: ${out.slice(0, 300)}`)
  return match[1]
}

/** Pays from the hub node (well-connected, multiple channels). */
export function payLightningInvoice(invoice: string): string {
  return payLightningInvoiceFrom("cln-hub-signet", invoice)
}

/**
 * Sends on-chain sats from a genuinely external lab wallet. The CLN nodes run
 * esplora chain mode; a withdraw can stall on slow esplora fetches, and
 * killing the RPC mid-flight strands the node's inputs as reserved for a long
 * block window — so we fail over across every lab wallet and keep the
 * timeout generous. €50 is the mint's onchain minimum, so each run burns
 * ~7.4k sat of payer liquidity; top the payers up from a signet faucet when
 * they run dry.
 */
const ONCHAIN_PAYERS = ["cln-hub-signet", "cln-vls-signet", "cln-nostr-signet"] as const

export function sendOnchainFromExternal(address: string, sat: number): string {
  const failures: string[] = []
  for (const node of ONCHAIN_PAYERS) {
    let out: string
    try {
      out = execSync(
        `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet withdraw ${address} ${sat}sat normal"`,
        { timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
      ).toString()
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer }
      // lightning-cli reports RPC errors on stdout; keep both for diagnosis
      failures.push(
        `${node}: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 300)}`,
      )
      continue
    }
    const match = out.match(/"txid":\s*"([0-9a-f]+)"/)
    if (!match) {
      failures.push(`${node}: no txid in output: ${out.slice(0, 300)}`)
      continue
    }
    return match[1]
  }
  throw new Error(`onchain withdraw failed on all payers:\n${failures.join("\n")}`)
}

// ---------------------------------------------------------------------------
// Wallet UI helpers (coco wallet at /console/wallet)
// ---------------------------------------------------------------------------

export async function clearWalletDb(page: Page): Promise<void> {
  await page.evaluate(async () => {
    indexedDB.deleteDatabase("giftcard-coco-wallet")
    localStorage.removeItem("giftcard-coco-seed-v1")
  })
  await page.reload()
}

export async function readBalance(page: Page): Promise<number> {
  // Balance renders as a sibling of the "Balance" label inside a card header;
  // it shows "… €" until the wallet initializes, so retry until a number
  // appears — a NaN here would poison every later `before ± amount` check.
  const el = page.locator('.text-4xl.tabular-nums')
  await el.waitFor({ state: "visible", timeout: 20_000 })
  const deadline = Date.now() + 20_000
  for (;;) {
    const text = await el.textContent()
    const value = parseFloat(text!.replace(/[^\d.]/g, ""))
    if (!Number.isNaN(value)) return value
    if (Date.now() > deadline) {
      throw new Error(`balance never rendered a number: "${text?.trim()}"`)
    }
    await page.waitForTimeout(250)
  }
}

/**
 * The 6-character code shown under "Give this code to the teller:" for both
 * deposits (MINT-… quote tail) and withdrawals (MELT-… quote tail).
 */
export async function readTellerCode(page: Page): Promise<string> {
  const code = page.locator("p.font-mono.text-3xl")
  await code.waitFor({ state: "visible", timeout: 30_000 })
  const text = (await code.textContent())?.trim() ?? ""
  if (!/^[A-Z0-9]{6}$/.test(text)) {
    throw new Error(`expected 6-char teller code, got: "${text}"`)
  }
  return text
}

export async function waitForDepositFormReset(
  page: Page,
  buttonName = "Create deposit quote",
): Promise<void> {
  await page
    .getByRole("button", { name: buttonName })
    .waitFor({ state: "visible", timeout: 45_000 })
}

// ---------------------------------------------------------------------------
// Wallet log — invariant assertions over the debug ring buffer
// ---------------------------------------------------------------------------

export interface WalletLogEntry {
  t: number
  level: "debug" | "info" | "warn"
  msg: string
  data?: {
    id?: string
    quoteId?: string
    state?: string
    change?: string
    fee?: string
    waitedMs?: number
    [k: string]: unknown
  }
}

export async function readWalletLog(page: Page): Promise<WalletLogEntry[]> {
  return page.evaluate(
    () =>
      (window as { __pecanWalletLog?: () => unknown[] }).__pecanWalletLog?.() ??
      [],
  )
}

/**
 * Fails when warn-level wallet entries appeared since `sinceT` (epoch ms).
 * Warns mark silent degradations a green run must not contain: background
 * melt failures, fund-lock wait timeouts, failed prepared-op resumes.
 */
export async function expectNoWalletWarnsSince(
  page: Page,
  sinceT: number,
): Promise<void> {
  const warns = (await readWalletLog(page)).filter(
    (e) => e.t > sinceT && e.level === "warn",
  )
  if (warns.length > 0) {
    throw new Error(
      `wallet warn entries:\n${warns.map((e) => `  - ${new Date(e.t).toISOString()} ${e.msg} ${JSON.stringify(e.data ?? {})}`).join("\n")}`,
    )
  }
}

/**
 * Change (subunit units) the finalized melt for a teller code settled with,
 * from the authoritative IDB operation row — pins the exact-amount policy:
 * teller melts must finalize with zero change. NaN when the op has not
 * finalized yet.
 */
export async function finalizedMeltChange(
  page: Page,
  tellerCode: string,
): Promise<number> {
  const db = await readWalletDb(page)
  const op = db.meltOps.find(
    (o) => o.quoteTail === tellerCode && o.state === "finalized",
  )
  if (!op) return Number.NaN
  return Number(op.change ?? Number.NaN)
}

/**
 * The fund-lock entry for a withdraw: proves the teller code was withheld
 * until the async melt's setup completed (inputs burned, quote PENDING).
 */
export async function fundLockReleaseEntry(
  page: Page,
  tellerCode: string,
): Promise<WalletLogEntry | undefined> {
  const tail = tellerCode.toLowerCase()
  const entries = await readWalletLog(page)
  return entries.find(
    (e) =>
      e.msg === "withdraw fund-lock result" &&
      typeof e.data?.quoteId === "string" &&
      e.data.quoteId.toLowerCase().endsWith(tail),
  )
}


// ---------------------------------------------------------------------------
// Console/page error gate — the wallet itself must run clean
// ---------------------------------------------------------------------------

export function trackWalletErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
  })
  page.on("pageerror", (err) => errors.push(`pageerror: ${String(err)}`))
  return errors
}

export function expectNoWalletErrors(errors: string[]): void {
  if (errors.length > 0) {
    throw new Error(`wallet console errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  }
}

// ---------------------------------------------------------------------------
// IndexedDB inspection — prove self-custody state (proofs, operations)
// ---------------------------------------------------------------------------

interface IdbProofState {
  proofCount: number
  proofSum: number
  /** Sum of proofs not marked spent — spent proofs stay in the store as history. */
  spendableSum: number
  mintOps: Array<{ state: string; quoteTail: string }>
  meltOps: Array<{
    state: string
    quoteTail: string
    /** Serialized Amount strings, present once the op finalized. */
    change?: string
    fee?: string
  }>
}

export async function readWalletDb(page: Page): Promise<IdbProofState> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("giftcard-coco-wallet")
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const getAll = (store: string) =>
      new Promise<unknown[]>((resolve) => {
        const tx = db.transaction(store, "readonly")
        const req = tx.objectStore(store).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve([])
      })
    const rows = (await getAll("coco_cashu_proofs")) as Array<{
      amount?: number | string
      state?: string
      proof?: { amount?: number | string }
    }>
    const mintOps = (await getAll("coco_cashu_mint_operations")) as Array<{
      state: string
      quoteId: string
    }>
    const meltOps = (await getAll("coco_cashu_melt_operations")) as Array<{
      state: string
      quoteId: string
    }>
    return {
      proofCount: rows.length,
      proofSum: rows.reduce(
        (sum, r) => sum + Number(r.amount ?? r.proof?.amount ?? 0),
        0,
      ),
      spendableSum: rows
        .filter((r) => r.state !== "spent")
        .reduce((sum, r) => sum + Number(r.amount ?? r.proof?.amount ?? 0), 0),
      mintOps: mintOps.map((o) => ({
        state: o.state,
        quoteTail: o.quoteId.slice(-6).toUpperCase(),
      })),
      meltOps: meltOps.map((o) => ({
        state: o.state,
        quoteTail: o.quoteId.slice(-6).toUpperCase(),
        ...(typeof o.changeAmount === "string" ? { change: o.changeAmount } : {}),
        ...(typeof o.effectiveFee === "string" ? { fee: o.effectiveFee } : {}),
      })),
    }
  })
}

/**
 * The op row can finalize after the balance already moved; poll until the
 * operation for `tellerCode` (quote-id tail) reaches `state`.
 */
export async function waitForOpState(
  page: Page,
  kind: "mint" | "melt",
  tellerCode: string,
  state: string,
  timeout = 60_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const db = await readWalletDb(page)
        const ops = kind === "mint" ? db.mintOps : db.meltOps
        return ops.find((op) => op.quoteTail === tellerCode)?.state ?? "missing"
      },
      { timeout },
    )
    .toBe(state)
}
