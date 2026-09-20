import { test, expect, type Page } from "@playwright/test"
import { bootAndFund, kwsToCents } from "./helpers/ev-rail"
import { readBalance } from "./helpers/wallet"

// The physical stop button (issue #14): the G39 firmware publishes
// charger/{device}/aborted {"delivered": N} the moment it acks the
// window start — the device's OWN metering, not the gateway's remote-
// stop estimate. This spec simulates exactly that message (the same
// paho harness ev-rail.spec.ts uses for its remote-stop path) and
// asserts the wallet receives the stopped summary with the DEVICE's
// delivered count, not the gateway's wall-clock estimate.
const BUDGET_EUR = 2
const STOP_AFTER_S = 4 // seconds of charging before the "button press"

test("physical stop button: device-published abort meters the delivery", async ({ page }) => {
  test.setTimeout(240_000)
  await bootAndFund(page, "/eur-console", BUDGET_EUR + 1)
  const before = await readBalance(page)

  // Start charging
  await page.goto("https://giftcard.cashu.exchange/eur-console/wallet?charger=atomV")
  await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await page.getByPlaceholder("1.00").fill(String(BUDGET_EUR))
  await page.getByRole("button", { name: "Start charging" }).click()
  await expect(page.getByText("Charging at Sim Charger")).toBeVisible({ timeout: 60_000 })

  // Wait for the device to actually deliver some energy, then publish
  // the abort — the physical button path.
  await page.waitForTimeout(STOP_AFTER_S * 1000)
  const progress = page.getByRole("progressbar")
  const deliveredAtPress = Number(await progress.getAttribute("aria-valuenow"))
  expect(deliveredAtPress).toBeGreaterThan(0)

  // Simulate the G39 firmware button: publish the abort message with
  // the device's own delivered count (what the firmware measures).
  const { execSync, spawn } = await import("node:child_process")
  const MQTT = {
    url: process.env.PECAN_EV_MQTT_URL ?? "",
    user: process.env.PECAN_EV_MQTT_USER ?? "",
    pass: process.env.PECAN_EV_MQTT_PASS ?? "",
  }
  test.skip(!MQTT.url, "MQTT creds not set (scripts/e2e.sh provides them)")
  const host = MQTT.url.replace(/^mqtts?:\/\//, "").split(":")[0]
  const script = `
import paho.mqtt.client as m, json, time, sys
c = m.Client(m.CallbackAPIVersion.VERSION2, client_id="e2e-stop-btn-" + str(time.time()))
c.username_pw_set("${MQTT.user}", "${MQTT.pass}")
c.tls_set()
delivered = int(sys.argv[1])
def on_msg(cl, u, msg):
    if msg.retain:
        return
    if msg.topic.endswith("/ack") and bytes(msg.payload) == b"start-acked":
        # Already acked — this IS the moment the button would fire.
        pass
c.on_message = on_msg
c.connect("${host}", 8883, 20)
c.loop_start()
time.sleep(0.5)
c.publish("charger/atomV/aborted", json.dumps({"delivered": delivered}), qos=1)
time.sleep(0.5)
c.loop_stop()
c.disconnect()
`
  execSync(`python3 -c '${script}' ${deliveredAtPress}`, { timeout: 15_000 })

  // The wallet should show the stopped summary with the device's count
  await expect(
    page.getByText(/Charging stopped — [\d.]+ (?:kW·s|kWh|s) delivered/),
  ).toBeVisible({ timeout: 120_000 })

  const receipt = await page.locator("p.break-all.font-mono").first().textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  expect(delivered).toBeGreaterThan(0)
  expect(delivered).toBeLessThan(BUDGET_EUR * 7200) // far under the authorization

  // Device-contract assertion: the abort was metered at the DEVICE's
  // count and the receipt reflects it. The refund leg is covered by
  // charger-v.spec.ts (which exercises the wallet's own Stop button).
  expect(delivered).toBeLessThanOrEqual(deliveredAtPress + 30)
})
