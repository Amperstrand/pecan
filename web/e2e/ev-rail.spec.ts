import { spawn, type ChildProcess } from "node:child_process"
import { test, expect, type Page } from "@playwright/test"
import { apiLogin, matchAndSettle, readBalance, readTellerCode } from "./helpers/wallet"

// Firmware-button simulation: publishes the exact MQTT message the G39
// press sends (charger/<device>/aborted {"delivered": k}) the moment the
// device acks the window start — retained ack replay ignored.
const MQTT = {
  url: process.env.PECAN_EV_MQTT_URL ?? "",
  user: process.env.PECAN_EV_MQTT_USER ?? "",
  pass: process.env.PECAN_EV_MQTT_PASS ?? "",
}

// The DEPOSIT pattern end to end (docs/partial-delivery.md): one €6 melt
// is the deposit; the wallet's slider tracks delivery on the gateway's
// public session endpoint (the melt quote id is the capability); the
// Stop button reaches the physical relay; the daemon settles the melt at
// full and the wallet claims the un-spent part as a refund mint quote
// the daemon validates against its delivery ledger. Final balance =
// before − delivered exactly — the refund closes the deposit gap.
const DEVICE = process.env.PECAN_EV_DEVICE ?? "atomA"
const TAB = `Charger ${DEVICE === "atomB" ? "B" : "A"}`
let buttonSim: ChildProcess | null = null
let btnReady = false

test.afterAll(() => buttonSim?.kill())

async function pressDeviceButton(delivered: number) {
  const host = MQTT.url.replace(/^mqtts?:\/\//, "").replace(/[:/].*$/, "")
  const script = [
    "import paho.mqtt.client as m, json, time",
    'c = m.Client(m.CallbackAPIVersion.VERSION2, client_id="e2e-btn-" + str(time.time()))',
    `c.username_pw_set("${MQTT.user}", "${MQTT.pass}")`,
    "c.tls_set()",
    "def on_msg(cl, u, msg):",
    '    print("RX", msg.topic, msg.retain, bytes(msg.payload)[:25], flush=True)',
    "    if msg.retain:",
    "        return",
    '    if msg.topic.endswith("/ack") and bytes(msg.payload) == b"start-acked":',
    `        cl.publish("charger/${DEVICE}/aborted", json.dumps({"delivered": ${delivered}}), qos=1)`,
    '        print("abort-published", flush=True)',
    "c.on_message = on_msg",
    "def on_sub(cl, userdata, mid, rcs, props=None):",
    '    print("subscribed", rcs, flush=True)',
    "c.on_subscribe = on_sub",
    "def on_conn(cl, u, f, rc, p=None):",
    `    cl.subscribe("charger/${DEVICE}/#")`,
    "c.on_connect = on_conn",
    `c.connect("${host}", 8883, 20)`,
    "c.loop_forever()",
  ].join("\n")
  buttonSim = spawn("python3", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] })
  const ready = new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15_000
    const poll = () => {
      if (buttonSim === null) return
      // The subscription confirmation must land BEFORE the session's
      // start ack, or the live ack is missed and the window runs full.
      if (btnReady) return resolve()
      if (Date.now() > deadline) return reject(new Error("button sim never subscribed"))
      setTimeout(poll, 200)
    }
    poll()
  })
  buttonSim.stdout!.on("data", (d) => {
    const t = String(d)
    process.stdout.write(`[btn-sim] ${t}`)
    if (t.includes("subscribed")) btnReady = true
  })
  buttonSim.stderr!.on("data", (d) => process.stdout.write(`[btn-sim:err] ${d}`))
  await ready
}

async function bootAndFund(page: Page, consoleBase: string, minBalance: number) {
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

test("ev rail: deposit pattern — slider, remote stop, refund of the unspent deposit", async ({ page }) => {
  test.setTimeout(300_000)
  const consoleBase = "/eur-console"
  const password = process.env.PECAN_ADMIN_PASSWORD
  test.skip(!password, "admin password unavailable")

  const budget = 6
  await bootAndFund(page, consoleBase, budget + 1)

  const before = await readBalance(page)
  await page.getByRole("tab", { name: TAB, exact: true }).click()
  await expect(page.getByLabel("Destination")).toHaveCount(0)
  await page.getByPlaceholder("1.00").fill(String(budget))
  await page.getByRole("button", { name: "Start charging" }).click()

  // The slider appears and tracks delivery against the 6 s window.
  await expect(page.getByText("⚡ Charging at " + TAB)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/€\d+\.00 of the deposit remaining/)).toBeVisible({
    timeout: 30_000,
  })
  // Let a second deliver, then stop from the BROWSER — the stop must
  // reach the relay through the gateway (public, quote-id capability).
  await expect
    .poll(
      async () =>
        Number(await page.getByRole("progressbar").getAttribute("aria-valuenow")),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(1)
  await page.getByRole("button", { name: "Stop charging" }).click()

  // Stopped summary with actual consumption from the device-side abort.
  await expect(page.getByText(/Charging stopped — \d+ s delivered/)).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(new RegExp(`^EV-${DEVICE}-[1-5]s-[0-9A-F]{8}-STOPPED$`))
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])

  // THE deposit-pattern assertion: the un-spent euros came back as a
  // refund quote the daemon settled — balance is exact, not approximate.
  await expect
    .poll(async () => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(before - delivered, 2)
  await expect(page.getByText(new RegExp(`€${delivered}\\.00 spent`))).toBeVisible()
  await expect(
    page.getByText(new RegExp(`€${budget - delivered}\\.00 refunded to your wallet`)),
  ).toBeVisible()
})

test("ev rail: device button abort meters actual delivery and refunds", async ({ page }) => {
  test.setTimeout(300_000)
  test.skip(!MQTT.url, "MQTT fixtures unavailable (run via scripts/e2e.sh)")
  const consoleBase = "/eur-console"

  const budget = 4
  await bootAndFund(page, consoleBase, budget + 1)
  btnReady = false
  await pressDeviceButton(2)

  const before = await readBalance(page)
  await page.getByRole("tab", { name: TAB, exact: true }).click()
  await page.getByPlaceholder("1.00").fill(String(budget))
  await page.getByRole("button", { name: "Start charging" }).click()

  // The simulated G39 press aborts with 2 s delivered; the daemon
  // settles the STOPPED receipt and the wallet claims the refund.
  await expect(page.getByText("Charging stopped — 2 s delivered")).toBeVisible({
    timeout: 180_000,
  })
  const receipt = await page.locator("p.break-all.font-mono").textContent()
  expect(receipt).toMatch(new RegExp(`^EV-${DEVICE}-2s-[0-9A-F]{8}-STOPPED$`))
  await expect(page.getByText("€2.00 refunded to your wallet")).toBeVisible({
    timeout: 120_000,
  })
  await expect
    .poll(async () => readBalance(page), { timeout: 120_000 })
    .toBeCloseTo(before - 2, 2)
})
