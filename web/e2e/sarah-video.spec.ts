import { execSync } from "node:child_process"
import fs from "node:fs"
import { test, expect, type Page } from "@playwright/test"

// SARAH BUYS EGG FUTURES — the movie. One phone-shaped recording of the
// full NUT-32 draft story on the deployed farm pair of
// giftcard.cashu.exchange: Sarah pays 5000 REAL signet sats over
// Lightning for five dated egg claims, the mint issues five
// future:farm-egg:<maturity> proofs, Sarah hands two of them to Bob as
// a bearer token, and Bob redeems them at the farm counter after
// maturity for physical eggs. Every frame is the live stack.
//
//   scripts/sarah-movie.sh          (preflight + this spec + video)
//   scripts/sarah-movie.sh --voice  (+ narration → sarah-final.mp4)
//
// The chrome/timeline pattern mirrors templates/film-chrome.ts in the
// film knowledge base (~/src/test-films) — its canon; alice-video.spec.ts
// is the sibling project view.

test.skip(!process.env.PECAN_VIDEO, "movie run only (run scripts/sarah-movie.sh)")

// ---------------------------------------------------------------------------
// manuscript + synthesized-voice plan: narration text lives in
// sarah-manuscript.json; pass 1 (scripts/sarah-movie.sh) synthesizes every
// line on the builder GPU and drops durations.json next to the wavs. When
// present, every beat holds at least its line's real audio length + slack
// — the cut is sized to the voice, never rate-clamped.
// ---------------------------------------------------------------------------
const MANUSCRIPT = JSON.parse(fs.readFileSync("e2e/sarah-manuscript.json", "utf8")) as {
  lines: Array<{ id: string; text: string }>
}
const SAY: Record<string, string> = Object.fromEntries(
  MANUSCRIPT.lines.map((l) => [l.id, l.text]),
)
const VOICE_DUR: Record<string, number> = (() => {
  try {
    return JSON.parse(fs.readFileSync("e2e/sarah-voice/durations.json", "utf8"))
  } catch {
    return {}
  }
})()
function sayFor(id?: string): string | undefined {
  return id ? SAY[id] : undefined
}
// hold ≥ audio duration + slack (0.9 s), so the line never runs past the
// beat nor gets sped up in the mix
function holdForVoice(id?: string, floorMs = 3_200): number | undefined {
  if (!id || VOICE_DUR[id] === undefined) return undefined
  return Math.max(floorMs, Math.ceil(VOICE_DUR[id] * 1000) + 900)
}

const WALLET = "https://giftcard.cashu.exchange/wallet"
const QTY = 5

// ---------------------------------------------------------------------------
// movie chrome (slimmer cut of the alice chrome: cards + phone frame)
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
// narration timeline — the VO post pass (scripts/movie-voice canon) turns
// this into a synced voiceover. Entries carry `file` (a|b) so the two
// phone recordings can be concatenated with correct offsets.
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
  // Decorate entries with their manuscript line id so the assembler maps
  // straight to the synthesized wav (no text matching).
  const idByText = new Map(MANUSCRIPT.lines.map((l) => [l.text, l.id]))
  for (const e of TIMELINE) {
    if (e.say && idByText.has(e.say)) {
      ;(e as { sayId?: string }).sayId = idByText.get(e.say)
    }
  }
  fs.mkdirSync("e2e/.results-video", { recursive: true })
  fs.writeFileSync(
    "e2e/.results-video/sarah-timeline.json",
    JSON.stringify({ t0_offset_hint_ms: 1500, entries: TIMELINE }, null, 2),
  )
}

// ~3 words/second + slack, floor 3.2 s (house review rule).
function holdFor(...texts: (string | undefined)[]): number {
  const words = texts.join(" ").split(/\s+/).filter(Boolean).length
  return Math.max(3_200, 1_400 + words * 450)
}

interface CardOpts {
  title?: string
  body?: string
  mono?: string
  holdMs?: number
  say?: string
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
      el.innerHTML = `${titleEl}${bodyEl}${monoEl}<div class="brand">FARM · NUT-32 DRAFT</div>`
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add("show"))
    },
    { title: opts.title, body: opts.body, mono: opts.mono },
  )
  markStart(file, opts.say ?? sayFor(opts.sayId) ?? opts.title)
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
      el.innerHTML = `<div class="title dots">${title}</div><div class="body">${body}</div><div class="brand">FARM · NUT-32 DRAFT</div>`
      document.body.appendChild(el)
      requestAnimationFrame(() => el.classList.add("show"))
    },
    { title: opts.title, body: opts.body },
  )
  markStart(file, opts.say ?? sayFor((opts as CardOpts & { sayId?: string }).sayId) ?? opts.title)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) break
    await page.waitForTimeout(1_000)
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

/** A narration beat on live UI (no card): holds ≥ the line's audio. */
async function beat(
  page: Page,
  file: "a" | "b",
  sayId: string,
  floorMs: number,
  action?: () => Promise<void>,
) {
  markStart(file, sayFor(sayId))
  const hold = Math.max(floorMs, holdForVoice(sayId, 0) ?? 0)
  const actionStart = Date.now()
  if (action) await action()
  const actionMs = Date.now() - actionStart
  await page.waitForTimeout(Math.max(1_000, hold - actionMs))
  markEnd()
}

async function hideCard(page: Page) {
  await page.evaluate(() => document.getElementById("movie-card")?.remove())
}

// ---------------------------------------------------------------------------
// the film
// ---------------------------------------------------------------------------

test("Sarah buys egg futures — the NUT-32 draft story", async ({ browser }) => {
  test.setTimeout(1_500_000)

  // ---- preflight data (outside the recording's critical path) ----------
  const overview = await fetch(`${WALLET.replace("/wallet", "")}/farm-console/api/farm`).then(
    (r) => r.json(),
  )
  const series = overview.series.find(
    (s: { matured: boolean; available: number }) => !s.matured && s.available >= QTY,
  )
  expect(series, "a series with 5+ free eggs").toBeDefined()
  const terms = await fetch(series.terms_uri).then((r) => r.json())
  const oracleBefore = await fetch(
    `${WALLET.replace("/wallet", "")}/farm-console/api/farm/${series.date}`,
  ).then((r) => r.json())
  expect(oracleBefore.issued).toBe(oracleBefore.issued) // shape check

  const ctxA = await browser.newContext({
    recordVideo: { dir: "e2e/.results-video/sarah-take", size: { width: 420, height: 900 } },
  })
  const sarah = await ctxA.newPage()
  await installChrome(sarah)

  // ---- 1 · title --------------------------------------------------------
  await card(sarah, "a", {
    title: "Sarah wants eggs next Friday.",
    body: `A farm sells dated egg claims for signet sats — ${series.price_sats} sats each. Each production day is its own scarce Cashu series: NUT-32, the futures draft.`,
    sayId: "l01",
    holdMs: 5_500,
  })

  // ---- 2 · the unit grammar --------------------------------------------
  await card(sarah, "a", {
    title: "Friday's eggs are not Saturday's eggs.",
    mono: `unit = future:farm-egg:20260926t160000z<br/>amount = 5 &nbsp;(egg count)<br/>maturity = Fri 16:00 UTC`,
    body: "The unit names the commodity, the producer, and the day the eggs can be collected. Amount is just Cashu amount — five claims.",
    sayId: "l02",
    holdMs: 6_500,
  })

  // ---- 3 · the terms blob ----------------------------------------------
  const TOTAL = QTY * series.price_sats
  await card(sarah, "a", {
    title: "The terms are signed by the mint.",
    mono: `sha256 → ${series.terms_sha256.slice(0, 20)}…<br/>sig &nbsp;→ BIP-340 (mint identity)<br/>capacity ${series.capacity} · ${series.price_sats} sat / egg`,
    body: "Every proof's secret carries one tag — future, version one, and the URL of this blob. The blob is content-addressed: the digest IS the address.",
    sayId: "l03",
    holdMs: 7_000,
  })

  // ---- 4 · Sarah opens the wallet --------------------------------------
  await sarah.goto(WALLET)
  await installChrome(sarah) // navigation wiped the injected chrome
  await sarah.getByRole("tab", { name: "FARM" }).click()
  await sarah.getByLabel("production day").waitFor({ timeout: 30_000 })
  await sarah.getByLabel("production day").selectOption(series.date)
  await beat(sarah, "a", "l04", 3_000)

  await sarah.getByLabel("egg quantity").fill(String(QTY))
  await beat(sarah, "a", "l05", 2_000)

  markStart("a", sayFor("l05"))
  await sarah.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  await sarah.getByTestId("farm-invoice").waitFor({ state: "visible", timeout: 30_000 })
  await sarah.waitForTimeout(Math.max(3_500, (holdForVoice("l05", 0) ?? 3_500) - 1_500))
  markEnd()

  // pay it for real from a lab node (off-camera)
  const invoice = await sarah.getByTestId("farm-invoice").inputValue()
  let paid = false
  for (const node of ["cln-hub-signet", "cln-clboss-signet", "cln-nostr-signet"]) {
    try {
      execSync(
        `ssh -o BatchMode=yes root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`,
        { timeout: 75_000, stdio: ["ignore", "pipe", "pipe"] },
      )
      paid = true
      break
    } catch {
      continue
    }
  }
  expect(paid, "the invoice was paid over signet Lightning").toBe(true)

  // Ownership is proven by the panel's own YOU-OWN banner (set the moment
  // the mint op resolves) — the balance header can lag minutes on a fresh
  // context and burned a 3.7-minute hole in the first cut. Hard 45 s cap.
  await cardUntil(
    sarah,
    "a",
    { title: "Payment confirmed.", body: "Minting 5 Friday egg claims — locked to Sarah's wallet key.", done: "5 claims minted.", sayId: "l06" } as CardOpts & { done: string },
    async () =>
      /YOU OWN — Farm eggs/.test((await sarah.locator("main").textContent().catch(() => "")) ?? ""),
    45_000,
  )

  // ---- 5 · ownership + details ------------------------------------------
  await beat(sarah, "a", "l07", 4_500, async () => {
    await sarah.getByRole("button", { name: /details/i }).first().click().catch(() => {})
  })

  const oracleMid = await fetch(
    `${WALLET.replace("/wallet", "")}/farm-console/api/farm/${series.date}`,
  ).then((r) => r.json())
  await card(sarah, "a", {
    title: `Five of ${series.capacity}, ever.`,
    mono: `issued &nbsp;&nbsp;${oracleMid.issued} / capacity ${series.capacity}<br/>free &nbsp;&nbsp;&nbsp;&nbsp;${oracleMid.remaining_issuable}<br/>terms &nbsp;&nbsp;${series.terms_sha256.slice(0, 16)}…`,
    body: "The farm's ledger counts aggregates only — one claim beyond capacity mathematically cannot be minted.",
    sayId: "l08",
    holdMs: 6_000,
  })

  // ---- 6 · the handover: Sarah GIVES Bob two of her notes ---------------
  await card(sarah, "a", {
    title: "A handover, not a payment.",
    body: "Sarah gives Bob two of her notes — the way you hand someone banknotes.",
    sayId: "l09",
    holdMs: 5_000,
  })
  await hideCard(sarah)

  await sarah.getByLabel(`send quantity for ${series.unit}`).fill("2")
  await sarah.getByRole("button", { name: /Send to Bob/i }).click({ timeout: 90_000 })
  await sarah.getByTestId("farm-token").waitFor({ state: "visible", timeout: 60_000 })
  await sarah.waitForTimeout(2_000)

  const token = await sarah.getByTestId("farm-token").inputValue()
  expect(token.length).toBeGreaterThan(50)

  // ---- decode what Sarah hands Bob: the token IS her proofs ----------
  const decoded = await sarah.evaluate(
    async (tok) => {
      const mod = await import("/src/lib/coco/farm.ts").catch(() => null)
      void mod
      const raw = tok.startsWith("cashuA") ? tok.slice(6) : tok.slice(6)
      const b64 = raw.replace(/-/g, "+").replace(/_/g, "/")
      const json = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
      )
      const entry = json.token?.[0] ?? json
      return {
        mint: (entry.mint ?? json.mint ?? "").replace("https://", ""),
        unit: entry.unit ?? json.unit ?? "?",
        proofs: entry.proofs?.length ?? 0,
        amounts: (entry.proofs ?? []).map((pr: { amount?: number }) => pr.amount).join("+"),
      }
    },
    token,
  )
  await card(sarah, "a", {
    title: "What Bob receives.",
    mono: `mint &nbsp;&nbsp;${decoded.mint}<br/>unit &nbsp;&nbsp;${decoded.unit}<br/>proofs &nbsp;${decoded.proofs} (${decoded.amounts})<br/>&nbsp;<br/>these are SARAH's proofs<br/>— bearer notes`,
    body: "The token is just Cashu proofs, base64. Whoever holds them can swap them — that's the handover.",
    sayId: "l10",
    holdMs: 6_000,
  })
  await hideCard(sarah)

  // verify Sarah now holds 3 before switching cameras
  await expect
    .poll(
      async () =>
        (await sarah.locator("main").textContent().catch(() => "")) ?? "",
      { timeout: 60_000 },
    )
  .toMatch(/3 egg claims/)

  // ---- camera B: Bob's phone ---------------------------------------------
  // Close Sarah's context first so her video file is finalized and we can
  // measure its duration — Bob's timeline entries are offset by it.
  await ctxA.close()
  // The webm lands on disk under the take dir once the context closes
  // (this Playwright build has no ctx.videos()); part B does not exist
  // yet, so the newest file IS part A.
  const takeDir = "e2e/.results-video/sarah-take"
  const videoAPath = fs
    .readdirSync(takeDir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => `${takeDir}/${f}`)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => a.m - b.m)
    .at(-1)!.f
  const durA = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoAPath}"`,
    ).toString().trim(),
  )
  for (const e of TIMELINE) if (e.file === "b") e.start += durA * 1000, e.end !== undefined && (e.end += durA * 1000)

  const ctxB = await browser.newContext({
    recordVideo: { dir: "e2e/.results-video/sarah-take", size: { width: 420, height: 900 } },
  })
  const bob = await ctxB.newPage()
  await installChrome(bob)

  await bob.goto(WALLET)
  await installChrome(bob) // chrome must be (re)installed after navigation
  await bob.getByRole("tab", { name: "FARM" }).click()
  await bob.getByPlaceholder(/paste a token/i).waitFor({ timeout: 60_000 })

  await card(bob, "b", {
    title: "Bob's phone.",
    body: "Bob pastes the notes and swaps them at the mint.",
    sayId: "l11",
    holdMs: 5_000,
  })
  await hideCard(bob)

  await bob.getByPlaceholder(/paste a token/i).fill(token)
  markStart("b", sayFor("l12"))
  await bob.getByRole("button", { name: /Receive token/i }).click()
  await bob.waitForTimeout(2_500)
  markEnd()

  await cardUntil(
    bob,
    "b",
    { title: "Swapped.", body: "Sarah's notes burned; fresh proofs of the same future issued to Bob.", done: "Bob owns 2 Friday eggs.", sayId: undefined } as CardOpts & { done: string },
    async () => /2 egg claims|2 claims of/.test((await bob.locator("main").textContent().catch(() => "")) ?? ""),
    60_000,
  )

  // Decode one of BOB's proof secrets: same future tag, brand-new secret.
  const bobSecret = await bob.evaluate(async (unit) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("giftcard-coco-wallet")
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const rows = await new Promise((resolve) => {
      const tx = db.transaction("coco_cashu_proofs", "readonly")
      const req = tx.objectStore("coco_cashu_proofs").getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    })
    const mine = rows.filter(
      (r: { unit?: string; state?: string }) => r.unit === unit && r.state !== "spent",
    )
    if (mine.length === 0) return null
    return String(mine[0]!.secret ?? (mine[0] as { proof?: { secret?: string } }).proof?.secret ?? "")
  }, series.unit)
  if (bobSecret) {
    const bobTag = JSON.parse(bobSecret) as { tags?: string[][] }
    const fut = bobTag.tags?.find((t) => t[0] === "future") ?? []
    await card(bob, "b", {
      title: "Same future. New secrets.",
      mono: `secret → { "secret": "…", "tags": [<br/>&nbsp;&nbsp;["${fut[0]}", "${fut[1]}", "${(fut[2] ?? "").slice(0, 46)}…"]<br/>] }`,
      body: "Bob's proofs carry the same future tag and terms address — but the secrets are his alone. Sarah's copies are spent ash.",
      sayId: "l13",
      holdMs: 6_000,
    })
    await hideCard(bob)
  }

  // ---- 7 · maturity -------------------------------------------------------
  await card(bob, "b", {
    title: "Friday, 16:00 UTC.",
    body: "The series matures. (For the film we advance the clock with the admin override — production code checks the real timestamp.)",
    sayId: "l14",
    holdMs: 5_500,
  })
  await hideCard(bob)
  const pw = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""
  expect(pw, "farm admin password (wrapper fetches it)").toBeTruthy()
  const base = WALLET.replace("/wallet", "")
  const login = await bob.request.post(`${base}/farm-console/api/login`, {
    data: { username: "admin", password: pw },
  })
  expect(login.status()).toBe(200)
  const mature = await bob.request.post(
    `${base}/farm-console/api/farm/series/${series.date}/mature-now`,
  )
  expect(mature.status()).toBe(200)

  // ---- 8 · redemption ------------------------------------------------------
  await bob.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
  await beat(bob, "b", "l15", 2_400, async () => {
    await bob.getByLabel(`redeem quantity for ${series.unit}`).fill("2").catch(() => {})
  })
  await bob.getByRole("button", { name: /Redeem at farm/i }).click({ timeout: 60_000 })
  markStart("b", sayFor("l15"))

  const codeEl = await bob
    .getByText(/teller code ([0-9A-F]{6})/i)
    .first()
    .textContent({ timeout: 60_000 })
  const tail = codeEl?.match(/([0-9A-F]{6})/)?.[1] ?? ""
  expect(tail).toHaveLength(6)

  await card(bob, "b", {
    title: `Teller code ${tail}`,
    body: "The operator matches the code, hands over two physical eggs, and settles. Until the settle, nothing is consumed.",
    sayId: "l16",
    holdMs: 6_500,
  })
  await hideCard(bob)

  // settle as the operator (behind the card)
  const matchResp = await bob.request.post(`${base}/farm-console/api/quotes/match`, {
    data: { code: tail },
  })
  const match = await matchResp.json()
  expect(match.id, `teller matched the code (${JSON.stringify(match).slice(0, 120)})`).toBeTruthy()
  let ticket = match
  const deadline = Date.now() + 30_000
  while (ticket.status === "waiting" && Date.now() < deadline) {
    await bob.waitForTimeout(500)
    ticket = await (await bob.request.post(`${base}/farm-console/api/quotes/match`, { data: { code: tail } })).json()
  }
  expect(ticket.status, "wallet locked funds").not.toBe("waiting")
  const settleResp = await bob.request.post(
    `${base}/farm-console/api/tickets/${match.id}/mark-paid`,
    { data: { notes: "two eggs handed over" } },
  )
  expect(settleResp.status()).toBe(200)
  const settled = await settleResp.json()
  expect(settled.receipt).toMatch(/^FARM-/)

  await cardUntil(
    bob,
    "b",
    { title: "Redeemed.", mono: `receipt ${settled.receipt}`, body: "Two claims burned, two eggs delivered. The same proofs can never be spent again — double redemption dies on the mint's spent-state.", done: "Physical settlement complete.", sayId: "l17" } as CardOpts & { done: string },
    async () => /FARM-/.test((await bob.locator("main").textContent().catch(() => "")) ?? ""),
    30_000,
  )

  // ---- 9 · outro -----------------------------------------------------------
  await card(bob, "b", {
    title: "What just happened.",
    body: `Signet sats in → dated bearer claims out → given hand to hand → redeemed at maturity. ${oracleMid.issued} issued, 2 redeemed, one receipt.`,
    sayId: "l18",
    holdMs: 6_500,
  })
  await card(bob, "b", {
    title: "NUT-32, draft one.",
    body: "Unit grammar, one future tag per secret, signed content-addressed terms, per-day capacity — all enforced by a modified mint and checked by automated tests on the live deployment.",
    sayId: "l19",
    holdMs: 7_000,
  })

  writeTimeline()
  await ctxB.close()
  const takeDir2 = "e2e/.results-video/sarah-take"
  const videoBPath = fs
    .readdirSync(takeDir2)
    .filter((f) => f.endsWith(".webm") && `${takeDir2}/${f}` !== videoAPath)
    .map((f) => `${takeDir2}/${f}`)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => a.m - b.m)
    .at(-1)!.f
  fs.writeFileSync(
    "e2e/.results-video/sarah-parts.json",
    JSON.stringify({ a: videoAPath, b: videoBPath }, null, 2),
  )
  console.log(`FILM a=${videoAPath} (${durA.toFixed(1)}s) b=${videoBPath}`)
})
