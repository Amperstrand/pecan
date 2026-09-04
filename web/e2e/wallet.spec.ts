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
  settleWithSimTeller,
  settleWithPayoutSim,
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
    // The deployment's confirmation policy drives every timeout below:
    // 0-conf settles on mempool visibility; n-conf waits n signet blocks
    // (~10 min each, budgeted at 2x). PECAN_E2E_ONCHAIN_CONF pins an
    // expectation for cycles that intentionally flip the policy — the
    // test then fails loudly on drift instead of timing out opaquely.
    const pinned = process.env.PECAN_E2E_ONCHAIN_CONF
    const page = ctx.page()
    test.setTimeout(150_000)

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

    const rail = await page.request
      .get(`${ctx.consoleBase}/api/onchain-status/${address}`)
      .then((r) => r.json())
    const conf = rail.required_confirmations as number
    if (pinned !== undefined) {
      expect(
        conf,
        "onchain confirmation policy drifted from PECAN_E2E_ONCHAIN_CONF",
      ).toBe(Number(pinned))
    }
    const settleTimeout = 120_000 + conf * 2 * 10 * 60_000
    test.setTimeout(settleTimeout + 60_000)

    const txid = sendOnchainFromExternal(address, expectedSat)
    expect(txid).toHaveLength(64)

    await expect
      .poll(async () => readBalance(page), { timeout: settleTimeout })
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
    // The polls below budget 90s; the default 60s cap turns the first
    // slow rate fetch or cold mint into a false failure.
    test.setTimeout(180_000)
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
    test.setTimeout(180_000)
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

  test("amount validation errors are visible client-side", { tag: "@smoke" }, async () => {
    const page = ctx.page()

    // Whichever test ran before us may have left the withdraw card in
    // its done phase, where the Send button is replaced by the receipt
    // block — reset the form so the Send click below can exist.
    const newWithdraw = page.getByRole("button", { name: "New withdraw" })
    if (await newWithdraw.isVisible()) await newWithdraw.click()

    // above the mint max — used to fail silently (the 1231234 regression)
    await page.getByPlaceholder("5.00").fill("1231234")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    await expect(page.getByText("not supported (mint limit)")).toBeVisible()

    await page.getByRole("button", { name: "Try again" }).click()
    await page.getByRole("button", { name: "On-chain", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("10")
    await page.getByRole("button", { name: "Create on-chain address" }).click()
    await expect(page.getByText("at least 50 €")).toBeVisible()

    // refused client-side: no quote is created, no teller ticket appears
    await page.getByRole("button", { name: "Try again" }).click()
    await page.getByPlaceholder("Phone or reference").fill("e2e-validation")
    await page.getByPlaceholder("1.00").fill("2000")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page.getByText("not supported (mint limit)")).toBeVisible()
    // Leave the form usable for the next test on this shared page.
    await page.getByRole("button", { name: "Try again" }).click()
  })

  test("sim-teller payout module auto-settles a withdraw", async () => {
    test.setTimeout(180_000)
    const page = ctx.page()
    const before = await readBalance(page)
    const origin = new URL(page.url()).origin

    const retry = page.getByRole("button", { name: "Try again" })
    if (await retry.isVisible().catch(() => false)) await retry.click()

    await page.getByPlaceholder("Phone or reference").fill("202-555-0173")
    await page.getByPlaceholder("1.00").fill("2")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const code = await readTellerCode(page)

    const settled = settleWithSimTeller(code, origin, ctx.consoleBase, 5000)
    expect(settled.result).toBe("settled")
    expect(settled.amount).toBe(200)
    await expect(page.getByText("Receipt — your proof of payment")).toBeVisible({ timeout: 30_000 })
    await waitForOpState(page, "melt", code, "finalized", 90_000)
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 2, 2)

    // Policy guard: above its cap the module abstains (no action), and a
    // human teller can still settle the same ticket from the console.
    await page.getByPlaceholder("Phone or reference").fill("202-555-0174")
    await page.getByPlaceholder("1.00").fill("2")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const refusedCode = await readTellerCode(page)
    const refused = settleWithSimTeller(refusedCode, origin, ctx.consoleBase, 100)
    expect(refused.result).toBe("refused")

    const ticket = await matchAndSettle(
      page,
      refusedCode,
      "human settles what the module refused",
      ctx.consoleBase,
    )
    expect(ticket.status).toBe("paid")
    await waitForOpState(page, "melt", refusedCode, "finalized", 90_000)
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 4, 2)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("backup restores a wiped wallet", async () => {
    const page = ctx.page()
    const before = await readBalance(page)
    expect(before).toBeGreaterThan(0)

    const [backup] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download backup (JSON)" }).click(),
    ])
    const backupPath = await backup.path()
    expect(backupPath).toBeTruthy()

    // The dev-tools force clear downloads its own dump first, then wipes
    // IndexedDB + seed and reloads into a fresh wallet.
    const [clearDump] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Force clear wallet" }).click(),
    ])
    await clearDump.path()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(async () => readBalance(page), { timeout: 30_000 })
      .toBe(0)

    await page.setInputFiles("#restore-file", backupPath!)
    await page.getByRole("button", { name: "Restore backup" }).click()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(async () => readBalance(page), { timeout: 30_000 })
      .toBeCloseTo(before, 2)

    const db = await readWalletDb(page)
    expect(db.spendableSum).toBe(before * 100)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("backup restores into a fresh browser (new-device migration)", async () => {
    const page = ctx.page()
    const before = await readBalance(page)
    expect(before).toBeGreaterThan(0)

    const [backup] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download backup (JSON)" }).click(),
    ])
    const backupPath = await backup.path()
    expect(backupPath).toBeTruthy()

    const browser = page.context().browser()
    expect(browser).toBeTruthy()
    const ctx2 = await browser!.newContext({ ignoreHTTPSErrors: true })
    await ctx2.addInitScript(
      (currency) => {
        window.localStorage.setItem("pecan-debug", "1")
        window.localStorage.setItem("pecan-currency", currency)
      },
      ctx.currency,
    )
    const page2 = await ctx2.newPage()
    await page2.goto(page.url())
    await expect(page2.getByRole("heading", { name: "Wallet" })).toBeVisible()

    // A fresh browser is a fresh wallet — zero balance before restore.
    await expect
      .poll(async () => readBalance(page2), { timeout: 20_000 })
      .toBe(0)

    await page2.setInputFiles("#restore-file", backupPath!)
    await page2.getByRole("button", { name: "Restore backup" }).click()
    await expect(page2.getByRole("heading", { name: "Wallet" })).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(async () => readBalance(page2), { timeout: 30_000 })
      .toBeCloseTo(before, 2)

    const db = await readWalletDb(page2)
    expect(db.spendableSum).toBe(before * 100)
    await ctx2.close()
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("opening the wallet in a second tab warns both tabs", async () => {
    const page = ctx.page()
    const page2 = await page.context().newPage()
    await page2.goto(page.url())

    await expect(page2.getByRole("alert")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 })

    // Web Lock liveness: closing the other tab clears the banner on
    // this one within a poll interval.
    await page2.close()
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 10_000 })
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("cross-currency concurrency: EUR invoice pending while USD teller settles", async () => {
    const page = ctx.page()
    const usdPassword = process.env.PECAN_USD_ADMIN_PASSWORD ?? ""
    test.skip(!usdPassword, "USD admin password unavailable")

    await page.getByRole("tab", { name: "EUR" }).click()
    const eurBefore = await readBalance(page)

    // EUR lightning invoice stays pending across the whole USD detour.
    await page.getByRole("button", { name: "Lightning", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("1")
    await page.getByRole("button", { name: "Create lightning invoice" }).click()
    const lnCard = page.locator('[data-testid="deposit-card"]').filter({
      hasText: "Pay this lightning invoice",
    })
    await lnCard.waitFor({ state: "visible", timeout: 30_000 })
    const invoice = (await lnCard.locator("p.font-mono.select-all").textContent())?.trim()
    expect(invoice!.startsWith("lntbs")).toBeTruthy()

    // Same wallet, other mint: a USD teller deposit settles end to end
    // while the EUR invoice is open.
    await page.getByRole("tab", { name: "USD" }).click()
    await expect(page.getByRole("tab", { name: "USD" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    const usdBefore = await readBalance(page)
    await page.getByRole("button", { name: "Teller", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("2")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    // The EUR invoice card is on screen too; the 6-char code lives only
    // on the teller card.
    const code = await readTellerCode(page)
    await apiLogin(page, "/usd-console", usdPassword)
    const ticket = await matchAndSettle(
      page,
      code,
      "E2E cross-currency USD teller",
      "/usd-console",
    )
    expect(ticket.status).toBe("paid")
    expect(ticket.unit).toBe("usd")
    await expect
      .poll(async () => readBalance(page), { timeout: 45_000 })
      .toBeCloseTo(usdBefore + 2, 2)

    // Now the EUR invoice settles too — both currencies credited on one
    // wallet, both cards cleared.
    const preimage = payLightningInvoice(invoice!)
    expect(preimage).toHaveLength(64)
    await page.getByRole("tab", { name: "EUR" }).click()
    await expect
      .poll(async () => readBalance(page), { timeout: 60_000 })
      .toBeCloseTo(eurBefore + 1, 2)
    await expect(page.locator('[data-testid="deposit-card"]')).toHaveCount(0)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("generic payout rail: sim adapter settles its rail and only its rail", async () => {
    test.setTimeout(180_000)
    const page = ctx.page()
    await apiLogin(page, ctx.consoleBase)
    const before = await readBalance(page)
    const origin = new URL(page.url()).origin

    // Sim rail via the picker: autosim settles it after the fund lock
    // and the wallet shows the receipt as the payment proof.
    await page.getByRole("tab", { name: "Sim" }).click()
    await page.getByPlaceholder("alias").fill("e2e-rail-alias")
    await page.getByPlaceholder("1.00").fill("2")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const railCode = await readTellerCode(page)
    await expect(page.getByText(/^SIM-[0-9A-F]{8}$/)).toBeVisible({
      timeout: 30_000,
    })
    await waitForOpState(page, "melt", railCode, "finalized", 90_000)
    await page.getByRole("button", { name: "New withdraw" }).click()
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 2, 2)

    // The adapter must refuse a plain teller ticket (wrong rail, no
    // action) — and a human can still settle what it abstained from.
    await page.getByRole("tab", { name: "Teller" }).click()
    await page.getByPlaceholder("Phone or reference").fill("e2e-plain-dest")
    await page.getByPlaceholder("1.00").fill("1")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const plainCode = await readTellerCode(page)
    const wrongRail = settleWithPayoutSim(plainCode, origin, ctx.consoleBase, 5000)
    expect(wrongRail.result).toBe("wrong-rail")
    expect(wrongRail.ticket_rail).toBeNull()
    const ticket = await matchAndSettle(
      page,
      plainCode,
      "human settles what the adapter refused",
      ctx.consoleBase,
    )
    expect(ticket.status).toBe("paid")
    await waitForOpState(page, "melt", plainCode, "finalized", 90_000)

    // A rail the deployment does not operate is refused at quote time.
    // The processor's reason is lost across the gRPC boundary (cdk
    // flattens every melt-quote refusal into "Unit unsupported"), so the
    // wallet maps that to a destination-refusal hint — and the real
    // guarantees are behavioral: no ticket, no teller code, funds intact.
    await page.getByPlaceholder("Phone or reference").fill("wire:e2e-disabled")
    await page.getByPlaceholder("1.00").fill("1")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByText("the rail may not be enabled here"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("p.font-mono.text-3xl")).toHaveCount(0)
    for (let i = ctx.walletErrors().length - 1; i >= 0; i--) {
      // The deliberate refusal logs both the wallet's caught error and
      // the browser's raw resource-400 line.
      if (
        ctx.walletErrors()[i].includes("Unit unsupported") ||
        ctx.walletErrors()[i].includes("status of 400")
      ) {
        ctx.walletErrors().splice(i, 1)
      }
    }
    await page.getByRole("button", { name: "Try again" }).click()

    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 3, 2)
    expectNoWalletErrors(ctx.walletErrors())
  })

  test("simulated EU bank rails: sepa and sepa-instant settle with receipt references", async () => {
    test.setTimeout(180_000)
    const page = ctx.page()
    await apiLogin(page, ctx.consoleBase)
    const before = await readBalance(page)
    test.skip(before < 4, "insufficient balance (chain funding filtered out)")

    // SEPA credit transfer: valid IBAN, receipt is an EndToEndId-style
    // reference — shown to the wallet as the payment proof, exactly
    // where Lightning displays its preimage. Autosim settles it.
    await page.getByRole("tab", { name: "SEPA" }).click()
    await page.getByPlaceholder("IBAN, e.g. NL33INGB0000000881").fill("NL33INGB0000000881")
    await page.getByPlaceholder("1.00").fill("2")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const sctCode = await readTellerCode(page)
    await expect(page.getByText(/^E2E-\d{6}-[0-9A-F]{8}$/)).toBeVisible({
      timeout: 30_000,
    })
    await waitForOpState(page, "melt", sctCode, "finalized", 90_000)
    await page.getByRole("button", { name: "New withdraw" }).click()

    // SEPA instant: same addressing, receipt is a UETR (UUID).
    await page.getByRole("tab", { name: "Instant" }).click()
    await page.getByPlaceholder("IBAN, e.g. DE96370205000003292912").fill("DE96370205000003292912")
    await page.getByPlaceholder("1.00").fill("1")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const instCode = await readTellerCode(page)
    await expect(
      page.getByText(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    ).toBeVisible({ timeout: 30_000 })
    await waitForOpState(page, "melt", instCode, "finalized", 90_000)
    await page.getByRole("button", { name: "New withdraw" }).click()

    // An invalid IBAN is refused at quote time — no ticket, no code, no
    // fund lock; the wallet names the likely cause.
    await page.getByRole("tab", { name: "SEPA" }).click()
    await page.getByPlaceholder("IBAN, e.g. NL33INGB0000000881").fill("ES57018223704000185702009")
    await page.getByPlaceholder("1.00").fill("1")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(
      page.getByText("the rail may not be enabled here"),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("p.font-mono.text-3xl")).toHaveCount(0)
    for (let i = ctx.walletErrors().length - 1; i >= 0; i--) {
      // The deliberate refusal logs the caught error plus the raw 400.
      if (
        ctx.walletErrors()[i].includes("Unit unsupported") ||
        ctx.walletErrors()[i].includes("status of 400")
      ) {
        ctx.walletErrors().splice(i, 1)
      }
    }
    await page.getByRole("button", { name: "Try again" }).click()

    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 3, 2)
    expectNoWalletErrors(ctx.walletErrors())
  })

  // Dummy destinations per scheme; each settles with the receipt format
  // that scheme actually issues, shown as the payment proof.
  const MOBILE_RAILS: Record<string, { destination: string; receipt: RegExp }> = {
    swish: { destination: "+46700000001", receipt: /^[0-9a-f]{32}$/ },
    mobilepay: { destination: "+45700000002", receipt: /^MP-\d{10}$/ },
    ideal: { destination: "NL33INGB0000000881", receipt: /^\d{16}$/ },
    bizum: { destination: "+34600000003", receipt: /^BZ\d{10}$/ },
  }

  // Typed as raw envelopes in the teller field — the other entry path
  // besides the picker; autosim settles each with its scheme receipt.
  // One test per rail: a failure names the rail and the rest still run.
  // (Playwright has no test.for — per-case test() registration is the idiom.)
  for (const rail of Object.keys(MOBILE_RAILS)) {
    test(`${rail} settles with its scheme receipt`, async () => {
      test.setTimeout(210_000)
      const page = ctx.page()
      await apiLogin(page, ctx.consoleBase)

      // Whichever test ran before us may have left the rail picker on
      // another rail — the teller field only exists on the Teller tab.
      await page.getByRole("tab", { name: "Teller" }).click()

      const c = MOBILE_RAILS[rail]!
      const before = await readBalance(page)
      await page
        .getByPlaceholder("Phone or reference")
        .fill(`${rail}:${c.destination}`)
      await page.getByPlaceholder("1.00").fill("1")
      await page.getByRole("button", { name: "Send", exact: true }).click()
      const code = await readTellerCode(page)
      await expect(
        page.getByText(new RegExp(`^${c.receipt.source}$`)),
        rail,
      ).toBeVisible({ timeout: 30_000 })
      await waitForOpState(page, "melt", code, "finalized", 90_000)
      await page.getByRole("button", { name: "New withdraw" }).click()
      await expect
        .poll(async () => readBalance(page), { timeout: 90_000 })
        .toBeCloseTo(before - 1, 2)
      expectNoWalletErrors(ctx.walletErrors())
    })
  }
}
