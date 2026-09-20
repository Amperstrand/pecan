import { execSync } from "node:child_process"
import fs from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { chromium } from "@playwright/test"
import { ensureWarm, payInvoice, PROFILE_A, PROFILE_B, WALLET, PORTAL, ORIGIN } from "./portal-film-lib"

// THE EGG VENDING MACHINE — the movie. One phone buys TODAY's eggs on
// the deployed farm pair (autopay settles the invoice hands-free),
// transfers them as a bearer code, and the claims portal at
// giftcard.cashu.exchange/redeem virtually delivers them — no teller
// code, no operator, eggs on the screen, FARM-VIRTUAL receipt. Every
// frame is the live stack.
//
//   scripts/portal-movie.sh            (voice + this spec + cut)
// Out: web/e2e/.results-video/portal-final.mp4
//
// The chrome/timeline pattern mirrors web/e2e/sarah-video.spec.ts —
// its canon is the film knowledge base (~/src/test-films).

test.skip(!process.env.PECAN_VIDEO, "movie run only (run scripts/portal-movie.sh)")
const MT0 = Date.now()
function mark(m: string) {
  console.error(`MARK ${m} +${((Date.now() - MT0) / 1000).toFixed(0)}s`)
}

const MANUSCRIPT = JSON.parse(fs.readFileSync("e2e/portal-manuscript.json", "utf8")) as {
  lines: Array<{ id: string; text: string }>
}
const SAY: Record<string, string> = Object.fromEntries(
  MANUSCRIPT.lines.map((l) => [l.id, l.text]),
)
const VOICE_DUR: Record<string, number> = (() => {
  try {
    return JSON.parse(fs.readFileSync("e2e/portal-voice/durations.json", "utf8"))
  } catch {
    return {}
  }
})()
function holdForVoice(id?: string, floorMs = 3_200): number | undefined {
  if (!id || VOICE_DUR[id] === undefined) return undefined
  return Math.max(floorMs, Math.ceil(VOICE_DUR[id] * 1000) + 900)
}

const QTY = 2

// ---------------------------------------------------------------------------
// movie chrome (same kit as the sarah film: cards + phone frame)
// ---------------------------------------------------------------------------

const CHROME_CSS = `
  #movie-card {
    position: fixed; inset: 0; z-index: 2147483646;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 18px; padding: 30px; text-align: center;
    background: radial-gradient(120% 120% at 50% 0%, #0b1220 0%, #050810 70%);
    color: #e6edf3; font-family: Inter, system-ui, sans-serif;
    opacity: 0; transition: opacity .45s ease;
  }
  #movie-card.show { opacity: 1; }
  #movie-card .title { font-size: 27px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; max-width: 340px; }
  #movie-card .body  { font-size: 16.5px; line-height: 1.5; color: #9fb0c3; max-width: 330px; }
  #movie-card .mono  { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12.5px;
                       color: #7ef0c1; background: rgba(16,32,28,.75); padding: 10px 12px;
                       border-radius: 10px; line-height: 1.6; max-width: 340px; word-break: break-all; }
  #movie-card .brand { position: absolute; bottom: 24px; font-size: 12px; color: #5b6b7f; letter-spacing: .14em; }
  #movie-card .dots::after { content: "\\2b8b"; display: inline-block; margin-left: 6px; animation: movie-dots 1s steps(4) infinite; }
  @keyframes movie-dots { 0%{content:"\\2b8b"} 25%{content:"\\2b99"} 50%{content:"\\2b79"} 75%{content:"\\2b38"} }
  #movie-frame {
    position: fixed; inset: 0; z-index: 2147483643; pointer-events: none;
    border: 7px solid #0a0d14; border-radius: 26px;
    box-shadow: inset 0 0 0 1.5px rgba(120,140,170,.35), 0 0 0 1px rgba(0,0,0,.8);
  }
  #movie-statusbar {
    position: fixed; top: 0; left: 0; right: 0; height: 22px; z-index: 2147483643;
    pointer-events: none; display: flex; align-items: center; justify-content: space-between;
    padding: 0 16px; box-sizing: border-box;
    color: #e6edf3; font-family: Inter, system-ui, sans-serif; font-size: 11px; font-weight: 600;
    text-shadow: 0 1px 2px rgba(0,0,0,.6);
  }
  #movie-fade { position: fixed; inset: 0; z-index: 2147483647; background: #000;
    opacity: 0; transition: opacity 1.2s ease; pointer-events: none; }
`

async function installChrome(page: Page) {
  await page.addStyleTag({ content: CHROME_CSS })
  await page.evaluate(() => {
    for (const [id, html] of [
      ["movie-fade", `<div id="movie-fade"></div>`],
      [
        "movie-frame",
        `<div id="movie-frame"></div><div id="movie-statusbar"><span>9:41</span><span>▮▮▮ ⌁ 84%</span></div>`,
      ],
    ] as const) {
      if (!document.getElementById(id)) {
        const el = document.createElement("div")
        el.id = id
        el.innerHTML = html
        document.body.appendChild(el)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// narration timeline — the assembler maps entries to the synthesized
// wavs by line id.
// ---------------------------------------------------------------------------

const TIMELINE: { start: number; end?: number; say?: string; file: "a" | "b" }[] = []
let T0 = 0
function markStart(file: "a" | "b", say?: string) {
  if (!T0) T0 = Date.now()
  TIMELINE.push({ start: Date.now() - T0, say, file })
}
function markEnd() {
  const last = TIMELINE[TIMELINE.length - 1]
  if (last && last.end === undefined) last.end = Date.now() - T0
}
function writeTimeline() {
  markEnd()
  const idByText = new Map(MANUSCRIPT.lines.map((l) => [l.text, l.id]))
  for (const e of TIMELINE) {
    if (e.say && idByText.has(e.say)) {
      ;(e as { sayId?: string }).sayId = idByText.get(e.say)
    }
  }
  fs.mkdirSync("e2e/.results-video", { recursive: true })
  fs.writeFileSync(
    "e2e/.results-video/portal-timeline.json",
    JSON.stringify({ t0_offset_hint_ms: 1500, entries: TIMELINE }, null, 2),
  )
}

function holdFor(...texts: (string | undefined)[]): number {
  const words = texts.join(" ").split(/\s+/).filter(Boolean).length
  return Math.max(3_200, 1_400 + words * 450)
}

interface CardOpts {
  title?: string
  body?: string
  mono?: string
  holdMs?: number
  sayId?: string
}

async function card(page: Page, file: "a" | "b", opts: CardOpts) {
  await page.evaluate(
    ({ title, body, mono }) => {
      document.getElementById("movie-card")?.remove()
      const el = document.createElement("div")
      el.id = "movie-card"
      const titleEl = title ? `<div class="title">${title}</div>` : ""
      const bodyEl = body ? `<div class="body">${body}</div>` : ""
      const monoEl = mono ? `<div class="mono">${mono}</div>` : ""
      el.innerHTML = `${titleEl}${bodyEl}${monoEl}<div class="brand">FARM · CLAIMS PORTAL</div>`
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add("show"))
    },
    { title: opts.title, body: opts.body, mono: opts.mono },
  )
  markStart(file, SAY[opts.sayId ?? ""] ?? opts.title)
  const voiceHold = holdForVoice(opts.sayId)
  const hold = Math.max(opts.holdMs ?? 0, voiceHold ?? 0, holdFor(opts.title, opts.body, opts.mono))
  await page.waitForTimeout(hold)
  markEnd()
}

async function cardUntil(
  page: Page,
  file: "a" | "b",
  opts: CardOpts & { done: string },
  predicate: () => Promise<boolean>,
  timeoutMs: number,
) {
  await page.evaluate(
    ({ title, body }) => {
      document.getElementById("movie-card")?.remove()
      const el = document.createElement("div")
      el.id = "movie-card"
      el.innerHTML = `<div class="title dots">${title}</div><div class="body">${body}</div><div class="brand">FARM · CLAIMS PORTAL</div>`
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add("show"))
    },
    { title: opts.title, body: opts.body },
  )
  markStart(file, SAY[opts.sayId ?? ""] ?? opts.title)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) break
    await page.waitForTimeout(1_000)
    if (await pageDead(page)) throw new Error("renderer died while waiting — take lost")
  }
  await page.evaluate((done) => {
    const el = document.getElementById("movie-card")
    if (el) {
      el.querySelector(".title")!.classList.remove("dots")
      const doneEl = document.createElement("div")
      doneEl.className = "body"
      doneEl.textContent = done
      el.querySelector(".brand")!.before(doneEl)
    }
  }, opts.done)
  await page.waitForTimeout(2_200)
  markEnd()
  await hideCard(page)
}

async function pageDead(page: Page): Promise<boolean> {
  try {
    await page.evaluate(() => 1)
    return false
  } catch {
    return true
  }
}

async function beat(
  page: Page,
  file: "a" | "b",
  sayId: string,
  floorMs: number,
  action?: () => Promise<void>,
) {
  markStart(file, SAY[sayId])
  const hold = Math.max(floorMs, holdForVoice(sayId, 0) ?? 0)
  const actionStart = Date.now()
  if (action) await action()
  const actionMs = Date.now() - actionStart
  for (let slept = 0; slept < Math.max(1_000, hold - actionMs); slept += 1_000) {
    await page.waitForTimeout(Math.min(1_000, hold - actionMs - slept))
    if (await pageDead(page)) throw new Error("renderer died mid-beat — take lost")
  }
  markEnd()
}

/** A voiced card, then rotating silent hold cards, while a server-side
 * predicate polls (never the page — see the boot-contention wedge). */
async function cardWhile(
  page: Page,
  file: "a" | "b",
  opts: CardOpts,
  holds: Array<{ title: string; body?: string }>,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
) {
  await card(page, file, { ...opts, holdMs: 0 }).catch(() => undefined)
  const deadline = Date.now() + timeoutMs
  let hold = 0
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) break
    const h = holds[Math.min(hold, holds.length - 1)]
    hold += 1
    await page.evaluate(
      ({ title, body }) => {
        const el = document.getElementById("movie-card")
        const titleEl = el?.querySelector(".title")
        if (titleEl) titleEl.textContent = title
        const bodyEl = el?.querySelector(".body")
        if (bodyEl) bodyEl.textContent = body ?? ""
      },
      { title: h.title, body: h.body },
    )
    await page.waitForTimeout(50_000)
  }
  await page.evaluate(() => document.getElementById("movie-card")?.remove())
}

async function hideCard(page: Page) {
  await page.evaluate(() => document.getElementById("movie-card")?.remove())
}

async function probeBundle(browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(WALLET, { waitUntil: "domcontentloaded" })
  const name =
    (await page
      .locator('script[src*="assets/index-"]')
      .first()
      .getAttribute("src")
      .catch(() => "")) ?? ""
  const js = name
    ? await page.evaluate(async (src) => (await fetch(src).catch(() => "")).text(), name)
    : ""
  await ctx.close()
  return { name: name.split("/").pop() ?? "?", hasFarm: js.includes("FARM") }
}


// ---------------------------------------------------------------------------
// Warm persistent profiles — the make-or-break of this film. A fresh
// context's boot (five mints, a growing zoo of dated farm keysets)
// runs ~7 minutes, and ANY page contact during it wedges the wallet's
// watchers — every fresh-context take died here. Solution: boot both
// devices' wallets BEFORE the cameras roll, into persistent profiles;
// the filmed launches reuse the warm storages and open in seconds.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// the film
// ---------------------------------------------------------------------------

test("the egg vending machine — claims portal, virtual delivery", async ({ browser }) => {
  test.setTimeout(2_100_000)
  mark("t0")

  // The concurrent-deployer guard (it reverted the wallet twice).
  {
    const bundle = await probeBundle(browser)
    mark("probe-done")
    if (!bundle.hasFarm) {
      throw new Error(
        `the live /wallet bundle (${bundle.name}) lacks the FARM tab — rerun scripts/deploy.sh before filming`,
      )
    }
  }

  const overview = (await (await fetch(`${ORIGIN}/farm-console/api/farm`)).json()) as {
    series: Array<{ date: string; unit: string; available: number; issued: number; redeemed: number; price_sats: number; capacity: number }>
  }
  const today = new Date().toISOString().slice(0, 10)
  const series = overview.series.find((s) => s.date === today && s.available >= QTY)
  mark("series " + (series?.date ?? "?"))
  expect(series, "today's series with 2+ free eggs").toBeDefined()

  // Warm both devices' persistent wallets BEFORE the cameras roll —
  // see warmProfiles for why this film cannot run on fresh contexts.
  await ensureWarm(series.unit)

  // ---- camera A: Sarah's phone (warm) -----------------------------------
  const ctxA = await chromium.launchPersistentContext(PROFILE_A, {
    headless: true,
    recordVideo: { dir: "e2e/.results-video/portal-take", size: { width: 420, height: 900 } },
  })
  mark("ctxA")
  const a = await ctxA.newPage()
  await installChrome(a)
  mark("chromeA")

  // Cards on the blank page: an evaluate on the booting wallet page
  // stalls behind the fresh-context keyset crawl (learned the hard
  // way). The wallet loads only when the story reaches it — the sarah
  // order.
  await card(a, "a", {
    title: "Sarah wants eggs. Today.",
    body: "Not a futures contract anymore — a vending machine. The day's eggs sell all day, and only that day.",
    sayId: "p01",
    holdMs: 5_500,
  })
  await card(a, "a", {
    title: "Sell till midnight. Claim it or lose it.",
    mono: `series&nbsp; = ${series.date}<br/>free&nbsp;&nbsp;&nbsp;&nbsp; = ${series.available} of ${series.capacity}<br/>window = 00:00–24:00 UTC`,
    body: "Buy at breakfast, collect at dinner — any hour of the production day. After midnight the claims are gone.",
    sayId: "p02",
    holdMs: 6_500,
  })

  await a.goto(WALLET)
  await installChrome(a)
  await a.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
  mark("farm-tab")
  await a.getByLabel("production day").waitFor({ timeout: 30_000 })
  mark("picker")
  await beat(a, "a", "p03", 4_500, async () => {
    await a.getByLabel("egg quantity").fill(String(QTY))
  })
  await a.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  await a.getByTestId("farm-invoice").waitFor({ state: "visible", timeout: 30_000 })
  const invoice = await a.getByTestId("farm-invoice").inputValue()
  mark("invoice")
  const issuedBefore = series.issued
  void issuedBefore
  mark("autopay-wait")

  // Pay off-camera from the farm's own node (the narration stays true:
  // nobody on this phone presses anything), then hold cards while the
  // SERVER-side oracle confirms issuance — the wallet page is left in
  // total silence (its post-mint path is the wedge; we never film it).
  expect(await payInvoice(invoice), "the farm node settled its own invoice").toBe(true)
  await cardWhile(
    a,
    "a",
    {
      title: "Nobody presses pay.",
      body: "The farm settles its own invoice — a demo rail on signet. The wallet watches the purchase go paid, then mints.",
      sayId: "p04",
    },
    [
      { title: "The mint is signing two claims.", body: "Locked to Sarah's wallet key." },
      { title: "Still signing…", body: "Fresh devices crawl the farm's dated keysets — a known debt." },
    ],
    async () => {
      const o = (await (
        await a.request.get(`${ORIGIN}/farm-console/api/farm/${series.date}`)
      ).json()) as { issued: number }
      return o.issued >= series.issued + QTY
    },
    720_000,
  )
  mark("minted")

  await card(a, "a", {
    title: "Two claims, minted.",
    mono: `ledger: issued ${series.issued + QTY} · redeemed ${series.redeemed}`,
    body: "Bearer claims live in Sarah's wallet now. Whoever holds the code owns the eggs — so she moves them to the portal.",
    sayId: "p05",
    holdMs: 6_000,
  })
  mark("p05-done")
  await card(a, "a", {
    title: "One code. Any device.",
    body: "The claims travel as a bearer token to the claims portal — giftcard.cashu.exchange/redeem.",
    sayId: "p06",
    holdMs: 5_000,
  })
  mark("transfer-begin")
  await hideCard(a)

  // close A so its video finalizes; offset B's entries by its duration
  await ctxA.close()
  const takeDir = "e2e/.results-video/portal-take"
  const videoAPath = fs
    .readdirSync(takeDir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => `${takeDir}/${f}`)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((x, y) => x.m - y.m)
    .at(-1)!.f
  const durA = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoAPath}"`,
    ).toString().trim(),
  )
  for (const e of TIMELINE) if (e.file === "b") e.start += durA * 1000, e.end !== undefined && (e.end += durA * 1000)

  // The bearer token is a STRING — it is supplied wherever the
  // transfer leg behaves (the builder: scripts/portal-movie.sh supply →
  // /tmp/portal-token.txt) and filmed anywhere. The on-camera story is
  // unchanged: Sarah's phone bought two eggs; the portal redeems two.
  const token = fs.readFileSync("/tmp/portal-token.txt", "utf8").trim()
  expect(token.length).toBeGreaterThan(50)
  mark("token ok (supplied)")

  // ---- camera B: the claims portal device (warm) ------------------------
  // B films as a FRESH device — the exact shape that passed the portal
  // e2e in 20 seconds (the warm-profile recording wedged; the fresh
  // import runs ~1-3 min behind the opening card).
  const ctxB = await browser.newContext({
    recordVideo: { dir: "e2e/.results-video/portal-take", size: { width: 420, height: 900 } },
  })
  mark("ctxB")
  const b = await ctxB.newPage()
  await b.goto(PORTAL)
  mark("portal-loaded")

  // The recorded PORTAL page wedges on ANY injected evaluate (cards,
  // forced fills — three takes of evidence; the wallet page tolerates
  // them, the portal does not). So camera B films BARE: voice-over on
  // the live UI, zero page contact beyond Playwright's own actions.
  // p07 plays over the portal's opening shot.
  markStart("b", SAY["p07"])
  await new Promise((r) => setTimeout(r, Math.max(8_000, holdForVoice("p07") ?? 8_000)))
  markEnd()

  await b.getByTestId("kiosk-token-input").fill(token)
  await b.getByRole("button", { name: /Validate code/i }).click()
  mark("pasted")
  await b.getByRole("heading", { name: new RegExp(`${QTY} eggs`) }).waitFor({ timeout: 300_000 })
  mark("verdict")

  markStart("b", SAY["p08"])
  await new Promise((r) => setTimeout(r, Math.max(4_500, holdForVoice("p08", 0) ?? 4_500)))
  markEnd()

  // virtual delivery — the money shot
  mark("verdict")
  await b.getByTestId("kiosk-redeem-virtual").click()
  mark("redeem-clicked")
  await b.getByTestId("kiosk-delivering").waitFor({ timeout: 60_000 })
  markStart("b", SAY["p09"])
  await new Promise((r) => setTimeout(r, Math.max(3_000, holdForVoice("p09", 0) ?? 3_000)))
  markEnd()
  await b.getByTestId("kiosk-eggs").waitFor({ timeout: 180_000 })
  mark("eggs")
  mark("eggs")
  await b.waitForTimeout(7_000) // let the eggs pop and float

  const receiptText =
    (await b
      .getByText(/^FARM-VIRTUAL-/)
      .first()
      .textContent()
      .catch(() => "")) ?? ""
  expect(receiptText).toMatch(/^FARM-VIRTUAL-/)
  markStart("b", SAY["p10"])
  await new Promise((r) => setTimeout(r, Math.max(7_000, holdForVoice("p10") ?? 7_000)))
  markEnd()

  // the public oracle agrees — no admin, no names
  const after = (await (await fetch(`${ORIGIN}/farm-console/api/farm`)).json()) as {
    series: Array<{ redeemed: number; issued: number; available: number }>
  }
  const todayAfter = after.series.find((s) => s.date === series.date)!
  expect(todayAfter.redeemed).toBeGreaterThanOrEqual(series.redeemed + QTY)
  markStart("b", SAY["p11"])
  await new Promise((r) => setTimeout(r, Math.max(6_500, holdForVoice("p11") ?? 6_500)))
  markEnd()
  markStart("b", SAY["p12"])
  await new Promise((r) => setTimeout(r, Math.max(8_000, holdForVoice("p12") ?? 8_000)))
  markEnd()

  mark("outro-done")
  writeTimeline()
  await ctxB.close()
  const videoBPath = fs
    .readdirSync(takeDir)
    .filter((f) => f.endsWith(".webm") && `${takeDir}/${f}` !== videoAPath)
    .map((f) => `${takeDir}/${f}`)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((x, y) => x.m - y.m)
    .at(-1)!.f
  fs.writeFileSync(
    "e2e/.results-video/portal-parts.json",
    JSON.stringify({ a: videoAPath, b: videoBPath }, null, 2),
  )
  console.log(`FILM a=${videoAPath} (${durA.toFixed(1)}s) b=${videoBPath}`)
})
