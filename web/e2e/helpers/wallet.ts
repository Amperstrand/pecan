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
 * Sends on-chain sats from the vls node — a genuinely external wallet.
 * (The nostr node was the original payer but its confirmed utxos ended up
 * reserved until block 320158 after a stalled withdraw; vls is the backup
 * lab wallet. The 300s timeout matters: killing the RPC mid-flight leaves
 * CLN input reservations behind that only clear after reserved_to_block.)
 */
export function sendOnchainFromExternal(address: string, sat: number): string {
  let out: string
  try {
    out = execSync(
      `ssh root@46.224.104.12 "docker exec cln-vls-signet lightning-cli --network=signet withdraw ${address} ${sat}sat normal"`,
      { timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
    ).toString()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
    throw new Error(`onchain withdraw failed: ${stderr.slice(0, 300)}`)
  }
  const match = out.match(/"txid":\s*"([0-9a-f]+)"/)
  if (!match) throw new Error(`withdraw produced no txid: ${out.slice(0, 300)}`)
  return match[1]
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
  // Balance renders as a sibling of the "Balance" label inside a card header
  const el = page.locator('.text-4xl.tabular-nums')
  await el.waitFor({ state: "visible", timeout: 20_000 })
  const text = await el.textContent()
  return parseFloat(text!.replace(/[^\d.]/g, ""))
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
  meltOps: Array<{ state: string; quoteTail: string }>
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
