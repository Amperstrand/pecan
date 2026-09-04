import { test, expect } from "@playwright/test"

// The wallet lives at the ROOT path — the URL never encodes the
// currency (localStorage owns mint selection; the per-pair consoles
// stay at /{currency}-console/*). This pins the routing contract.
test("root domain serves the wallet; currency links are per-pair", async ({ page }) => {
  test.setTimeout(60_000)

  // / redirects to /wallet.
  await page.goto("/")
  await expect(page).toHaveURL(/\/wallet$/)

  // The wallet boots from the root path (assets resolve relatively).
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole("tab", { name: "EUR" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "USD" })).toBeVisible()

  // The footer links follow the ACTIVE currency's console (default EUR).
  await expect(page.getByRole("link", { name: "Operator console" })).toHaveAttribute(
    "href",
    ///eur-console/$,
  )

  // Switching currency re-targets the console links — selection lives in
  // the wallet, not the URL.
  await page.getByRole("tab", { name: "USD" }).click()
  await expect(page.getByRole("link", { name: "Operator console" })).toHaveAttribute(
    "href",
    ///usd-console/$,
  )
})
