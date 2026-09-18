// One-command live EGG demo: buy today's eggs with signet sats (the
// farm-autopay timer settles the invoice within ~60s), watch the claims
// mint, redeem at the counter, and settle as the operator — the full
// vending-machine loop in visible browser windows on this Mac.
//
// Run it via `make farm-demo` (repo root) or:
//   cd web && node e2e/demo/farm-demo.mjs
//
// Env:
//   PECAN_DEMO_ADMIN_PASSWORD  required — scripts/farm-demo.sh fetches it
//   PECAN_DEMO_EGGS            eggs to buy        (default 2)
//
// The wallet profile persists in /tmp/pecan-farm-demo-profile — claims
// carry across runs, so repeat demos only buy when empty. Ctrl+C closes.

import { mkdirSync } from "node:fs"
import { chromium } from "@playwright/test"

const ORIGIN = "https://giftcard.cashu.exchange"
const CONSOLE = "/farm-console"
const PROFILE_DIR = "/tmp/pecan-farm-demo-profile"
const SHOTS = "/tmp/pecan-farm-demo"
const QTY = Number(process.env.PECAN_DEMO_EGGS ?? 2)
const PASSWORD = process.env.PECAN_DEMO_ADMIN_PASSWORD ?? ""

if (!PASSWORD) {
  console.error("FAIL: PECAN_DEMO_ADMIN_PASSWORD is not set (scripts/farm-demo.sh fetches it)")
  process.exit(1)
}

mkdirSync(SHOTS, { recursive: true })
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const step = (msg) => console.log(`\n[${elapsed()}] === ${msg}`)
const ok = (msg) => console.log(`[${elapsed()}] ok   ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(page, name) {
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png` })
    ok(`screenshot ${name}.png`)
  } catch {
    /* screenshot must never kill the demo */
  }
}

async function main() {
  step(`launch demo browser (profile ${PROFILE_DIR})`)
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ["--window-size=1100,940", "--window-position=0,0"],
  })
  process.on("SIGINT", () => {
    console.log(`\n[${elapsed()}] Ctrl+C — closing the demo browser`)
    void context.close()
  })
  context.on("close", () => {
    console.log(`\n[${elapsed()}] browser closed — demo over`)
    process.exit(process.exitCode ?? 0)
  })

  const wallet = context.pages()[0] ?? (await context.newPage())

  // Second OS window for the operator side.
  let teller = null
  try {
    const cdp = await context.newCDPSession(wallet)
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    })
    const bounds = await cdp.send("Browser.getWindowForTarget", { targetId })
    await cdp
      .send("Browser.setWindowBounds", {
        windowId: bounds.windowId,
        bounds: { left: 1100, top: 0, width: 1100, height: 940 },
      })
      .catch(() => undefined)
    teller = context.pages().find((p) => !p.isClosed() && p !== wallet) ?? (await context.newPage())
  } catch {
    teller = await context.newPage()
  }

  step("operator: sign in to the farm console")
  await teller.goto(`${ORIGIN}${CONSOLE}`)
  const login = await teller.request.post(`${ORIGIN}${CONSOLE}/api/login`, {
    headers: { "Content-Type": "application/json" },
    data: { username: "admin", password: PASSWORD },
  })
  if (login.status() !== 200) throw new Error(`admin login failed: ${login.status()}`)
  ok("admin session ready")

  step("customer: open the wallet's FARM tab")
  await wallet.goto(`${ORIGIN}/wallet`)
  await wallet.getByRole("tab", { name: "FARM" }).click()
  await wallet.getByLabel("production day").waitFor({ state: "visible", timeout: 30_000 })
  const ownNow = await wallet.getByText(/\d+ egg claims/).first().textContent().catch(() => "0")
  ok(`current holdings: ${ownNow?.trim()}`)
  await shot(wallet, "01-farm-tab")

  step(`customer: buy ${QTY} of today's eggs (autopay settles the invoice)`)
  await wallet.getByLabel("egg quantity").fill(String(QTY))
  await wallet.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  await wallet.getByText(/YOU OWN — Farm eggs/).first().waitFor({ timeout: 240_000 })
  ok("payment observed, claims minted")
  // A fresh profile's balance projection can lag the mint while the
  // wallet finishes its keyset boot — the claims card is the gate for
  // the redeem step.
  await wallet.getByRole("tablist", { name: "Egg series" }).waitFor({ timeout: 240_000 })
  await shot(wallet, "02-eggs-owned")

  step("customer: redeem at the farm")
  await wallet.getByLabel(/redeem quantity for/).first().fill(String(QTY))
  await wallet.getByRole("button", { name: /Redeem at farm/i }).click()
  const codeText = await wallet.getByText(/teller code [0-9A-F]{6}/i).first().textContent({ timeout: 60_000 })
  const tail = codeText?.match(/([0-9A-F]{6})/)?.[1] ?? ""
  if (!tail) throw new Error("no teller code appeared")
  ok(`teller code ${tail}`)
  await shot(wallet, "03-teller-code")

  step("operator: match the code and hand the eggs over")
  const matchResp = await teller.request.post(`${ORIGIN}${CONSOLE}/api/quotes/match`, {
    headers: { "Content-Type": "application/json" },
    data: { code: tail },
  })
  const ticket = await matchResp.json()
  if (!ticket.id) throw new Error(`match failed: ${JSON.stringify(ticket).slice(0, 200)}`)
  let current = ticket
  const deadline = Date.now() + 30_000
  while (current.status === "waiting" && Date.now() < deadline) {
    await sleep(500)
    const poll = await teller.request.post(`${ORIGIN}${CONSOLE}/api/quotes/match`, {
      headers: { "Content-Type": "application/json" },
      data: { code: tail },
    })
    current = await poll.json()
  }
  const settle = await teller.request.post(`${ORIGIN}${CONSOLE}/api/tickets/${current.id}/mark-paid`, {
    headers: { "Content-Type": "application/json" },
    data: { notes: "eggs handed over", condition: "demo: all eggs intact" },
  })
  if (settle.status() !== 200) throw new Error(`settle failed: ${settle.status()} ${await settle.text()}`)
  const settled = await settle.json()
  ok(`settled ${settled.amount} ${settled.unit} — receipt ${settled.receipt}`)

  step("customer: receipt")
  const receiptShown = await wallet
    .getByText(/^FARM-/)
    .first()
    .waitFor({ timeout: 180_000 })
    .then(() => true)
    .catch(() => false)
  if (receiptShown) {
    ok("receipt on the customer screen")
  } else {
    // The handover is settled and receipted on the operator side; the
    // wallet's poll can lag on a wedge-prone page — say so and move on.
    ok(`receipt ${settled.receipt} (operator side; wallet poll still catching up)`)
  }
  await shot(wallet, "04-receipt")
  console.log(`\n[${elapsed()}] demo complete — screenshots in ${SHOTS}`)
  console.log(`[${elapsed()}] leave the browser open to browse, Ctrl+C to close`)
  await sleep(60_000)
  await context.close()
}

main().catch((e) => {
  console.error(`\n[${elapsed()}] FAIL ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
