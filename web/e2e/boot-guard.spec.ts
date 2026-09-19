import { test, expect, type Page } from "@playwright/test"

// The 2026-09-17 incident: an experimental pair's keyset bloat (44
// keysets) plus eager multi-currency init made every FRESH wallet boot
// take 81s on any pair — invisible to CI, red for every wallet spec,
// live for returning users. This guard boots with a FRESH profile (no
// localStorage/IDB — warm boots hide the class entirely) and asserts
// the balance renders in a human-budget time. It runs per pair.
const PAIRS = [
  { id: "eur", base: "/eur-console" },
  { id: "usd", base: "/usd-console" },
  { id: "nok", base: "/nok-console" },
]

// Generous but finite: healthy boots land in ~1-3s; the incident class
// measured 81s. 15s catches the regression with margin for slow CI.
const BOOT_BUDGET_MS = 15_000

for (const pair of PAIRS) {
  test(`${pair.id}: fresh wallet boot reaches balance in seconds @smoke`, async ({ browser }) => {
    // A fresh context = a first-visit user: no seed, no IDB, no cache.
    // This is the only profile shape that catches eager-init bloat.
    const context = await browser.newContext()
    const page: Page = await context.newPage()
    const started = Date.now()
    await page.goto(`https://giftcard.cashu.exchange${pair.base}/wallet`)
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 30_000 })
    // The balance element ("0.00 €" etc.) proves the wallet finished
    // initializing — not just the static page shell.
    await page.locator(".text-4xl.tabular-nums").first().waitFor({ state: "visible", timeout: BOOT_BUDGET_MS })
    const elapsed = Date.now() - started
    // Assert with the explicit budget so failures name the number.
    expect(elapsed, `fresh boot took ${elapsed}ms (budget ${BOOT_BUDGET_MS}ms)`).toBeLessThan(BOOT_BUDGET_MS)
    await context.close()
  })
}

// The second half of the incident: eager multi-currency init. A fresh
// boot should NOT fetch keysets/keys from every registered mint — only
// the active pair's. This catches the regression class directly.
test("fresh boot stays under the keyset-request budget @smoke", async ({ browser }) => {
  const context = await browser.newContext()
  const page: Page = await context.newPage()
  const mintUrls: string[] = []
  page.on("request", (req) => {
    const url = req.url()
    if (/\/v1\/(keys|keysets)\b/.test(url)) mintUrls.push(url)
  })
  await page.goto("https://giftcard.cashu.exchange/eur-console/wallet")
  await page.locator(".text-4xl.tabular-nums").first().waitFor({ state: "visible", timeout: BOOT_BUDGET_MS })
  await page.waitForTimeout(1_000) // let any stragglers fire
  // Five mints × (keys + keysets) ≈ 10-15 requests healthy; the bloat
  // incident multiplied this by keyset count. 30 is the tripwire.
  // (Lazy per-currency init remains a worthwhile wallet improvement;
  // this guard holds the line until then.)
  expect(
    mintUrls.length,
    `fresh boot made ${mintUrls.length} keyset/keys requests (budget 30)`,
  ).toBeLessThanOrEqual(30)
  await context.close()
})
