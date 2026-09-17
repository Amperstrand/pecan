import { test, expect } from "@playwright/test"
import { bootAndFund, kwsToCents } from "./helpers/ev-rail"
import { readBalance } from "./helpers/wallet"

// Charger V (atomV) — the API-only virtual device (ev-virtual-charger.
// service on inr2). The whole charger story — melt, slider, delivered
// kW·s, receipt, budget-cap completion — with ZERO hardware: this lane
// is what keeps demos (and the @smoke fleet check) green while the
// physical boxes are down.
//
// Realistic tariff (#30 layer B, 2026-09-17 round): €0.50/kWh with a
// staged ramp (3 kW -> 7 kW -> 22 kW). A €1 melt authorizes 7200 kW·s
// (2 kWh); with the suite's fast stage timers the car reaches stage 3
// within seconds and the test STOPS mid-session (how real sessions
// end) asserting metered stop-billing: spent cents == delivered kW·s
// at €0.50/kWh, the rest refunds. Natural-cap completion is covered by
// virtual-charger.sh selftest (device-level).
// Budget 2 units: after cents of charging the refund stays above the
// mint's 1-unit minimum quote (a 1-unit budget strands its refund).
const BUDGET_EUR = 2
const BUDGET_KWS = 14400 // 200 cents * 36/0.5
const STOP_AT = 340 // ~10 Wh: past all three ramp stages

test("charger V: virtual device session end to end (no hardware) @smoke", async ({ page }) => {
  // Internal waits (charge receipt, refund) budget up to 180s; the
  // default 60s test timeout would cut them off mid-wait.
  test.setTimeout(240_000)
  const WALLET = "https://giftcard.cashu.exchange/eur-console/wallet"
  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
  })
  // The charge point's QR is a deep link (?charger=atomV): the Sim
  // Charger rail must arrive preselected — scanning is the whole
  // interaction. Asserted on first boot and again after funding
  // (bootAndFund re-navigates to the plain wallet URL).
  await page.goto(`${WALLET}?charger=atomV`)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await bootAndFund(page, "/eur-console", BUDGET_EUR + 1)
  const before = await readBalance(page)
  await page.goto(`${WALLET}?charger=atomV`)
  await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )

  const startedAt = Date.now()
  await page.getByPlaceholder("1.00").fill(String(BUDGET_EUR))
  await page.getByRole("button", { name: "Start charging" }).click()

  await expect(page.getByText("Charging at Sim Charger")).toBeVisible({ timeout: 60_000 })
  const progress = page.getByRole("progressbar")
  await expect
    .poll(async () => Number(await progress.getAttribute("aria-valuenow")), {
      timeout: 120_000,
      interval: 250,
    })
    .toBeGreaterThanOrEqual(STOP_AT)
  await page.getByRole("button", { name: "Stop charging" }).click()
  await expect(
    page.getByText(/(Charging stopped — [\d.]+ (?:kW·s|kWh) delivered|Charged \d+ s at Sim Charger)/),
  ).toBeVisible({ timeout: 180_000 })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}(-[A-Z]+)?$/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  // Stopped past every ramp stage; far under the authorization.
  expect(delivered).toBeGreaterThanOrEqual(STOP_AT)
  expect(delivered).toBeLessThan(BUDGET_KWS / 10)
  // Metered proof: 340+ kW·s in well under 340 s of wall time rules
  // out any constant-rate contract at these amounts.
  expect(Date.now() - startedAt, "metered delivery beats wall-clock").toBeLessThan(120_000)
  // Stop-billing: spent = delivered kW·s at €0.50/kWh (cent-rounded),
  // the unspent authorization refunds.
  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - kwsToCents(delivered) / 100, 2)
})
