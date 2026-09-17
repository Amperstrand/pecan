import { test, expect } from "@playwright/test"
import {
  apiLogin,
  expectNoWalletErrors,
  matchAndSettle,
  readBalance,
  readTellerCode,
  sendOnchainFromExternal,
} from "./helpers/wallet"
import { defineWalletSuite, type SuiteContext } from "./helpers/wallet-suite"
import { kwsToCents } from "./helpers/ev-rail"

// USD twin (issue #4): the shared per-currency suite plus the switcher
// checks. e2e.sh fetches both admin passwords.
defineWalletSuite(
  {
    currency: "usd",
    consoleBase: "/usd-console",
    password:
      process.env.PECAN_USD_ADMIN_PASSWORD ?? process.env.PECAN_ADMIN_PASSWORD ?? "",
    name: "USD wallet E2E (teller + lightning)",
  },
  registerUsdExtras,
)

function registerUsdExtras(ctx: SuiteContext): void {
  test("onchain deposit: address → payer → settle (USD rail)", async () => {
    const page = ctx.page()
    const before = await readBalance(page)

    await page.getByRole("button", { name: "On-chain", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("50")
    await page.getByRole("button", { name: "Create on-chain address" }).click()

    const card = page.locator('[data-testid="deposit-card"]').filter({
      hasText: "sat (signet) to:",
    })
    await card.waitFor({ state: "visible", timeout: 30_000 })
    const address = ((await card.locator("p.font-mono.select-all").textContent()) ?? "").trim()
    expect(address.startsWith("tb1")).toBeTruthy()

    const sendCaption = await page
      .getByText(/Send \d+ sat \(signet\)/)
      .textContent()
    const expectedSat = Number(sendCaption?.match(/\d+/)?.[0] ?? 0)
    expect(expectedSat).toBeGreaterThan(1000)

    const txid = sendOnchainFromExternal(address, expectedSat)
    expect(txid).toHaveLength(64)

    // 0-conf: settles as soon as esplora's mempool shows the utxo
    await expect
      .poll(async () => readBalance(page), { timeout: 120_000 })
      .toBeCloseTo(before + 50, 2)
    await expect(page.locator('[data-testid="deposit-card"]')).toHaveCount(0)
    expectNoWalletErrors(ctx.walletErrors())
  })


  // The USD twin of the charger lane (#10): ev-charge-usd watches this
  // console, so an ev:atomD melt must settle with a receipt — proving
  // the enabled rail, the second daemon instance, and the shared
  // gateway fleet end to end. Self-funds via the teller when short:
  // standalone greps start a fresh wallet and the onchain leg can be
  // payer-dry. Energy pricing: $1 = 36 kW·s at $100/kWh; the $1 budget
  // runs a 36 s meterless window on atomD.
  test("charger session: melt to ev:atomD settles with a receipt (USD)", async () => {
    test.setTimeout(240_000)
    const page = ctx.page()
    const password =
      process.env.PECAN_USD_ADMIN_PASSWORD ?? process.env.PECAN_ADMIN_PASSWORD ?? ""
    // 2 units keeps the refund above the mint's 1-unit minimum.
    const budget = 2

    let before = await readBalance(page)
    if (before < budget) {
      await apiLogin(page, ctx.consoleBase, password)
      const newDeposit = page.getByRole("button", { name: "New deposit" })
      if (await newDeposit.isVisible().catch(() => false)) {
        await newDeposit.click()
      }
      await page.getByRole("button", { name: "Teller", exact: true }).click()
      await page.getByPlaceholder("5.00").fill(String(budget + 1))
      await page.getByRole("button", { name: "Create deposit quote" }).click()
      const code = await readTellerCode(page)
      await matchAndSettle(page, code, `E2E ${ctx.currency} charger funding`, ctx.consoleBase)
      await expect
        .poll(async () => readBalance(page), { timeout: 45_000 })
        .toBeGreaterThan(before)
      before = await readBalance(page)
    }

    await page.getByRole("tab", { name: "Charger D", exact: true }).click()
    await page.getByPlaceholder("1.00").fill(String(budget))
    await page.getByRole("button", { name: "Start charging" }).click()
    await expect(page.getByText("⚡ Charging at Charger D")).toBeVisible({ timeout: 60000 })
    // Realistic tariff: natural caps take minutes at the unit minimum —
    // stop mid-session instead (how real sessions end).
    const progress = page.getByRole("progressbar")
    await expect
      .poll(async () => Number(await progress.getAttribute("aria-valuenow")), {
        timeout: 120_000,
        interval: 250,
      })
      .toBeGreaterThanOrEqual(340)
    await page.getByRole("button", { name: "Stop charging" }).click()
    await expect(
      page.getByText(/(Charging stopped — \d+ s delivered|Charged \d+ s at Charger D)/),
    ).toBeVisible({ timeout: 180000 })
    const receipt = await page.locator("p.break-all.font-mono").textContent()
    expect(receipt).toMatch(/^EV-atomD-\d+s-[0-9A-F]{8}(-[A-Z]+)?$/)
    const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
    await expect
      .poll(async () => readBalance(page), { timeout: 200000 })
      .toBeCloseTo(before - kwsToCents(delivered) / 100, 2)
    expectNoWalletErrors(ctx.walletErrors())
  })


  test("switching to EUR keeps the EUR balance intact", async () => {
    const page = ctx.page()
    await page.getByRole("tab", { name: "EUR" }).click()
    await expect(page.getByRole("tab", { name: "EUR" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    // EUR balance renders (0.00 or accumulated — the point is no crash and
    // a numeric display in €).
    await readBalance(page)

    await page.getByRole("tab", { name: "USD" }).click()
    await expect(page.getByRole("tab", { name: "USD" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  // The one-way-mint invariant, USD side of the matrix (EUR asserts it in
  // wallet.spec.ts): lightning and on-chain melt quotes must be refused —
  // the teller is the only exit rail.
  test("one-way mint: ln and btc melt quotes are refused", async () => {
    const page = ctx.page()

    const lnMelt = await page.request.post("/usd/v1/melt/quote/ln", {
      headers: { "Content-Type": "application/json" },
      data: { unit: "usd", amount: 500, request: "lntbs1test", rail: "ln" },
    })
    expect(lnMelt.status()).toBeGreaterThanOrEqual(400)

    const btcMelt = await page.request.post("/usd/v1/melt/quote/btc", {
      headers: { "Content-Type": "application/json" },
      data: { unit: "usd", amount: 500, request: "tb1qtest", rail: "btc" },
    })
    expect(btcMelt.status()).toBeGreaterThanOrEqual(400)
  })
}
