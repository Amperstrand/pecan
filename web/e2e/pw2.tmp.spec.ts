import { test, expect } from "@playwright/test"
test("pw eur boot to number", async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto("/wallet")
  await expect
    .poll(async () => (await page.locator(".text-4xl").first().textContent().catch(() => "")) ?? "", { timeout: 60_000 })
    .toMatch(/\d/)
})
