import { test, expect } from "@playwright/test"
import { readBalance, payLightningInvoice } from "./helpers/wallet"

// The FULL NOK demo, end to end: Lightning deposit (real signet bolt11 paid
// by cln-hub-signet) → NOK ecash minted at giftcard-nok → Charger D melt →
// ev-charge-nok daemon → atom-bridge → the physical m5core-demo box →
// receipt + refund. Simulated money (signet + NOK), real relay click.
const DEPOSIT = 6
const BUDGET = 4

test("NOK: lightning deposit then charger D session end to end", async ({ page }) => {
  // Internal waits (invoice, charge receipt, refund) budget up to 180s;
  // the default 60s test timeout would cut them off mid-wait.
  test.setTimeout(240_000)
  await page.addInitScript(() => {
    localStorage.setItem("pecan-debug", "1")
    localStorage.setItem("pecan-currency", "nok")
  })
  await page.goto("https://giftcard.cashu.exchange/nok-console/wallet")
  await page.waitForSelector("h1:has-text('Wallet')", { timeout: 60000 })

  // HARD currency selection + assertion — an earlier version of this test
  // passed while silently running on EUR (the wallet init didn't honor the
  // stored currency). Click the tab like a user, then prove the unit.
  await page.getByRole("tab", { name: "NOK", exact: true }).click()
  await expect(page.getByRole("tab", { name: "NOK", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".text-4xl.tabular-nums").first()).toContainText("kr", { timeout: 20000 })

  // --- Lightning deposit: invoice -> pay from the CLN signet node ---
  await page.getByRole("button", { name: "Lightning", exact: true }).click()
  await page.getByPlaceholder("5.00").fill(String(DEPOSIT))
  await page.getByRole("button", { name: "Create lightning invoice" }).click()
  const invoiceBox = page.locator('p.font-mono:has-text("lntbs")')
  await invoiceBox.waitFor({ state: "visible", timeout: 30000 })
  const invoice = ((await invoiceBox.textContent()) ?? "").trim()
  expect(invoice.startsWith("lntbs")).toBeTruthy()
  const preimage = payLightningInvoice(invoice)
  expect(preimage).toHaveLength(64)
  await expect
    .poll(async () => readBalance(page), { timeout: 60000 })
    .toBeGreaterThanOrEqual(DEPOSIT)

  // --- Charger D: the physical ancestor box ---
  const before = await readBalance(page)
  await page.getByRole("tab", { name: "Charger D", exact: true }).click()
  await page.getByPlaceholder("1.00").fill(String(BUDGET))
  await page.getByRole("button", { name: "Start charging" }).click()
  await expect(page.getByText("⚡ Charging at Charger D")).toBeVisible({ timeout: 60000 })
  await expect(page.getByText(/Charged \d+ s at Charger D/)).toBeVisible({ timeout: 180000 })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomD-\d+s-[0-9A-F]{8}(-[A-Z]+)?$/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  await expect
    .poll(async () => readBalance(page), { timeout: 200000 })
    .toBeCloseTo(before - delivered, 2)
})
