# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: charger-sim.spec.ts >> charger sim mirror renders and reacts
- Location: e2e/charger-sim.spec.ts:6:1

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8791/dev/charger-sim.html
Call log:
  - navigating to "http://localhost:8791/dev/charger-sim.html", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test"
  2  | 
  3  | // Standalone check of the wasm mirror: dashboard renders, START drives
  4  | // the countdown + output LEDs, board banner present. Run with the
  5  | // dev server up: scripts/dev-server.sh (python http.server).
  6  | test("charger sim mirror renders and reacts", async ({ page }) => {
> 7  |   await page.goto("http://localhost:8791/dev/charger-sim.html")
     |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8791/dev/charger-sim.html
  8  |   await expect(page.locator("#board")).toHaveText(/atom/)
  9  |   await page.waitForTimeout(700)
  10 | 
  11 |   const before = await page.locator("#led0").getAttribute("class")
  12 |   expect(before).not.toContain("on")
  13 | 
  14 |   await page.evaluate(() =>
  15 |     window.postMessage(
  16 |       { type: "mqtt", topic: "charger/atomC/start", payload: JSON.stringify({ end: 0 }) },
  17 |       "*",
  18 |     ),
  19 |   )
  20 |   await page.waitForTimeout(300)
  21 |   await expect(page.locator("#led0")).toHaveClass(/on/)
  22 |   await expect(page.locator("#log div.rx").first()).toContainText("charger/atomC/start")
  23 | 
  24 |   await page.screenshot({ path: "e2e/.results/charger-sim-standalone.png" })
  25 | })
  26 | 
```