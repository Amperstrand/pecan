import { test, expect } from "@playwright/test"
import { bootAndFund } from "./helpers/ev-rail"
import { readBalance } from "./helpers/wallet"

// Charger V (atomV) — the API-only virtual device (ev-virtual-charger.
// service on inr2). The whole charger story — melt, slider, delivered
// kW·s, receipt, refund of the unspent budget — with ZERO hardware:
// this lane is what keeps demos (and the @smoke fleet check) green while
// the physical boxes are down.
const BUDGET = 3

test("charger V: virtual device session end to end (no hardware) @smoke", async ({ page }) => {
  // Internal waits (charge receipt, refund) budget up to 180s; the
  // default 60s test timeout would cut them off mid-wait.
  test.setTimeout(240_000)
  await bootAndFund(page, "/eur-console", BUDGET + 1)
  const before = await readBalance(page)

  await page.getByRole("tab", { name: "Charger V", exact: true }).click()
  await page.getByPlaceholder("1.00").fill(String(BUDGET))
  await page.getByRole("button", { name: "Start charging" }).click()

  await expect(page.getByText("Charging at Charger V")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Charged \d+ s at Charger V/)).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  expect(delivered).toBe(BUDGET)

  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - delivered, 2)
})
