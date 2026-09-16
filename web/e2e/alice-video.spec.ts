import { test, expect, type Page } from "@playwright/test"
import { payLightningInvoice, readBalance } from "./helpers/wallet"

// ALICE AT THE CHARGE POINT — the movie. One continuous phone-viewport
// recording of the full lifecycle: a Lightning invoice paid, ecash
// minted, the charge point's QR deep link scanned, energy delivered by
// the SIM CHARGER (atomV — an API, no hardware), a mid-session stop,
// and the unspent euros refunded. Every frame is the real deployed
// stack on the EUR pair of giftcard.cashu.exchange.
//
//   scripts/movie.sh [--remote]      (preflight + env + this spec + video)
//
// The charger's presence on screen is the COMPANION STRIP: a landscape
// status bar pinned to the bottom edge (single charger, live session
// numbers, never covering the wallet, pointer-transparent). It reads
// the wallet's own live DOM (the charging slider's progressbar + the
// summary text) — one truth, two views. The firmware's wasm display
// mirror stays in the ev-rail-video lane: it cannot show atomV
// sessions (it mirrors the atom box's A+B chargers) and its portrait
// shape covers the phone UI — see the charger-display issue.
//
// Text cards are baked in; voiceover is a post-production layer.

test.skip(!process.env.PECAN_VIDEO, "movie run only (run scripts/movie.sh)")

const WALLET = "https://giftcard.cashu.exchange/eur-console/wallet"
const DEEP_LINK = `${WALLET}?charger=atomV`
const DEPOSIT_EUR = 50
const STOP_AT_KWS = 30

// ---------------------------------------------------------------------------
// movie chrome: overlay cards + the companion strip
// ---------------------------------------------------------------------------

const CHROME_CSS = `
  #movie-card {
    position: fixed; inset: 0; z-index: 2147483646;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 18px; padding: 32px; text-align: center;
    background: radial-gradient(120% 120% at 50% 0%, #0b1220 0%, #050810 70%);
    color: #e6edf3; font-family: Inter, system-ui, sans-serif;
    opacity: 0; transition: opacity .45s ease;
  }
  #movie-card.show { opacity: 1; }
  #movie-card .title { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; max-width: 340px; }
  #movie-card .body  { font-size: 17px; line-height: 1.5; color: #9fb0c3; max-width: 330px; }
  #movie-card img   { border-radius: 12px; background: #fff; padding: 10px; }
  #movie-card .brand { position: absolute; bottom: 26px; font-size: 12px; color: #5b6b7f; letter-spacing: .14em; }
  #movie-card .dots::after { content: "\\2b8b"; display: inline-block; margin-left: 6px; animation: movie-dots 1s steps(4) infinite; }
  @keyframes movie-dots { 0%{content:"\\2b8b"} 25%{content:"\\2b99"} 50%{content:"\\2b79"} 75%{content:"\\2b38"} }
  #companion {
    position: fixed; left: 0; right: 0; bottom: 0; height: 108px; z-index: 2147483645;
    pointer-events: none;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 0 18px; box-sizing: border-box;
    background: linear-gradient(180deg, rgba(7,12,22,.92), rgba(4,7,13,.98));
    border-top: 1px solid rgba(56,189,248,.35);
    color: #e6edf3; font-family: Inter, system-ui, sans-serif;
    backdrop-filter: blur(6px);
  }
  #companion .who { display: flex; flex-direction: column; gap: 3px; min-width: 104px; }
  #companion .who .name { font-size: 13px; font-weight: 700; letter-spacing: .06em; }
  #companion .who .sub  { font-size: 10px; color: #7d8fa5; letter-spacing: .04em; }
  #companion .meter { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  #companion .meter .big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
  #companion .meter .big small { font-size: 13px; color: #9fb0c3; font-weight: 500; }
  #companion .bar { width: 100%; height: 5px; border-radius: 3px; background: #1a2436; overflow: hidden; }
  #companion .bar i { display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, #38bdf8, #34d399); transition: width .5s ease; }
  #companion .money { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; min-width: 104px; }
  #companion .money .eur { font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
  #companion .money .sub { font-size: 10px; color: #7d8fa5; }
  #companion .bolt { display: inline-block; margin-right: 6px; }
  #companion.live .bolt { animation: movie-bolt 1.1s ease-in-out infinite; }
  @keyframes movie-bolt { 0%,100%{opacity:1} 50%{opacity:.25} }
  #movie-fade { position: fixed; inset: 0; z-index: 2147483647; background: #000;
    opacity: 0; transition: opacity 1.4s ease; pointer-events: none; }
`

async function installChrome(page: Page) {
  await page.addStyleTag({ content: CHROME_CSS })
  await page.evaluate(() => {
    if (!document.getElementById("movie-fade")) {
      const fade = document.createElement("div")
      fade.id = "movie-fade"
      document.body.appendChild(fade)
    }
  })
}

async function card(
  page: Page,
  opts: { title?: string; body?: string; qrDataUrl?: string; holdMs: number; brand?: boolean },
) {
  await page.evaluate(
    ({ title, body, qrDataUrl, brand }) => {
      document.getElementById("movie-card")?.remove()
      const el = document.createElement("div")
      el.id = "movie-card"
      const titleEl = title ? `<div class="title">${title}</div>` : ""
      const bodyEl = body ? `<div class="body">${body}</div>` : ""
      const qrEl = qrDataUrl
        ? `<img src="${qrDataUrl}" width="200" height="200" alt="charge point QR" />` +
          `<div class="body">Scan to charge · Pay with Lightning</div>`
        : ""
      const brandEl = brand === false ? "" : `<div class="brand">CASHU CHARGE CO.</div>`
      el.innerHTML = `${titleEl}${bodyEl}${qrEl}${brandEl}`
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add("show"))
    },
    { title: opts.title, body: opts.body, qrDataUrl: opts.qrDataUrl, brand: opts.brand },
  )
  await page.waitForTimeout(opts.holdMs)
}

// A card that stays up until the predicate passes — no dead air while
// Lightning settles or a refund claims.
async function cardUntil(
  page: Page,
  opts: { title: string; body: string; done: string },
  predicate: () => Promise<boolean>,
  timeoutMs: number,
) {
  await page.evaluate(
    ({ title, body }) => {
      document.getElementById("movie-card")?.remove()
      const el = document.createElement("div")
      el.id = "movie-card"
      el.innerHTML = `<div class="title dots">${title}</div><div class="body">${body}</div>`
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add("show"))
    },
    opts,
  )
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`cardUntil timeout: ${opts.title}`)
    await page.waitForTimeout(500)
  }
  await page.evaluate(done => {
    const el = document.getElementById("movie-card")
    if (el) {
      el.querySelector(".title")!.classList.remove("dots")
      el.querySelector(".body")!.textContent = done
    }
  }, opts.done)
  await page.waitForTimeout(2_200)
}

async function hideCard(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        const el = document.getElementById("movie-card")
        if (!el) return resolve()
        el.classList.remove("show")
        setTimeout(() => {
          el.remove()
          resolve()
        }, 480)
      }),
  )
}

async function fadeOut(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        const el = document.getElementById("movie-fade")
        if (el) el.style.opacity = "1"
        setTimeout(resolve, 1_600)
      }),
  )
}

// The companion strip: one charger, landscape, bottom-pinned. It reads
// the wallet's own live DOM every 400ms — the charging progressbar and
// the post-session summary are the truth; the strip restyles them.
async function mountCompanion(page: Page) {
  await page.evaluate(() => {
    document.getElementById("companion")?.remove()
    const el = document.createElement("div")
    el.id = "companion"
    el.innerHTML = `
      <div class="who">
        <span class="name"><span class="bolt">⚡</span>SIM CHARGER</span>
        <span class="sub" id="cp-sub">charge point · online</span>
      </div>
      <div class="meter">
        <div class="big"><span id="cp-now">0</span><small> kW·s</small></div>
        <div class="bar"><i id="cp-fill"></i></div>
      </div>
      <div class="money">
        <span class="eur" id="cp-eur">€50.00</span>
        <span class="sub" id="cp-money-sub">authorized</span>
      </div>`
    document.body.appendChild(el)
    const strip = el
    const now = el.querySelector("#cp-now") as HTMLElement
    const fill = el.querySelector("#cp-fill") as HTMLElement
    const eur = el.querySelector("#cp-eur") as HTMLElement
    const moneySub = el.querySelector("#cp-money-sub") as HTMLElement
    const sub = el.querySelector("#cp-sub") as HTMLElement
    const BUDGET = 50
    const tick = () => {
      const bar = document.querySelector('[role="progressbar"]')
      const body = document.body.innerText || ""
      let delivered: number | null = null
      let remaining: number | null = null
      if (bar) {
        delivered = Number(bar.getAttribute("aria-valuenow") ?? 0)
        const max = Number(bar.getAttribute("aria-valuemax") ?? BUDGET)
        remaining = Math.max(0, max - delivered)
        strip.classList.add("live")
        sub.textContent = "delivering energy"
      } else {
        const m =
          body.match(/Charging stopped — (\d+) s delivered/) ??
          body.match(/Charged (\d+) s at/)
        if (m) {
          delivered = Number(m[1])
          remaining = BUDGET - delivered
          strip.classList.remove("live")
          sub.textContent = "session complete"
        } else {
          strip.classList.remove("live")
          sub.textContent = "charge point · online"
          now.textContent = "0"
          fill.style.width = "0%"
          eur.textContent = `€${BUDGET.toFixed(2)}`
          moneySub.textContent = "ready"
          return
        }
      }
      now.textContent = String(delivered)
      fill.style.width = `${Math.min(100, (delivered / BUDGET) * 100)}%`
      eur.textContent = `€${(remaining ?? 0).toFixed(2)}`
      moneySub.textContent = remaining && remaining > 0 ? "still hers" : "settled"
    }
    tick()
    window.setInterval(tick, 400)
  })
}

async function hideCompanion(page: Page) {
  await page.evaluate(() => document.getElementById("companion")?.remove())
}

async function still(page: Page, name: string) {
  await page.screenshot({ path: `e2e/.results-video/alice-stills/${name}.png` })
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
  await installChrome(page)

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
  const qr = await import("qrcode").then(m =>
    m.default.toDataURL(DEEP_LINK, { margin: 1, width: 420 }),
  )
  await card(page, {
    title: "A charge point.",
    qrDataUrl: qr,
    holdMs: 6_000,
    brand: false,
  })
  await card(page, {
    title: "No screen to trust. No card reader.",
    body: "Just a QR that opens the wallet.",
    qrDataUrl: qr,
    holdMs: 5_000,
    brand: false,
  })
  await hideCard(page)

  // SCENE 3 — Alice opens the wallet; the charge point wakes up below
  await mountCompanion(page)
  await card(page, {
    title: "No app store. No sign-up.",
    body: "A web page holding bearer ecash — cash for kilowatts.",
    holdMs: 4_000,
  })
  await hideCard(page)
  await expect.poll(() => readBalance(page)).toBeCloseTo(0, 2)
  await still(page, "03-wallet-first-visit")
  await page.waitForTimeout(1_500)

  // SCENE 4 — top up over Lightning: a real bolt11, paid for real. The
  // settle wait is bridged by live cards — no dead air on the invoice.
  await page.getByRole("button", { name: "Lightning", exact: true }).click()
  await page.getByPlaceholder("5.00").fill(String(DEPOSIT_EUR))
  await page.getByRole("button", { name: "Create lightning invoice" }).click()
  const invoice = await page
    .locator('p.font-mono:has-text("lntbs")')
    .first()
    .textContent({ timeout: 60_000 })
  expect(invoice).toBeTruthy()
  await page.waitForTimeout(2_500)
  // The payer ssh can wedge transiently on a loaded workstation; CLN
  // dedupes by payment hash, so retrying pay on the same bolt11 is safe.
  const paying = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return payLightningInvoice(invoice!.trim())
      } catch (err) {
        if (attempt >= 3) throw err
        await new Promise(resolve => setTimeout(resolve, 5_000))
      }
    }
  })()
  await card(page, {
    title: "Alice pays from her Lightning wallet ⚡",
    body: "A real invoice — €50 on Lightning.",
    holdMs: 4_000,
  })
  await cardUntil(
    page,
    {
      title: "Settling on Lightning…",
      body: "The mint issues Alice's ecash.",
      done: "Paid ⚡ — €50 in ecash.",
    },
    async () => (await readBalance(page).catch(() => 0)) >= DEPOSIT_EUR - 0.5,
    120_000,
  )
  await paying
  await hideCard(page)
  await expect
    .poll(() => readBalance(page), { timeout: 60_000 })
    .toBeCloseTo(DEPOSIT_EUR, 1)
  await still(page, "04-funded")
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
  await installChrome(page)
  await mountCompanion(page)
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

  // SCENE 6 — charge: keep the session on screen long enough to READ
  // it (≥ STOP_AT_KWS delivered, then a deliberate hold before Stop).
  await page.getByPlaceholder("1.00").fill(String(DEPOSIT_EUR))
  await page.getByRole("button", { name: "Start charging" }).click()
  await expect(page.getByText("Charging at Sim Charger")).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1_500)
  await still(page, "06-charging-early")
  await card(page, {
    title: `€${DEPOSIT_EUR} of energy, authorized.`,
    body: "Metered by the charge point, second by second — the strip below is its display.",
    holdMs: 6_000,
  })
  await hideCard(page)
  const progress = page.getByRole("progressbar")
  await expect
    .poll(async () => Number(await progress.getAttribute("aria-valuenow")), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(STOP_AT_KWS)
  await still(page, "06-charging-live")
  await page.waitForTimeout(6_000)
  await page.getByRole("button", { name: "Stop charging" }).click()
  // Remote-stop summary reads "Charging stopped — N s delivered"; a
  // natural full-budget completion reads "Charged N s at …". Accept both.
  await expect(
    page.getByText(/(Charging stopped — \d+ s delivered|Charged \d+ s at Sim Charger)/),
  ).toBeVisible({ timeout: 180_000 })
  const receipt = await page.locator("p.break-all.font-mono").first().textContent()
  expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  await still(page, "07-stopped-summary")

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
  await hideCompanion(page)
  await card(page, {
    title: "pecan · Cashu · Lightning",
    body: "giftcard.cashu.exchange",
    holdMs: 7_000,
  })
  await fadeOut(page)
  await page.waitForTimeout(2_000)
})
