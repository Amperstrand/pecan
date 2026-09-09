import { test, expect } from "@playwright/test"

// Standalone check of the wasm mirror: dashboard renders, START drives
// the countdown + output LEDs, board banner present. Run with the
// dev server up: scripts/dev-server.sh (python http.server).
test("charger sim mirror renders and reacts", async ({ page }) => {
  await page.goto("http://localhost:8791/dev/charger-sim.html")
  await expect(page.locator("#board")).toHaveText(/atom/)
  await page.waitForTimeout(700)

  const before = await page.locator("#led0").getAttribute("class")
  expect(before).not.toContain("on")

  await page.evaluate(() =>
    window.postMessage(
      { type: "mqtt", topic: "charger/atomC/start", payload: JSON.stringify({ end: 0 }) },
      "*",
    ),
  )
  await page.waitForTimeout(300)
  await expect(page.locator("#led0")).toHaveClass(/on/)
  await expect(page.locator("#log div.rx").first()).toContainText("charger/atomC/start")

  await page.screenshot({ path: "e2e/.results/charger-sim-standalone.png" })
})
