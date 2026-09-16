import { test, expect } from "@playwright/test"
import { bootAndFund } from "./helpers/ev-rail"
import { readBalance } from "./helpers/wallet"

// Charger V (atomV) — the API-only virtual device (ev-virtual-charger.
// service on inr2). The whole charger story — melt, slider, delivered
// kW·s, receipt, refund of the unspent budget — with ZERO hardware:
// this lane is what keeps demos (and the @smoke fleet check) green while
// the physical boxes are down.
// Budget sized for METERED truth (#30): the car draws 3-10 kW, so a
// 40 kW·s budget completes in roughly 4-13 wall seconds — comfortably
// visible, and far faster than the 40 s a wall-clock contract would
// need, which is exactly what the elapsed-time assertion below pins.
const BUDGET = 40

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
  await bootAndFund(page, "/eur-console", BUDGET + 1)
  const before = await readBalance(page)
  await page.goto(`${WALLET}?charger=atomV`)
  await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )

  const startedAt = Date.now()
  await page.getByPlaceholder("1.00").fill(String(BUDGET))
  await page.getByRole("button", { name: "Start charging" }).click()

  await expect(page.getByText("Charging at Sim Charger")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Charged \d+ s at Sim Charger/)).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  expect(delivered).toBe(BUDGET)
  // Metered proof: at the car's 3-10 kW draw the budget burns well
  // inside the wall-clock window — 30 s here rules out the legacy
  // constant-rate contract (which cannot finish a 40 kW·s budget in
  // under 40 s).
  expect(Date.now() - startedAt, "metered delivery beats wall-clock").toBeLessThan(30_000)

  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - delivered, 2)
})
