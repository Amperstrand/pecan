import { test, expect, type Page } from "@playwright/test"
import { spawn, execSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import QRCode from "qrcode"
import { payLightningInvoice, readBalance } from "./helpers/wallet"

// ALICE AT THE CHARGE POINT — the movie. One continuous phone-viewport
// recording of the full lifecycle: a Lightning invoice paid, ecash
// minted, the charge point's QR deep link scanned, energy delivered by
// the SIM CHARGER (atomV — an API, no hardware), a mid-session stop,
// and the unspent euros refunded. Every frame is the real deployed
// stack on the EUR pair of giftcard.cashu.exchange.
//
//   scripts/movie.sh          (preflight + env + this spec + video)
//
// Story cards and the charge-point sticker are DOM overlays; the
// charger's own display rides as the corner PiP (charger-sim wasm,
// atom board) fed by the same MQTT stream a real pole would receive.
// Text cards are baked in — voiceover is a post-production layer.

test.skip(!process.env.PECAN_VIDEO, "movie run only (run scripts/movie.sh)")

const WALLET = "https://giftcard.cashu.exchange/eur-console/wallet"
const DEEP_LINK = `${WALLET}?charger=atomV`
const DEPOSIT_EUR = 50
const STOP_AT_KWS = 30

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

// ---------------------------------------------------------------------------
// movie chrome: overlay cards injected into the page
// ---------------------------------------------------------------------------

async function card(page: Page, opts: {
  title?: string
  body?: string
  qrDataUrl?: string
  holdMs: number
  caption?: boolean
}) {
  await page.evaluate(
    ({ title, body, qrDataUrl, caption }) => {
      const prev = document.getElementById("movie-card")
      prev?.remove()
      const el = document.createElement("div")
      el.id = "movie-card"
      el.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483646",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:18px",
        "padding:32px",
        "background:radial-gradient(120% 120% at 50% 0%, #0b1220 0%, #050810 70%)",
        "color:#e6edf3",
        "font-family:Inter,system-ui,sans-serif",
        "text-align:center",
      ].join(";")
      const titleEl = title
        ? `<div style="font-size:30px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;max-width:340px">${title}</div>`
        : ""
      const bodyEl = body
        ? `<div style="font-size:17px;line-height:1.5;color:#9fb0c3;max-width:330px">${body}</div>`
        : ""
      const qrEl = qrDataUrl
        ? `<img src="${qrDataUrl}" width="210" height="210" style="border-radius:12px;background:#fff;padding:10px" alt="charge point QR" />` +
          `<div style="font-size:13px;color:#9fb0c3">Scan to charge · Pay with Lightning</div>`
        : ""
      const brand = caption === false ? "" : `<div style="position:absolute;bottom:26px;font-size:12px;color:#5b6b7f;letter-spacing:0.14em">CASHU CHARGE CO.</div>`
      el.innerHTML = `${titleEl}${bodyEl}${qrEl}${brand}`
      document.body.appendChild(el)
    },
    { title: opts.title, body: opts.body, qrDataUrl: opts.qrDataUrl, caption: opts.caption },
  )
  await page.waitForTimeout(opts.holdMs)
}

async function hideCard(page: Page) {
  await page.evaluate(() => document.getElementById("movie-card")?.remove())
}

async function mountSimPip(page: Page) {
  const board = process.env.PECAN_SIM_BOARD ?? "atom"
  await page.evaluate(
    board => {
      const f = document.createElement("iframe")
      f.id = "charger-sim-pip"
      f.src = `https://localhost:8793/dev/charger-sim.html?board=${board}&pip=1`
      f.style.cssText = [
        "position:fixed",
        "top:6px",
        "right:6px",
        "width:170px",
        "height:322px",
        // Display-only: the mirror must never eat taps meant for the
        // wallet underneath (its fixed overlay once blocked the deposit
        // rail buttons and the retries jittered the recording).
        "pointer-events:none",
        "z-index:2147483647",
        "border:2px solid #38bdf8",
        "border-radius:8px",
        "background:#0b0e14",
      ].join(";")
      document.body.appendChild(f)
    },
    board,
  )
  const pip = page.frameLocator("#charger-sim-pip")
  await pip.locator("#canvas").waitFor({ state: "attached", timeout: 15_000 })
  // The mirror registers its message listener only after its wasm module
  // finishes loading — a creds postMessage sent at canvas-attach is lost.
  // Keep re-posting until the broker status reads connected.
  const creds = {
    type: "creds",
    url: process.env
      .PECAN_EV_MQTT_URL!.replace("mqtts://", "wss://")
      .replace(":8883", ":8884") + "/mqtt",
    user: process.env.PECAN_EV_MQTT_USER,
    pass: process.env.PECAN_EV_MQTT_PASS,
  }
  const postCreds = () =>
    page.evaluate(cred => {
      ;(document.getElementById("charger-sim-pip") as HTMLIFrameElement)
        .contentWindow!
        .postMessage(cred, "*")
    }, creds)
  await expect
    .poll(
      async () => {
        await postCreds()
        return pip.locator("#mqstat").textContent()
      },
      { timeout: 30_000 },
    )
    .toBe("connected")
}

// ---------------------------------------------------------------------------
// the story
// ---------------------------------------------------------------------------

test("Alice at the charge point — full lifecycle movie", async ({ page }) => {
  test.setTimeout(360_000)

  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
  })
  await page.goto(WALLET)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 30_000 })

  // SCENE 1 — Meet Alice
  await card(page, { title: "Meet Alice.", holdMs: 3_500 })
  await card(page, { title: "Alice drives an electric car.", holdMs: 3_000 })
  await card(page, {
    title: "Her phone has an app for every charging network.",
    body: "eChargeGo · Voltly · PowerPort · kWh! · Chargr · eFlow",
    holdMs: 4_500,
  })
  await card(page, {
    title: "Every few months: re-enter the credit card.",
    body: "…in all six apps.",
    holdMs: 4_000,
  })
  await card(page, {
    title: "Last spring, one network leaked its users' charging history.",
    body: "Home addresses, habits, overnight stops — onto the darknet.",
    holdMs: 5_000,
  })
  await card(page, {
    title: "Alice just wants to plug in, pay, and drive.",
    body: "Over Lightning. Like cash.",
    holdMs: 4_000,
  })

  // SCENE 2 — the charge point (the QR is real: it IS the deep link)
  const qrDataUrl = await QRCode.toDataURL(DEEP_LINK, { margin: 1, width: 420 })
  await card(page, {
    title: "A charge point.",
    qrDataUrl,
    holdMs: 6_000,
    caption: false,
  })
  await card(page, {
    title: "No screen to trust. No card reader.",
    body: "Just a QR that opens the wallet.",
    qrDataUrl,
    holdMs: 5_000,
    caption: false,
  })

  // SCENE 3 — Alice opens the wallet on her phone
  await hideCard(page)
  await mountSimPip(page)
  await card(page, {
    title: "No app store. No sign-up.",
    body: "A web page holding bearer ecash — cash for kilowatts.",
    holdMs: 1_200,
  })
  await hideCard(page)
  await expect.poll(() => readBalance(page)).toBeCloseTo(0, 2)
  await page.waitForTimeout(1_500)

  // SCENE 4 — top up over Lightning: a real bolt11, paid for real
  await page.getByRole("button", { name: "Lightning", exact: true }).click()
  await page.getByPlaceholder("5.00").fill(String(DEPOSIT_EUR))
  await page.getByRole("button", { name: "Create lightning invoice" }).click()
  const invoice = await page
    .locator('p.font-mono:has-text("lntbs")')
    .first()
    .textContent({ timeout: 60_000 })
  expect(invoice).toBeTruthy()
  await page.waitForTimeout(3_000)
  // The payer ssh can wedge transiently on a loaded workstation; CLN
  // dedupes by payment hash, so retrying pay on the same bolt11 is safe.
  const pay = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return payLightningInvoice(invoice!.trim())
      } catch (err) {
        if (attempt >= 3) throw err
        await new Promise(resolve => setTimeout(resolve, 5_000))
      }
    }
  }
  const paying = pay()
  await card(page, {
    title: "Alice pays from her Lightning wallet ⚡",
    body: "A real invoice — settled on Lightning (signet).",
    holdMs: 6_000,
  })
  await hideCard(page)
  await paying
  await expect
    .poll(() => readBalance(page), { timeout: 90_000 })
    .toBeCloseTo(DEPOSIT_EUR, 1)
  await card(page, {
    title: `€${DEPOSIT_EUR}, minted as ecash.`,
    body: "No name. No card. No account attached.",
    holdMs: 4_500,
  })
  await hideCard(page)
  await page.waitForTimeout(1_000)

  // SCENE 5 — scan the charge point: the QR is the deep link
  await card(page, { title: "Back at the pole, Alice scans the QR…", holdMs: 3_000 })
  await page.goto(DEEP_LINK)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 30_000 })
  await mountSimPip(page)
  await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await card(page, {
    title: "The QR is just a link.",
    body: "It hands the wallet the charge point. Nothing else leaves Alice's phone.",
    holdMs: 4_500,
  })
  await hideCard(page)
  await page.waitForTimeout(1_000)

  // SCENE 6 — charge: €50 authorized, ~30 kW·s used, then Alice stops
  await page.getByPlaceholder("1.00").fill(String(DEPOSIT_EUR))
  await page.getByRole("button", { name: "Start charging" }).click()
  await expect(page.getByText("Charging at Sim Charger")).toBeVisible({ timeout: 60_000 })
  await card(page, {
    title: `€${DEPOSIT_EUR} of energy, authorized.`,
    body: "Metered by the charge point, second by second. The corner screen is the charger's own display.",
    holdMs: 6_000,
  })
  await hideCard(page)
  const progress = page.getByRole("progressbar")
  await expect
    .poll(async () => Number(await progress.getAttribute("aria-valuenow")), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(STOP_AT_KWS)
  await page.getByRole("button", { name: "Stop charging" }).click()
  // Remote-stop summary reads "Charging stopped — N s delivered"; a
  // natural full-budget completion reads "Charged N s at …". Accept both.
  await expect(
    page.getByText(/(Charging stopped — \d+ s delivered|Charged \d+ s at Sim Charger)/),
  ).toBeVisible({ timeout: 180_000 })
  const receipt = await page.locator("p.break-all.font-mono").first().textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])

  // SCENE 7 — receipt & close: the unspent euros come back
  await expect
    .poll(() => readBalance(page), { timeout: 200_000 })
    .toBeCloseTo(DEPOSIT_EUR - delivered, 1)
  await card(page, {
    title: `Alice paid for ${delivered} kilowatt-seconds.`,
    body: `The other €${DEPOSIT_EUR - delivered} came back — automatically.`,
    holdMs: 5_500,
  })
  await card(page, {
    title: "No app. No card on file. No charging history.",
    body: "Ecash is cash.",
    holdMs: 5_000,
  })
  await card(page, {
    title: "Pay for energy the way you pay for anything else.",
    body: "Lightning in. Kilowatt-seconds out.",
    holdMs: 5_000,
  })
  await card(page, {
    title: "pecan · Cashu · Lightning",
    body: "giftcard.cashu.exchange",
    holdMs: 5_000,
  })
})
