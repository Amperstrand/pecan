import { test, expect, type Page } from "@playwright/test"
import { apiLogin, matchAndSettle, readBalance, readTellerCode } from "./helpers/wallet"

// The EV rail as a streaming charge session (design A,
// docs/payout-modules.md): the wallet melts one €1 chunk per second; a
// Stop ends the stream and the un-melted budget stays in the wallet —
// partial sessions with no refund machinery. The daemon on inr2 settles
// each chunk against the physical Atom (PECAN_EV_DEVICE selects the
// charger, default atomA).
const DEVICE = process.env.PECAN_EV_DEVICE ?? "atomA"
const TAB = `Charger ${DEVICE === "atomB" ? "B" : "A"}`

test("ev rail: streaming charge spends per second and stops with change kept", async ({ page }) => {
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
  // Budget 3 → the wallet streams at most three €1 chunks.
  await page.getByRole("tab", { name: TAB, exact: true }).click()
  await expect(page.getByLabel("Destination")).toHaveCount(0)
  await page.getByPlaceholder("1.00").fill("3")
  await page.getByRole("button", { name: "Start charging" }).click()

  // The live counter: first chunk settles → "1 / 3 s".
  await expect(page.getByText("1 / 3 s")).toBeVisible({ timeout: 120_000 })
  await page.getByRole("button", { name: "Stop charging" }).click()

  // Partial session: summary shows 1 s delivered, change kept.
  await expect(page.getByText(/Charging stopped — \d+ s delivered/)).toBeVisible({
    timeout: 120_000,
  })
  const summary = await page
    .getByText(/Charging stopped — (\d+) s delivered/)
    .textContent()
  const delivered = Number(summary!.match(/(\d+) s delivered/)![1])
  expect(delivered).toBeGreaterThanOrEqual(1)
  expect(delivered).toBeLessThan(3)
  await expect(page.getByText(/€\d+\.00 spent/)).toBeVisible()
  await expect(page.getByText(/EV-atom[AB]-\d+s-[0-9A-F]{8}/)).toBeVisible()

  // Exact accounting: only the delivered seconds left the wallet.
  await expect
    .poll(async () => readBalance(page), { timeout: 60_000 })
    .toBeCloseTo(before - delivered, 2)
})
