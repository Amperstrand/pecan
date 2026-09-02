import { test, expect, type Page } from "@playwright/test"
import { apiLogin, matchAndSettle, readBalance, readTellerCode } from "./helpers/wallet"

// The EV rail, self-serve end to end: melt on a charger tab → the ev-charge
// daemon on inr2 settles it (atom-gateway → HiveMQ → the physical Atom
// relay) → receipt on the wallet. Nobody hands over a teller code — the
// pending card says "Charging at …" and resolves on its own. The daemon
// runs the demo tariff (1 s per euro), so a €1 melt buys a 1 s window.
// PECAN_EV_DEVICE selects the charger (default atomA). Local,
// hardware-free testing stays possible via payout/ev-device-fake.py +
// ev-charge.py --watch against a local console — this spec always tests
// the production path.
const DEVICE = process.env.PECAN_EV_DEVICE ?? "atomA"
const TAB = `Charger ${DEVICE === "atomB" ? "B" : "A"}`

async function bootWallet(page: Page, consoleBase: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
  })
  await page.goto(`${consoleBase}/wallet`)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
}

test("ev rail: charger tab melt fires the charger, no destination needed", async ({ page }) => {
  test.setTimeout(240_000)
  const consoleBase = "/eur-console"
  const password = process.env.PECAN_ADMIN_PASSWORD
  test.skip(!password, "admin password unavailable")

  await bootWallet(page, consoleBase)

  if ((await readBalance(page)) < 5) {
    await page.getByPlaceholder("5.00").fill("5")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    const depCode = await readTellerCode(page)
    await apiLogin(page, consoleBase, password)
    await matchAndSettle(page, depCode, "ev rail funding", consoleBase)
    await expect
      .poll(async () => readBalance(page), { timeout: 45_000 })
      .toBeGreaterThanOrEqual(5)
  }

  const before = await readBalance(page)
  // Fixed-destination rail: the charger tab carries the full envelope —
  // no destination input, and the pending card never shows a teller code.
  await page.getByRole("tab", { name: TAB, exact: true }).click()
  await expect(page.getByLabel("Destination")).toHaveCount(0)
  await page.getByPlaceholder("1.00").fill("1")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByText(`⚡ Charging at ${TAB}`)).toBeVisible({ timeout: 20_000 })

  // The wallet surfaces the session record where Lightning shows preimages
  // (the daemon's poll interval plus the 1 s window are inside this).
  await expect(page.getByText(new RegExp(`^EV-${DEVICE}-1s-[0-9A-F]{8}$`))).toBeVisible({
    timeout: 90_000,
  })
  await expect
    .poll(async () => readBalance(page), { timeout: 90_000 })
    .toBeCloseTo(before - 1, 2)
})
