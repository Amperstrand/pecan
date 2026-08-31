import { test, expect } from "@playwright/test"
import {
  apiLogin,
  expectNoWalletErrors,
  finalizedMeltChange,
  matchAndSettle,
  payLightningInvoice,
  readBalance,
  readTellerCode,
  readWalletDb,
  sendOnchainFromExternal,
  waitForOpState,
} from "./helpers/wallet"
import {
  DEPOSIT_AMOUNT,
  defineWalletSuite,
  type SuiteContext,
} from "./helpers/wallet-suite"

// EUR deep tests: on-chain rail, one-way-mint guarantees, and the durable
// saga scenarios (reload mid-withdraw, lost swap response) — currency-
// independent wallet machinery exercised through the EUR pair.
const EUR_BASE = "/eur-console"

defineWalletSuite(
  {
    currency: "eur",
    consoleBase: EUR_BASE,
    password: process.env.PECAN_ADMIN_PASSWORD ?? "",
    name: "EUR wallet E2E (teller + lightning + on-chain)",
  },
  registerEurExtras,
)

function registerEurExtras(ctx: SuiteContext): void {
  test("onchain deposit: external wallet → mempool → settled → receipt", async () => {
    const page = ctx.page()
    // Signet blocks can take 5-30+ minutes; adapt timeout to current cadence
    const blocks = await page.request
      .get("https://mempool.space/signet/api/blocks")
      .then((r) => r.json())
    const now = Math.floor(Date.now() / 1000)
    const intervals = blocks.slice(0, 3).map(
      (b: { timestamp: number }, i: number) =>
        i === 0 ? now - b.timestamp : blocks[i - 1].timestamp - b.timestamp,
    )
    const avgInterval =
      intervals.reduce((a: number, b: number) => a + b, 0) / intervals.length
    const timeout = Math.min(Math.ceil((avgInterval * 3) / 60) * 60_000, 1_800_000)
    test.setTimeout(timeout + 60_000)

    const before = await readBalance(page)

    await page.getByRole("button", { name: "On-chain", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("50")
    await page.getByRole("button", { name: "Create on-chain address" }).click()

    const addressBox = page.locator('p.font-mono:has-text("tb1")')
    await addressBox.waitFor({ state: "visible", timeout: 30_000 })
    const address = (await addressBox.textContent())?.trim() ?? ""
    expect(address.startsWith("tb1")).toBeTruthy()

    const sendCaption = await page
      .getByText(/Send \d+ sat \(signet\)/)
      .textContent()
    const expectedSat = Number(sendCaption?.match(/\d+/)?.[0] ?? 0)
    expect(expectedSat).toBeGreaterThan(1000)

    const txid = sendOnchainFromExternal(address, expectedSat)
    expect(txid).toHaveLength(64)

    // At 0 required confirmations the rail settles on mempool visibility and
    // the deposit card can go straight to claimed — the "detected in mempool"
    // toast only reliably exists while confirmations are actually required.
    const rail = await page.request
      .get(`${ctx.consoleBase}/api/onchain-status/${address}`)
      .then((r) => r.json())
    if (rail.required_confirmations >= 1) {
      await expect(
        page.getByText("Payment detected in mempool"),
      ).toBeVisible({ timeout: 30_000 })
    }

    await expect
      .poll(async () => readBalance(page), { timeout })
      .toBeCloseTo(before + 50, 2)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("one-way mint: ln and btc melt quotes are refused", async () => {
    const page = ctx.page()

    const lnMelt = await page.request.post("/eur/v1/melt/quote/ln", {
      headers: { "Content-Type": "application/json" },
      data: { unit: "eur", amount: 500, request: "lntbs1test", rail: "ln" },
    })
    expect(lnMelt.status()).toBeGreaterThanOrEqual(400)

    const btcMelt = await page.request.post("/eur/v1/melt/quote/btc", {
      headers: { "Content-Type": "application/json" },
      data: { unit: "eur", amount: 500, request: "tb1qtest", rail: "btc" },
    })
    expect(btcMelt.status()).toBeGreaterThanOrEqual(400)
  })

  test("withdraw survives reload (durable saga)", async () => {
    const page = ctx.page()
    await apiLogin(page, ctx.consoleBase)

    const start = await readBalance(page)

    await page.getByPlaceholder("5.00").fill(String(DEPOSIT_AMOUNT)).catch(() => {})
    if (start < DEPOSIT_AMOUNT * 2) {
      await page.getByPlaceholder("5.00").fill(String(DEPOSIT_AMOUNT))
      await page.getByRole("button", { name: "Create deposit quote" }).click()
      const depCode = await readTellerCode(page)
      await matchAndSettle(
        page,
        depCode,
        "E2E reload-saga funding",
        ctx.consoleBase,
      )
      await expect
        .poll(async () => readBalance(page), { timeout: 45_000 })
        .toBeCloseTo(start + DEPOSIT_AMOUNT, 2)
    }

    const before = await readBalance(page)
    await page.getByPlaceholder("Phone or reference").fill("e2e-reload")
    await page.getByPlaceholder("1.00").fill(String(DEPOSIT_AMOUNT))
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const code = await readTellerCode(page)

    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

    const ticket = await matchAndSettle(
      page,
      code,
      "E2E payout after reload",
      ctx.consoleBase,
    )
    expect(ticket.status).toBe("paid")

    await waitForOpState(page, "melt", code, "finalized", 90_000)
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - DEPOSIT_AMOUNT, 2)
    expectNoWalletErrors(ctx.walletErrors())

    // The fund-lock log entry fired pre-reload and the ring buffer is page
    // memory; the code being readable before the reload already proves the
    // lock completed (the code renders only after createWithdraw resolves).
    const sagaChange = await finalizedMeltChange(page, code)
    expect(
      sagaChange,
      "reload-saga melt settles with zero change",
    ).toBe(0)
  })

  test("self-custody state persists across reload", async () => {
    const page = ctx.page()
    const before = await readBalance(page)

    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

    const after = await readBalance(page)
    expect(after).toBe(before)

    const db = await readWalletDb(page)
    expect(db.spendableSum).toBe(before * 100)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("history shows finalized transactions without pending tags", async () => {
    const page = ctx.page()
    const history = page.locator("div.flex.items-center.justify-between.py-1")
    await expect(history.first()).toBeVisible()
    const rows = await history.allTextContents()
    expect(
      rows.some((r) => r.includes("Deposit") && !r.includes("pending")),
    ).toBeTruthy()
    expect(rows.some((r) => r.includes("Withdraw"))).toBeTruthy()
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("cancelled invoice can be replaced; deposits run concurrently across rails", async () => {
    const page = ctx.page()
    await apiLogin(page, ctx.consoleBase)

    const before = await readBalance(page)

    // Invoice A (€2) — then cancel its card.
    await page.getByRole("button", { name: "Lightning", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("2")
    await page.getByRole("button", { name: "Create lightning invoice" }).click()
    const cardA = page.locator('[data-testid="deposit-card"]').filter({
      hasText: "Pay this lightning invoice",
    })
    await cardA.waitFor({ state: "visible", timeout: 30_000 })
    const invoiceA = (await cardA.locator("p.font-mono.select-all").textContent())?.trim()
    await cardA.getByRole("button", { name: "Cancel" }).click()
    await expect(cardA).toHaveCount(0)

    // Invoice B (€1) — a DIFFERENT amount, immediately after the cancel.
    await page.getByPlaceholder("5.00").fill("1")
    await page.getByRole("button", { name: "Create lightning invoice" }).click()
    const cardB = page.locator('[data-testid="deposit-card"]').filter({
      hasText: "Pay this lightning invoice",
    })
    await cardB.waitFor({ state: "visible", timeout: 30_000 })
    const invoiceB = (await cardB.locator("p.font-mono.select-all").textContent())?.trim()
    expect(invoiceB).toBeTruthy()
    expect(invoiceB).not.toBe(invoiceA)
    expect(invoiceB!.startsWith("lntbs")).toBeTruthy()

    // While invoice B is still pending, open a teller deposit (€5) —
    // two cards from different rails coexist.
    await page.getByRole("button", { name: "Teller", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("5")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    const tellerCard = page.locator('[data-testid="deposit-card"]').filter({
      hasText: "Give this code to the teller",
    })
    await tellerCard.waitFor({ state: "visible", timeout: 30_000 })
    await expect(page.locator('[data-testid="deposit-card"]')).toHaveCount(2)
    const code = ((await tellerCard.locator("p.font-mono.text-3xl").textContent()) ?? "").trim()

    // Settle both in parallel: pay the invoice, settle the teller quote.
    const preimage = payLightningInvoice(invoiceB!)
    expect(preimage).toHaveLength(64)
    await matchAndSettle(page, code, "E2E concurrent teller", ctx.consoleBase)

    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before + 6, 2)
    await expect(page.locator('[data-testid="deposit-card"]')).toHaveCount(0)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("cancelled card stays cancelled across a reload", async () => {
    const page = ctx.page()

    await page.getByRole("button", { name: "Lightning", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("1")
    await page.getByRole("button", { name: "Create lightning invoice" }).click()
    const card = page.locator('[data-testid="deposit-card"]').filter({
      hasText: "Pay this lightning invoice",
    })
    await card.waitFor({ state: "visible", timeout: 30_000 })
    await card.getByRole("button", { name: "Cancel" }).click()
    await expect(card).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
    // The cancelled quote must not come back as a pending card.
    await page.waitForTimeout(2500)
    await expect(
      page.locator('[data-testid="deposit-card"]'),
    ).toHaveCount(0)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("lost swap response recovers via mint restore", async () => {
    const page = ctx.page()
    await apiLogin(page, ctx.consoleBase)

    // Every denomination in circulation is an even power of two, so an
    // odd-cent amount is unreachable by any subset sum: the €5.99 withdraw
    // MUST overshoot and take the pre-swap path, whatever the inherited
    // balance happens to be. This test runs last — assert relatively.
    const before = await readBalance(page)
    expect(before).toBeGreaterThanOrEqual(6)

    let swapKilled = false
    await page.route("**/v1/swap", async (route) => {
      await route.fetch()
      swapKilled = true
      await route.abort()
    })

    await page.getByPlaceholder("Phone or reference").fill("swap-kill")
    await page.getByPlaceholder("1.00").fill("5.99")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.waitForTimeout(4000)
    expect(swapKilled, "the swap request reached the mint").toBe(true)
    // Disarm the killer BEFORE any later swap: the post-restore withdraw
    // may itself need a pre-swap (the restored odd coin overshoots), and
    // an armed route would kill it too.
    await page.unroute("**/v1/swap")

    // Reload: recovery must detect the spent swap inputs and restore the
    // outputs from the mint (NUT-06 restore) instead of losing them.
    // The deliberate abort above logged a net::ERR_FAILED console error —
    // drop it before the error gate judges the wallet.
    for (let i = ctx.walletErrors().length - 1; i >= 0; i--) {
      if (ctx.walletErrors()[i].includes("net::ERR_FAILED")) {
        ctx.walletErrors().splice(i, 1)
      }
    }
    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before, 2)

    // The aborted withdraw's ticket waits forever — void it so the ledger
    // stays clean, then prove a normal withdraw still works end to end.
    const killCode = page.locator("p.font-mono.text-3xl")
    if (await killCode.isVisible().catch(() => false)) {
      const code = ((await killCode.textContent()) ?? "").trim()
      if (/^[A-Z0-9]{6}$/.test(code)) {
        const match = await page.request
          .post(`${ctx.consoleBase}/api/quotes/match`, {
            headers: { "Content-Type": "application/json" },
            data: { code },
          })
          .then((r) => r.json())
          .catch(() => null)
        if (match?.id) {
          await page.request
            .post(`${ctx.consoleBase}/api/tickets/${match.id}/mark-failed`, {
              headers: { "Content-Type": "application/json" },
              data: { notes: "E2E swap-kill cleanup" },
            })
            .catch(() => {})
        }
      }
    }

    await page.getByPlaceholder("Phone or reference").fill("after-restore")
    await page.getByPlaceholder("1.00").fill("5")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const code = await readTellerCode(page)
    const ticket = await matchAndSettle(
      page,
      code,
      "E2E payout after restore",
      ctx.consoleBase,
    )
    expect(ticket.status).toBe("paid")
    await waitForOpState(page, "melt", code, "finalized", 90_000)
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 5, 2)
    const change = await finalizedMeltChange(page, code)
    expect(change, "post-restore melt settles with zero change").toBe(0)
    expectNoWalletErrors(ctx.walletErrors())
  })
}
