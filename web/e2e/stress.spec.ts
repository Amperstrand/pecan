import { test, expect } from "@playwright/test"
import { apiLogin, matchAndSettle, readBalance, readTellerCode } from "./helpers/wallet"

// Soak tool (@stress — excluded from default runs; run explicitly with
// scripts/e2e.sh -g @stress): alternates
// teller and SEPA-picker withdraws on one long-lived page, zero sat, with
// a main-thread heartbeat and a per-iteration stall probe that dumps the
// withdraw card phase when the teller code fails to appear.
const RAILS: Array<{ tab: string; auto: boolean; fill: [string, string] }> = [
  { tab: "Teller", auto: false, fill: ["Phone or reference", "e2e-stress"] },
  { tab: "SEPA", auto: true, fill: ["IBAN, e.g. NL33INGB0000000881", "NL33INGB0000000881"] },
  { tab: "Instant", auto: true, fill: ["IBAN, e.g. DE96370205000003292912", "DE96370205000003292912"] },
]

test("stress: alternating rail withdraws on one page", { tag: "@stress" }, async ({ page }) => {
  test.setTimeout(420_000)
  const consoleBase = "/eur-console"
  page.on("console", (m) => {
    if (m.text().startsWith("[hb]")) console.log(m.text())
  })
  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
    let last = Date.now()
    setInterval(() => {
      const now = Date.now()
      if (now - last > 1500) console.log(`[hb] main thread blocked ${now - last}ms`)
      last = now
    }, 250)
  })
  await page.goto(`${consoleBase}/wallet`)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
  await apiLogin(page, consoleBase)

  await page.getByPlaceholder("5.00").fill("25")
  await page.getByRole("button", { name: "Create deposit quote" }).click()
  const depCode = await readTellerCode(page)
  await matchAndSettle(page, depCode, "stress funding", consoleBase)
  await expect
    .poll(async () => readBalance(page), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(25)

  for (let i = 0; i < 18; i++) {
    const rail = RAILS[i % RAILS.length]!
    const before = await readBalance(page)
    const t0 = Date.now()
    await page.getByRole("tab", { name: rail.tab, exact: true }).click()
    const [placeholder, value] = rail.fill
    await page.getByPlaceholder(placeholder, { exact: true }).fill(value)
    await page.getByPlaceholder("1.00").fill("1")
    await page.getByRole("button", { name: "Send", exact: true }).click()

    // Stall probe: if the teller code is not up promptly, dump the card —
    // its text names the phase (creating spinner / error / pending), the
    // missing diagnostic from the suite failures.
    const codeUp = await (async () => {
      try {
        await readTellerCode(page)
        return true
      } catch {
        await page.waitForTimeout(10_000)
        try {
          await readTellerCode(page)
          return true
        } catch {
          const card = page
            .getByRole("heading", { name: "Withdraw" })
            .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]")
          const text = await card
            .textContent()
            .catch(() => "<card unreadable>")
          console.log(`STALL iter ${i} rail ${rail.tab}: card="${text?.slice(0, 300)}"`)
          return false
        }
      }
    })()
    if (!codeUp) throw new Error(`stalled at iter ${i} (rail ${rail.tab})`)

    const code = await readTellerCode(page)
    if (!rail.auto) {
      // Autosim rails settle themselves after the fund lock; match-and-
      // settle on them would hit a closed quote.
      await matchAndSettle(page, code, `stress melt ${i}`, consoleBase)
    }
    await page
      .getByText("Receipt — your proof of payment")
      .waitFor({ state: "visible", timeout: 30_000 })
    await expect
      .poll(async () => readBalance(page), { timeout: 60_000 })
      .toBeCloseTo(before - 1, 2)
    // Deterministic reset: wait for the done receipt, then New withdraw —
    // isVisible-once races the pending→done flip and misses (60s linger).
    await page
      .getByText("Receipt — your proof of payment")
      .waitFor({ state: "visible", timeout: 30_000 })
    await page.getByRole("button", { name: "New withdraw" }).click()
    console.log(`iter ${i} rail ${rail.tab}: ${(Date.now() - t0) / 1000 | 0}s`)
  }
})
