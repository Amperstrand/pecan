import { test } from "@playwright/test"
test("pw boot probe", async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto("/wallet")
  await page.getByRole("tab", { name: "FARM" }).click({ timeout: 60_000 })
  await page.getByLabel("production day").waitFor({ timeout: 30_000 })
})
