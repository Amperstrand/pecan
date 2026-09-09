import { expect, type Page } from "@playwright/test"
import { apiLogin, matchAndSettle, readBalance, readTellerCode } from "./wallet"

/// The charger-C e2e flow, shared by the standard suite (ev-rail.spec)
/// and the instrumented video run (ev-rail-video.spec) — one source of
/// truth for the wallet↔gateway↔charger contract walk.

export async function bootAndFund(page: Page, consoleBase: string, minBalance: number) {
  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
  })
  await page.goto(`${consoleBase}/wallet`)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
  if ((await readBalance(page)) < minBalance) {
    await page.getByPlaceholder("5.00").fill("15")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    const depCode = await readTellerCode(page)
    const password = process.env.PECAN_ADMIN_PASSWORD!
    await apiLogin(page, consoleBase, password)
    await matchAndSettle(page, depCode, "ev rail funding", consoleBase)
    await expect
      .poll(async () => readBalance(page), { timeout: 45_000 })
      .toBeGreaterThanOrEqual(minBalance)
  }
}

export async function chargeCOnly(page: Page, budget = 3) {
  const consoleBase = "/eur-console"
  const before = await readBalance(page)
  await page.getByRole("tab", { name: "Charger C", exact: true }).click()
  await page.getByPlaceholder("1.00").fill(String(budget))
  await page.getByRole("button", { name: "Start charging" }).click()

  await expect(page.getByText("⚡ Charging at Charger C")).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(
      async () =>
        Number(await page.getByRole("progressbar").getAttribute("aria-valuenow")),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(1)

  await expect(page.getByText(/Charged \d+ s at Charger C/)).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(/^EV-atomC-\d+s-[0-9A-F]{8}(-[A-Z]+)?$/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])

  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - delivered, 2)
}

export async function chargerCWindow(page: Page, budget = 3) {
  await bootAndFund(page, "/eur-console", budget + 1)
  await chargeCOnly(page, budget)
}
