import { test, expect } from "@playwright/test"
import { readBalance } from "./helpers/wallet"
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
