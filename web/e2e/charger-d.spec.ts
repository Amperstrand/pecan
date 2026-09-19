import { test, expect } from "@playwright/test"
import { bootAndFund, kwsToCents } from "./helpers/ev-rail"
import { readBalance } from "./helpers/wallet"

// Charger D end-to-end — the m5core-demo box (t-relay lineage). Device side
// may be the physical box or the atomD stand-in sim on inr2; the contract is
// identical. Full chain: wallet melt ev:atomD → mint → ev-charge daemon →
// atom-bridge → MQTT charger/atomD/* → ack → done → receipt EV-atomD-Ns-*.
// Energy pricing: €1 buys 36 kW·s at €100/kWh; D is meterless (1 kW), so
// the window runs the budget's full 36 wall seconds.
// 2 units keeps the refund above the mint's 1-unit minimum.
const BUDGET_EUR = 2

test("charger D deposit-pattern session end to end", async ({ page }) => {
  // The charge + refund legs alone budget 120s + 180s inside; the default
  // 60s test timeout would cut them off mid-wait on any slow delivery.
  test.setTimeout(240_000)
  await bootAndFund(page, "/eur-console", BUDGET_EUR + 1)
  const before = await readBalance(page)

  await page.getByRole("tab", { name: "Charger D", exact: true }).click()
  await page.getByPlaceholder("1.00").fill(String(BUDGET_EUR))
  await page.getByRole("button", { name: "Start charging" }).click()

  await expect(page.getByText("⚡ Charging at Charger D")).toBeVisible({ timeout: 60_000 })
  // Realistic tariff: natural caps take minutes at the unit minimum —
  // stop mid-session instead (how real sessions end).
  await expect
    .poll(
      async () => Number(await page.getByRole("progressbar").getAttribute("aria-valuenow")),
      { timeout: 120_000, interval: 250 },
    )
    .toBeGreaterThanOrEqual(340)

  await page.getByRole("button", { name: "Stop charging" }).click()
  await expect(
    page.getByText(/(Charging stopped — [\d.]+ (?:kW·s|kWh|s) delivered|Charged \d+ s at Charger D)/),
  ).toBeVisible({ timeout: 180_000 })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomD-\d+s-[0-9A-F]{8}(-[A-Z]+)?$/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])

  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - kwsToCents(delivered) / 100, 2)
})
