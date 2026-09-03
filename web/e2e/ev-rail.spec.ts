import { test, expect } from "@playwright/test"
import { apiLogin, matchAndSettle, readBalance, readTellerCode } from "./helpers/wallet"

// The DEPOSIT pattern end to end (docs/partial-delivery.md): one €6 melt
// is the deposit; the wallet's slider tracks delivery on the gateway's
// public session endpoint (the melt quote id is the capability); the
// Stop button reaches the physical relay; the daemon settles the melt at
// full and the wallet claims the un-spent part as a refund mint quote
// the daemon validates against its delivery ledger. Final balance =
// before − delivered exactly — the refund closes the deposit gap.
const DEVICE = process.env.PECAN_EV_DEVICE ?? "atomA"
const TAB = `Charger ${DEVICE === "atomB" ? "B" : "A"}`

test("ev rail: deposit pattern — slider, remote stop, refund of the unspent deposit", async ({ page }) => {
  test.setTimeout(300_000)
  const consoleBase = "/eur-console"
  const password = process.env.PECAN_ADMIN_PASSWORD
  test.skip(!password, "admin password unavailable")

  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
  })
  await page.goto(`${consoleBase}/wallet`)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

  const budget = 6
  if ((await readBalance(page)) < budget + 1) {
    await page.getByPlaceholder("5.00").fill("15")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    const depCode = await readTellerCode(page)
    await apiLogin(page, consoleBase, password)
    await matchAndSettle(page, depCode, "ev rail funding", consoleBase)
    await expect
      .poll(async () => readBalance(page), { timeout: 45_000 })
      .toBeGreaterThanOrEqual(budget + 1)
  }

  const before = await readBalance(page)
  await page.getByRole("tab", { name: TAB, exact: true }).click()
  await expect(page.getByLabel("Destination")).toHaveCount(0)
  await page.getByPlaceholder("1.00").fill(String(budget))
  await page.getByRole("button", { name: "Start charging" }).click()

  // The slider appears and tracks delivery against the 6 s window.
  await expect(page.getByText("⚡ Charging at " + TAB)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/€\d+\.00 of the deposit remaining/)).toBeVisible({
    timeout: 30_000,
  })
  // Let a second deliver, then stop from the BROWSER — the stop must
  // reach the relay through the gateway (public, quote-id capability).
  await expect
    .poll(
      async () =>
        Number(await page.getByRole("progressbar").getAttribute("aria-valuenow")),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(1)
  await page.getByRole("button", { name: "Stop charging" }).click()

  // Stopped summary with actual consumption from the device-side abort.
  await expect(page.getByText(/Charging stopped — \d+ s delivered/)).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(new RegExp(`^EV-${DEVICE}-[1-5]s-[0-9A-F]{8}-STOPPED$`))
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])

  // THE deposit-pattern assertion: the un-spent euros came back as a
  // refund quote the daemon settled — balance is exact, not approximate.
  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - delivered, 2)
  await expect(page.getByText(new RegExp(`€${delivered}\\.00 spent`))).toBeVisible()
  await expect(
    page.getByText(new RegExp(`€${budget - delivered}\\.00 refunded to your wallet`)),
  ).toBeVisible()
})
