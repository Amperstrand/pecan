import { test, expect } from "@playwright/test"
import { bootAndFund, kwsToCents } from "./helpers/ev-rail"
import { readBalance } from "./helpers/wallet"

// Charger V (atomV) — the API-only virtual device (ev-virtual-charger.
// service on inr2). The whole charger story — melt, slider, delivered
// kW·s, receipt, budget-cap completion — with ZERO hardware: this lane
// is what keeps demos (and the @smoke fleet check) green while the
// physical boxes are down.
//
// Energy pricing (#30 layer B): a €1 melt buys 36 kW·s of METERED
// budget at the deployment's €100.00/kWh tariff. The car draws 3-10 kW,
// so the budget completes in roughly 3.6-12 wall seconds — visible by
// design, and far faster than the 36 s a wall-clock contract would need
// for the same energy, which is exactly what the elapsed-time assertion
// below pins: under energy pricing the WALL TIME depends on the load,
// not on the budget's numeric value.
const BUDGET_EUR = 1
const BUDGET_KWS = 36 // 100 cents * 36/100 at €100/kWh

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
  await expect(page.getByText(/Charged \d+ s at Sim Charger/)).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  // Meter-capped at the full budget: the 36 kW·s the €1 bought.
  expect(delivered).toBe(BUDGET_KWS)
  // Metered proof: at the car's 3-10 kW draw the 36 kW·s budget burns
  // in 3.6-12 wall seconds — 30 s here rules out the legacy constant-
  // rate contract (which needs the budget's full 36 s of wall time).
  expect(Date.now() - startedAt, "metered delivery beats wall-clock").toBeLessThan(30_000)

  // The full budget was consumed: billed cents == melted cents, no
  // refund leg. Balance drops by exactly the melt.
  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - kwsToCents(delivered) / 100, 2)
})
