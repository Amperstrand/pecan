import { test, expect } from "@playwright/test"

test("two video contexts", async ({ browser }) => {
  test.setTimeout(90_000)
  console.error("MARK c1")
  const c1 = await browser.newContext({
    recordVideo: { dir: "e2e/.results-video/probe", size: { width: 420, height: 900 } },
  })
  console.error("MARK c1-up")
  const p1 = await c1.newPage()
  await p1.goto("https://giftcard.cashu.exchange/wallet", { waitUntil: "domcontentloaded" })
  await expect(p1.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 20_000 })
  await p1.waitForTimeout(2_000)
  await c1.close()
  console.error("MARK c1-closed")
  const c2 = await browser.newContext({
    recordVideo: { dir: "e2e/.results-video/probe", size: { width: 420, height: 900 } },
  })
  console.error("MARK c2-up")
  const p2 = await c2.newPage()
  await p2.goto("https://giftcard.cashu.exchange/wallet", { waitUntil: "domcontentloaded" })
  await expect(p2.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 20_000 })
  console.error("MARK c2-alive")
  await p2.waitForTimeout(2_000)
  await c2.close()
  console.error("MARK c2-closed")
})
