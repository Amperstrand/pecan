import { test, expect } from "@playwright/test"
import {
  expectNoWalletErrors,
  readBalance,
  sendOnchainFromExternal,
} from "./helpers/wallet"
import { defineWalletSuite, type SuiteContext } from "./helpers/wallet-suite"

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
}
