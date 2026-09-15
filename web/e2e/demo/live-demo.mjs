// One-command live demo: fund the wallet at the teller counter, approve the
// deposit in the admin console, then melt to a live EV charger and watch the
// session deliver. Everything runs in visible browser windows on this Mac —
// left window is the customer wallet, right window the operator/teller.
//
// Run it via `make demo` (repo root) or:
//   cd web && node e2e/demo/live-demo.mjs
//
// Env:
//   PECAN_DEMO_ADMIN_PASSWORD  required — scripts/demo.sh fetches it
//   PECAN_DEMO_FUND     deposit amount in NOK        (default 25)
//   PECAN_DEMO_BUDGET   charge budget in kW·s        (default 12)
//   PECAN_DEMO_DEVICE   charger device id            (default atomD)
//
// The wallet profile persists in /tmp/pecan-demo-profile — balance carries
// across runs, so repeat demos only top up when short. Ctrl+C closes.

import { mkdirSync, writeFileSync } from "node:fs"
import { chromium } from "@playwright/test"

const ORIGIN = "https://giftcard.cashu.exchange"
const CONSOLE = "/nok-console"
const PROFILE_DIR = "/tmp/pecan-demo-profile"
const SHOTS = "/tmp/pecan-demo"
const FUND = Number(process.env.PECAN_DEMO_FUND ?? 25)
const BUDGET = Number(process.env.PECAN_DEMO_BUDGET ?? 12)
const DEVICE = process.env.PECAN_DEMO_DEVICE ?? "atomD"
const CHARGER_TAB = {
  atomA: "Charger A",
  atomB: "Charger B",
  atomC: "Charger C",
  atomD: "Charger D",
  atomV: "Charger V",
}[DEVICE]
const PASSWORD = process.env.PECAN_DEMO_ADMIN_PASSWORD ?? ""

if (!PASSWORD) {
  console.error("FAIL: PECAN_DEMO_ADMIN_PASSWORD is not set (scripts/demo.sh fetches it)")
  process.exit(1)
}
if (!CHARGER_TAB) {
  console.error(`FAIL: unknown charger device "${DEVICE}" (atomA..atomD, atomV = virtual)`)
  process.exit(1)
}

mkdirSync(SHOTS, { recursive: true })
const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const step = (msg) => console.log(`\n[${elapsed()}] === ${msg}`)
const ok = (msg) => console.log(`[${elapsed()}] ok   ${msg}`)
const fail = (msg) => {
  console.error(`[${elapsed()}] FAIL ${msg}`)
  process.exitCode = 1
  throw new Error(msg)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(page, name) {
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png` })
    ok(`screenshot ${name}.png`)
  } catch {
    /* screenshot must never kill the demo */
  }
}

async function readBalance(page) {
  const text = await page.locator(".text-4xl.tabular-nums").first().textContent()
  const value = parseFloat((text ?? "").replace(/[^\d.]/g, ""))
  if (Number.isNaN(value)) throw new Error(`balance not parseable: "${text?.trim()}"`)
  return value
}

async function resetWithdrawForm(page) {
  for (const label of ["New withdraw", "Try again"]) {
    const button = page.getByRole("button", { name: label, exact: true })
    if (await button.isVisible().catch(() => false)) await button.first().click()
  }
}

async function main() {
  step(`launch demo browser (profile ${PROFILE_DIR})`)
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ["--window-size=1440,940", "--window-position=0,0"],
  })
  process.on("SIGINT", () => {
    console.log(`\n[${elapsed()}] Ctrl+C — closing the demo browser`)
    void context.close()
  })
  await context.grantPermissions(["camera"], { origin: ORIGIN }).catch(() => undefined)
  context.on("close", () => {
    console.log(`\n[${elapsed()}] browser closed — demo over`)
    process.exit(process.exitCode ?? 0)
  })

  const wallet = context.pages()[0] ?? (await context.newPage())
  await wallet.addInitScript(() => {
    window.localStorage.setItem("pecan-currency", "nok")
    window.localStorage.setItem("pecan-debug", "1")
  })

  // Second OS window for the operator side (falls back to a tab if the
  // CDP window call misbehaves).
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
        bounds: { left: 1440, top: 0, width: 1440, height: 940 },
      })
      .catch(() => undefined)
    teller = context.pages().find((p) => !p.isClosed() && p !== wallet)
  } catch {
    /* tab fallback below */
  }
  if (!teller) teller = await context.newPage()
  ok("two windows ready: wallet (left) + teller (right)")

  step("boot the customer wallet (NOK)")
  await wallet.goto(`${ORIGIN}${CONSOLE}/wallet`)
  await wallet.getByRole("heading", { name: "Wallet" }).waitFor({ timeout: 30_000 })
  ok(`wallet up at ${wallet.url()}`)
  await shot(wallet, "1-wallet-boot")

  step("operator window: sign in + open the teller page")
  await teller.goto(`${ORIGIN}${CONSOLE}/teller`)
  const loginForm = teller.getByRole("heading", { name: "Sign in" })
  const matchCard = teller.getByText("Match a quote").first()
  const authDeadline = Date.now() + 30_000
  while (!(await loginForm.isVisible().catch(() => false)) && !(await matchCard.isVisible().catch(() => false))) {
    if (Date.now() > authDeadline) fail("teller page never settled on login or match card")
    await sleep(300)
  }
  if (await loginForm.isVisible().catch(() => false)) {
    await teller.getByRole("textbox", { name: "Username" }).fill("admin")
    await teller.getByRole("textbox", { name: "Password" }).fill(PASSWORD)
    await teller.getByRole("button", { name: "Sign in" }).click()
    await teller.getByText("Open quotes").first().waitFor({ timeout: 20_000 })
    ok("admin signed in")
    await teller.goto(`${ORIGIN}${CONSOLE}/teller`)
  } else {
    ok("admin session already active")
  }
  await matchCard.waitFor({ timeout: 20_000 })
  ok("teller page up — camera scan available for phone wallets")
  await shot(teller, "2-teller-ready")

  let balance = await readBalance(wallet)
  ok(`balance: NOK ${balance.toFixed(2)}`)

  if (balance < BUDGET + 5) {
    step(`top up: create a NOK ${FUND} teller deposit in the wallet`)
    for (const card of await wallet.locator('[data-testid="deposit-card"]').all()) {
      const cancel = card.getByRole("button", { name: "Cancel" })
      if (await cancel.isVisible().catch(() => false)) await cancel.click()
    }
    await wallet.getByPlaceholder("5.00").fill(String(FUND))
    await wallet.getByRole("button", { name: "Create deposit quote" }).click()
    const codeEl = wallet.locator("p.font-mono.text-3xl")
    await codeEl.waitFor({ timeout: 70_000 })
    const code = (await codeEl.textContent())?.trim() ?? ""
    ok(`wallet shows teller code ${code} (QR ready for a phone demo)`)
    await shot(wallet, "3-deposit-code")

    step(`approve it as the teller: match ${code} and settle`)
    await teller.getByPlaceholder("Quote code — e.g. 9EC0F4").fill(code)
    await teller.getByRole("button", { name: "Match quote" }).click()
    const cashReceived = teller.getByRole("button", { name: "Cash received" })
    await cashReceived.waitFor({ timeout: 30_000 })
    ok("quote matched — deposit card open on the teller side")
    await shot(teller, "4-matched")
    await cashReceived.click()
    await teller.getByText("Match a quote").first().waitFor({ timeout: 30_000 })
    ok("deposit settled at the counter")

    step("wallet auto-claims the minted ecash")
    const fundedBy = Date.now() + 45_000
    for (;;) {
      balance = await readBalance(wallet)
      if (balance >= FUND - 0.01) break
      if (Date.now() > fundedBy) fail(`wallet never claimed — balance ${balance}`)
      await sleep(500)
    }
    ok(`balance after top-up: NOK ${balance.toFixed(2)}`)
    await shot(wallet, "5-funded")
  } else {
    ok("balance sufficient — skipping top-up (set PECAN_DEMO_FUND to force one)")
  }

  step(`charge: melt NOK ${BUDGET} to ${DEVICE} (${CHARGER_TAB})`)
  await resetWithdrawForm(wallet)
  const balanceBeforeCharge = await readBalance(wallet)
  const meltRefs = []
  wallet.on("response", async (response) => {
    if (!/\/v1\/(quote|melt|mint)/.test(response.url())) return
    try {
      const body = await response.json()
      for (const key of ["quote", "quote_id", "id"]) {
        const value = body?.[key]
        if (typeof value === "string" && /^[0-9a-f-]{16,}$/i.test(value)) meltRefs.push(value)
      }
    } catch {
      /* not JSON */
    }
  })

  await wallet.getByRole("tab", { name: CHARGER_TAB, exact: true }).click()
  await wallet.getByPlaceholder("1.00").fill(String(BUDGET))
  await wallet.getByRole("button", { name: "Start charging" }).click()
  await wallet.getByText(`Charging at ${CHARGER_TAB}`).first().waitFor({ timeout: 60_000 })
  ok(
    DEVICE === "atomV"
      ? "charging window open — the virtual charger is delivering"
      : `charging window open — the relay on ${DEVICE} should click now`,
  )
  await shot(wallet, "6-charging")

  step("monitor the live session via the gateway (delivered kW·s)")
  const sessionState = async () => {
    for (let i = meltRefs.length - 1; i >= 0; i--) {
      try {
        const r = await fetch(`${ORIGIN}/atom-gateway/session/${meltRefs[i]}/status`)
        if (r.ok) return await r.json()
      } catch {
        /* try the next candidate */
      }
    }
    return null
  }
  const chargeDeadline = Date.now() + 240_000
  let receipt = null
  while (Date.now() < chargeDeadline) {
    const session = await sessionState()
    if (session) {
      console.log(
        `[${elapsed()}]      charger ${DEVICE}: ${session.delivered}/${session.requested} kW·s delivered (state=${session.state})`,
      )
    }
    const receiptText = await wallet
      .locator("p.break-all.font-mono")
      .first()
      .textContent()
      .catch(() => null)
    if (receiptText && new RegExp(`EV-${DEVICE}-\\d+s-`).test(receiptText)) {
      receipt = receiptText.trim()
      break
    }
    await sleep(2_000)
  }
  if (!receipt) fail(`no ${DEVICE} receipt within 240s — is the charger online?`)
  ok(`receipt: ${receipt}`)
  await shot(wallet, "7-receipt")

  const delivered = Number(receipt.match(/-(\d+)s-/)?.[1] ?? 0)
  const finalDeadline = Date.now() + 200_000
  for (;;) {
    balance = await readBalance(wallet)
    // Deposit pattern: the whole budget melted up front, delivered kW·s
    // consumed, the unspent part refunded — final = before − delivered.
    if (Math.abs(balance - (balanceBeforeCharge - delivered)) < 0.02) break
    if (Date.now() > finalDeadline) break
    await sleep(1_000)
  }
  if (Math.abs(balance - (balanceBeforeCharge - delivered)) >= 0.02) {
    fail(`balance NOK ${balance.toFixed(2)} ≠ expected NOK ${(balanceBeforeCharge - delivered).toFixed(2)} (before ${balanceBeforeCharge} − delivered ${delivered})`)
  }
  const session = await sessionState()
  step("demo result")
  console.log(`  charger ${DEVICE}   : delivered ${delivered} kW·s (relay clicked, session ${session?.state ?? "closed"})`)
  console.log(`  gateway accounting : delivered=${session?.delivered ?? delivered} remaining=${session?.remaining ?? 0} requested=${session?.requested ?? BUDGET}`)
  console.log(`  receipt            : ${receipt}`)
  console.log(`  wallet balance     : NOK ${balance.toFixed(2)}`)
  console.log(`  artifacts          : ${SHOTS}/`)
  ok("live demo complete — windows stay open for hands-on play")
  await new Promise(() => undefined)
}

main().catch((err) => {
  console.error(`\n[${elapsed()}] DEMO FAILED: ${err.message}`)
  console.error(`      screenshots: ${SHOTS}/ — the browser stays open for inspection`)
})
