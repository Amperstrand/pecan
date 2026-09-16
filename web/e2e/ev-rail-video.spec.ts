import { test, expect, type Page } from "@playwright/test"
import { spawn, execSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { bootAndFund, chargeCOnly } from "./helpers/ev-rail"

// Instrumented video run: the real charger C flow with the firmware's
// own display mirrored LIVE on the wallet page — a corner iframe hosts
// the wasm sim, which subscribes to the same broker stream the ESP32
// receives. The recorded video shows the wallet and the charger's
// self-view in one frame. Headed by default so a human can watch.
//
//   PECAN_VIDEO=1 ../scripts/e2e.sh --no-preflight \
//     -g "display mirror" --config playwright.video.config.ts
//
// The config's bypassCSP exists for exactly this: the deployment CSP
// (frame-src 'self') is correct in production but blocks the localhost
// mirror iframe in the demo harness.

test.skip(!process.env.PECAN_VIDEO, "instrumented run only (set PECAN_VIDEO=1)")

let server: ChildProcess | null = null

test.beforeAll(() => {
  const certdir = "/tmp/sim-https"
  fs.mkdirSync(certdir, { recursive: true })
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${certdir}/key.pem -out ${certdir}/cert.pem ` +
      `-days 2 -nodes -subj "/CN=localhost" 2>/dev/null`,
  )
  server = spawn("node", ["e2e/helpers/sim-https-server.cjs", process.cwd()], {
    stdio: "ignore",
  })
})

test.afterAll(() => server?.kill())

async function mountSimPip(page: Page) {
  const board = process.env.PECAN_SIM_BOARD ?? "s3"
  await page.evaluate(
    ({ board }) => {
      const f = document.createElement("iframe")
      f.id = "charger-sim-pip"
      f.src = `https://localhost:8793/dev/charger-sim.html?board=${board}&pip=1`
      f.style.cssText = [
        "position:fixed",
        "top:6px",
        "right:6px",
        "width:206px",
        "height:394px",
        "z-index:2147483647",
        "border:2px solid #38bdf8",
        "border-radius:8px",
        "background:#0b0e14",
      ].join(";")
      document.body.appendChild(f)
    },
    { board },
  )
  const pip = page.frameLocator("#charger-sim-pip")
  await pip.locator("#canvas").waitFor({ state: "attached", timeout: 15_000 })
  await expect(pip.locator("#board")).toContainText("atom", { timeout: 10_000 })

  await page.evaluate(
    creds => {
      ;(document.getElementById("charger-sim-pip") as HTMLIFrameElement)
        .contentWindow!
        .postMessage(creds, "*")
    },
    {
      type: "creds",
      url: process.env
        .PECAN_EV_MQTT_URL!.replace("mqtts://", "wss://")
        .replace(":8883", ":8884") + "/mqtt",
      user: process.env.PECAN_EV_MQTT_USER,
      pass: process.env.PECAN_EV_MQTT_PASS,
    },
  )
  await expect(pip.locator("#mqstat")).toHaveText("connected", { timeout: 20_000 })
}

test("charger C with live display mirror", async ({ page }) => {
  test.setTimeout(300_000)
  await bootAndFund(page, "/eur-console", 4)
  await mountSimPip(page)
  await chargeCOnly(page, 3)
})
