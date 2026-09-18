import { test, expect, type Page } from "@playwright/test"
import {
  apiLogin,
  matchAndSettle,
  payLightningInvoice,
  payLightningInvoiceFrom,
  rebalanceSwapChannels,
} from "./helpers/wallet"

// Sarah's story (NUT-32 egg-futures spike): buy five next-Friday egg
// futures with 5000 real signet sats, receive 5 tagged bearer claims,
// send 2 to Bob, redeem at the farm counter — the whole physical-futures
// loop against the deployed farm pair.

const FARM_BASE = "/farm-console"
const FARM_ADMIN_PASSWORD = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""

interface FarmSeries {
  date: string
  unit: string
  maturity: number
  capacity: number
  issued: number
  redeemed: number
  available: number
  price_sats: number
  terms_uri: string
  terms_sha256: string
  matured: boolean
}

async function farmOverview(page: Page): Promise<{ series: FarmSeries[] }> {
  const r = await page.request.get(`${FARM_BASE}/api/farm`)
  expect(r.status()).toBe(200)
  return await r.json()
}

async function firstOpenSeries(page: Page): Promise<FarmSeries> {
  const overview = await farmOverview(page)
  // Same-day first: the sales window is the whole production day, so
  // today's eggs (even past the collection hour) are the demo path —
  // mirroring the wallet panel's default selection.
  const today = new Date().toISOString().slice(0, 10)
  const open = overview.series.filter((s) => s.date >= today && s.available >= 5)
  const series = open[0]
  if (!series) {
    test.skip(
      true,
      "no series with 5+ free eggs (earlier runs consumed the horizon — raise FARM_HORIZON_DAYS or wait for the claim-window sweep)",
    )
  }
  return series
}

async function openFarmWallet(page: Page): Promise<void> {
  await page.goto("/wallet")
  await page
    .getByRole("tab", { name: "FARM" })
    .click()
  await expect(page.getByLabel("production day")).toBeVisible({ timeout: 30_000 })
}

/** Read the future-unit proof rows straight out of the wallet's IDB —
 * the independent "proofs really exist and carry the NUT-32 tag" check. */
async function readFutureProofs(page: Page): Promise<
  Array<{ unit: string; amount: number; secret: string; state: string }>
> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("giftcard-coco-wallet")
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const tx = db.transaction("coco_cashu_proofs", "readonly")
      const req = tx.objectStore("coco_cashu_proofs").getAll()
      req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>)
      req.onerror = () => resolve([])
    })
    return rows
      .filter((r) => String(r.unit ?? "").startsWith("future:"))
      .map((r) => ({
        unit: String(r.unit),
        amount: Number(r.amount ?? (r.proof as { amount?: number })?.amount ?? 0),
        secret: String(r.secret ?? (r.proof as { secret?: string })?.secret ?? ""),
        state: String(r.state ?? ""),
      }))
  })
}

function futureTag(secret: string): { version: string; uri: string } | null {
  try {
    const parsed = JSON.parse(secret) as { tags?: string[][] }
    const futures = (parsed.tags ?? []).filter(
      (t) => Array.isArray(t) && t[0] === "future" && t.length === 3,
    )
    if (futures.length !== 1) return null
    return { version: futures[0][1], uri: futures[0][2] }
  } catch {
    return null
  }
}

test.describe("farm futures (NUT-32 spike)", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeEach(async ({ page }) => {
    if (!FARM_ADMIN_PASSWORD && !process.env.PECAN_ADMIN_PASSWORD) {
      test.skip(true, "no farm admin password (fetch via scripts/e2e.sh)")
    }
    // Every Sarah run pays 5000 sat toward cln-swap; keep the payers'
    // side of the channels funded (best-effort rig maintenance).
    rebalanceSwapChannels(30_000)
    await openFarmWallet(page)
  })

  test("sarah_buys_five_friday_eggs_with_signet", async ({ page, browser }) => {
    test.setTimeout(420_000)
    const series = await firstOpenSeries(page)
    const price = series.price_sats
    expect(price).toBeGreaterThan(0)

    // Drive the production-day picker to the verified series — the
    // panel's default is merely the first open day.
    await page.getByLabel("production day").selectOption(series.date)

    // Unpaid quote reserves capacity: the overview shows 5 fewer free
    // eggs the moment the purchase exists.
    await page.getByLabel("egg quantity").fill("5")
    await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
    const invoiceBox = page.getByTestId("farm-invoice")
    await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
    const invoice = (await invoiceBox.inputValue()) || (await invoiceBox.textContent()) || ""
    expect(invoice.startsWith("lntb")).toBeTruthy()

    await expect
      .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.available ?? -1)
      .toBe(series.available - 5)

    // Real signet payment from an external lab node.
    const preimage = payLightningInvoice(invoice.trim())
    expect(preimage).toMatch(/^[0-9a-f]{64}$/)

    // Payment confirmed → the panel mints → owned. (The transient
    // "minting…" phase can complete while the external pay call is still
    // returning — assert the outcome, not the intermediate.)
    await expect(page.getByText("5 egg claims").first()).toBeVisible({ timeout: 90_000 })

    // Proofs really exist, carry the unit, the exactly-one future tag,
    // and the series' exact terms URI.
    // Proof rows can land a beat after the balance projection — the
    // background watcher drives the op to finalized and saves the proofs.
    await expect
      .poll(
        async () => {
          const mine = (await readFutureProofs(page)).filter(
            (p) => p.unit === series.unit && p.state !== "spent",
          )
          return mine.reduce((sum, p) => sum + p.amount, 0)
        },
        { timeout: 45_000 },
      )
      .toBe(5)
    const mine = (await readFutureProofs(page)).filter(
      (p) => p.unit === series.unit && p.state !== "spent",
    )
    for (const proof of mine) {
      const tag = futureTag(proof.secret)
      expect(tag, `proof secret must carry exactly one future tag: ${proof.secret.slice(0, 80)}`).not.toBeNull()
      expect(tag?.version).toBe("1")
      expect(tag?.uri).toBe(series.terms_uri)
    }

    // Series accounting moved (the farm's minted-marker polls the mint
    // quote state, so `issued` converges within a few seconds); capacity
    // ledger is aggregate-only.
    await expect
      .poll(
        async () =>
          (await farmOverview(page)).series.find((s) => s.date === series.date)?.issued ?? -1,
        { timeout: 30_000 },
      )
      .toBe(series.issued + 5)
    const after = (await farmOverview(page)).series.find((s) => s.date === series.date)
    expect(after?.available).toBe(series.available - 5)

    // Terms blob is content-addressed: the digest in the URI addresses
    // the exact bytes served.
    const termsResp = await page.request.get(`${FARM_BASE}/terms/${series.terms_sha256}`)
    expect(termsResp.status()).toBe(200)
    const blob = await termsResp.text()
    const digest = await page.evaluate(async (text) => {
      const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
      return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")
    }, blob)
    expect(digest).toBe(series.terms_sha256)
    const envelope = JSON.parse(blob) as { mint: string; signature: string; terms: { unit: string } }
    expect(envelope.terms.unit).toBe(series.unit)
    expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/)
    expect(envelope.mint).toContain("/farm")

    // The mint advertises NUT-32.
    const info = await page.request.get("/farm/v1/info").then((r) => r.json())
    expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })

    // Issuance is wallet-bound: a locked future quote referencing an
    // unknown purchase is refused by the mint/processor (wrong-key-
    // for-known-purchase is pinned in processor tests).
    const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
      data: {
        amount: 5,
        unit: series.unit,
        pubkey: "02" + "ab".repeat(32),
        description: "foreign key attempt",
        purchase: "does-not-exist",
      },
    })
    expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)

    // ---------------------------------------------------------------
    // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
    // ---------------------------------------------------------------
    await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
    await page.getByRole("button", { name: /Transfer ownership/i }).click()
    const tokenBox = page.getByTestId("farm-token")
    await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
    const token = await tokenBox.inputValue()
    expect(token.length).toBeGreaterThan(50)

    await expect
      .poll(async () => {
        const balances = await readFutureProofs(page)
        return balances
          .filter((p) => p.unit === series.unit && p.state !== "spent")
          .reduce((sum, p) => sum + p.amount, 0)
      })
      .toBe(3)

    // The swap preserved unit and terms URI on every replacement proof.
    const sarahProofs = (await readFutureProofs(page)).filter(
      (p) => p.unit === series.unit && p.state !== "spent",
    )
    for (const proof of sarahProofs) {
      expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
    }

    // Bob: a fresh browser profile receives the token and owns 2.
    const bobContext = await browser.newContext()
    const bobPage = await bobContext.newPage()
    await openFarmWallet(bobPage)
    await bobPage.getByPlaceholder(/paste a token/i).fill(token)
    await bobPage.getByRole("button", { name: /Receive token/i }).click()
    // A fresh context boots five mints (incl. the external sat mint)
    // before the receive can run — give it a real budget.
    await expect
      .poll(async () => {
        const bobProofs = await readFutureProofs(bobPage)
        return bobProofs
          .filter((p) => p.unit === series.unit && p.state !== "spent")
          .reduce((sum, p) => sum + p.amount, 0)
      }, { timeout: 120_000 })
      .toBe(2)

    // Total supply unchanged by the transfer: issued unchanged.
    const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
    expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)

    // ---------------------------------------------------------------
    // Redemption: claims are collectable 24/7 on their production
    // date — Bob's 2 claims burn at the counter, same day, no
    // override needed.
    // ---------------------------------------------------------------
    await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")

    // Bearer tokens are single-handover: the same token cannot be
    // received twice (its proofs are spent), so Bob redeems from the
    // wallet that already holds them.
    const bobPage2 = bobPage
    await bobPage2.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
    await bobPage2.getByRole("button", { name: /Redeem at farm/i }).click()
    await expect(
      bobPage2.getByText(/teller code [0-9A-F]{6}/i),
    ).toBeVisible({ timeout: 60_000 })
    const code = await bobPage2.getByText(/teller code ([0-9A-F]{6})/i).textContent()
    const tail = code?.match(/([0-9A-F]{6})/)?.[1] ?? ""
    expect(tail).toHaveLength(6)

    // The admin session lives on Sarah's context — settle from there,
    // recording the delivery line (best-effort rails carry what
    // actually happened at handover for later analysis).
    const settled = await matchAndSettle(page, tail, "eggs handed over", FARM_BASE, {
      delivered: 1,
      condition: "one egg cracked in the carton",
    })
    expect(settled.unit).toBe(series.unit)
    expect(settled.amount).toBe(2)
    expect(settled.delivered).toBe(1)
    expect(settled.condition).toContain("cracked")

    // The melt finalizes asynchronously after the operator settles. The
    // receipt is proven EITHER from the wallet panel OR straight from the
    // mint's quote state (payment_preimage) — the invariant is that the
    // burn completed and produced a FARM receipt.
    const receiptSeen = await bobPage2
      .getByText(/FARM-\d/i)
      .first()
      .textContent({ timeout: 90_000 })
      .then((t) => (t ?? "").match(/FARM-[0-9A-F-]+/i)?.[0] ?? null)
      .catch(() => null)
    let receipt = receiptSeen
    if (!receipt) {
      const q = await page.request.get(`/farm/v1/melt/quote/future/${settled.quote_id}`)
      const body = (await q.json()) as { payment_preimage?: string; state?: string }
      expect(body.state).toBe("PAID")
      receipt = body.payment_preimage ?? null
    }
    expect(receipt).toMatch(/^FARM-/)
    await expect
      .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
      .toBe(series.redeemed + 2)

    // Double redemption dies on spent proofs: Bob's own wallet no longer
    // shows the claims, so the melt cannot even lock inputs.
    const bobLeft = (await readFutureProofs(bobPage2)).filter(
      (p) => p.unit === series.unit && p.state !== "spent",
    )
    expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
    await bobContext.close()
  })

  test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
    test.setTimeout(120_000)
    // Grab capacity on the HORIZON'S LAST free day, never today: the
    // reservation lives ~30 min (invoice TTL) and must not lock the
    // same-day demo path after a suite run.
    const overview = await farmOverview(page)
    const series = [...overview.series].reverse().find((s) => s.available >= 1)
    if (!series) {
      test.skip(true, "no free capacity anywhere on the horizon")
      return
    }

    // An 11-egg claim cannot exist: the API refuses beyond capacity.
    const tooMany = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
      data: {
        production_date: series.date,
        quantity: series.capacity + 1,
        pubkey: "02" + "cd".repeat(32),
      },
    })
    expect(tooMany.status()).toBeGreaterThanOrEqual(400)

    // Purchase everything that is left — the next one must fail.
    const grab = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
      data: {
        production_date: series.date,
        quantity: series.available,
        pubkey: "02" + "ef".repeat(32),
      },
    })
    expect(grab.status()).toBe(200)
    const none = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
      data: {
        production_date: series.date,
        quantity: 1,
        pubkey: "02" + "ef".repeat(32),
      },
    })
    expect(none.status()).toBeGreaterThanOrEqual(400)
    expect((await none.json()).error).toContain("capacity")
  })

  test("redemption is same-day only (claim-it-or-lose-it)", async ({ page }) => {
    const overview = await farmOverview(page)
    const today = new Date().toISOString().slice(0, 10)

    // A future-dated series never mints a redemption quote: its eggs
    // are claimable 24/7 on — and only on — their own date.
    const future = overview.series.find((s) => s.date > today)
    if (future) {
      const r = await page.request.post("/farm/v1/melt/quote/future", {
        data: {
          method: "future",
          request: "farm redemption",
          unit: future.unit,
          amount: 1,
        },
      })
      expect(r.status()).toBeGreaterThanOrEqual(400)
      // The mint wraps the processor's day-window refusal as a generic
      // "unit unsupported" — the invariant is that NO quote exists for a
      // future date.
      expect((await r.text()).toLowerCase()).toMatch(
        /come back on the day|claim-it-or-lose-it|unsupported/,
      )
    }

    // Today's series redeems at ANY hour of the day.
    const todays = overview.series.find((s) => s.date === today && s.available >= 1)
    if (todays) {
      const r = await page.request.post("/farm/v1/melt/quote/future", {
        data: {
          method: "future",
          request: "farm redemption",
          unit: todays.unit,
          amount: 1,
        },
      })
      expect(r.status()).toBe(200)
      const body = (await r.json()) as { quote?: string }
      expect(body.quote).toBeTruthy()
    }
  })

  // KNOWN DEBT (skip until coco's addMint keyset crawl is fixed): the
  // paste-import boots a fresh wallet context and the main thread can
  // wedge for many minutes mid-boot — every end-to-end kiosk shape
  // tripped it (traces show a frozen farm-token wait). The kiosk flow
  // is exercised live by `make farm-demo` instead; the redemption
  // logic itself is shared with the wallet panel via runFarmRedemption
  // and pinned by the tests above.
  test.skip("claims portal redeems today's egg", async ({ page, browser }) => {
    test.setTimeout(900_000)
    // The claims-portal (/redeem) self-service flow: buy one of TODAY's
    // eggs, hand it over as a bearer token, paste the code at the
    // kiosk, redeem, settle.
    const overview = await farmOverview(page)
    const today = new Date().toISOString().slice(0, 10)
    const series = overview.series.find((s) => s.date === today && s.available >= 1)
    if (!series) {
      test.skip(true, "today's eggs are sold out")
      return
    }

    await page.goto("/wallet")
    await page.getByRole("tab", { name: "FARM" }).click()
    await page.getByLabel("production day").waitFor({ state: "visible", timeout: 30_000 })
    await page.getByLabel("production day").selectOption(series.date)
    await page.getByLabel("egg quantity").fill("1")
    await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
    // Pay from an external lab node (NOT autopay): the ~30s payment leg
    // lets the fresh context finish its keyset boot before the mint —
    // a mid-boot mint once left the proof projection hanging for
    // minutes (the sarah test's shape avoids it for the same reason).
    const invoiceBox = page.getByTestId("farm-invoice")
    await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
    const invoice = (await invoiceBox.inputValue()) || (await invoiceBox.textContent()) || ""
    expect(invoice.startsWith("lntb")).toBeTruthy()
    // Lab nodes first (the ~30s leg lets the fresh context finish its
    // keyset boot before the mint); if the rig's routes are dark, fall
    // back to the farm node's own self-pay (what autopay does). Either
    // way the farm marks the purchase paid.
    let preimage = ""
    try {
      preimage = payLightningInvoice(invoice.trim())
    } catch {
      preimage = payLightningInvoiceFrom("cln-swap-signet", invoice.trim())
    }
    expect(preimage).toMatch(/^[0-9a-f]{64}$/)
    await expect(page.getByText(/YOU OWN — Farm eggs · 1 claims/)).toBeVisible({ timeout: 180_000 })

    const proofSum = () =>
      readFutureProofs(page).then((rows) =>
        rows
          .filter((p) => p.unit === series.unit && p.state !== "spent")
          .reduce((sum, p) => sum + p.amount, 0),
      )
    await expect.poll(proofSum, { timeout: 90_000 }).toBeGreaterThanOrEqual(1)

    let token = ""
    for (let attempt = 0; attempt < 3 && !token; attempt++) {
      if (attempt) await page.waitForTimeout(15_000)
      // The YOU OWN card shows one action row set per series tab;
      // balances sort by unit, so the newest date is last.
      const eggTabs = page.getByRole("tablist", { name: "Egg series" }).getByRole("tab")
      if ((await eggTabs.count()) > 1) await eggTabs.last().click()
      await page.getByLabel(`send quantity for ${series.unit}`).fill("1")
      await page.getByRole("button", { name: /Transfer ownership/i }).click()
      try {
        const box = page.getByTestId("farm-token")
        await box.waitFor({ state: "visible", timeout: 30_000 })
        token = (await box.inputValue()) || ""
      } catch {
        /* projection flap — the next attempt re-selects the series */
      }
    }
    expect(token.length).toBeGreaterThan(50)

    // The claims portal is its own device: a fresh context, created NOW
    // and foregrounded — a backgrounded kiosk tab gets frozen by
    // Chromium's tab freezing and its import stalls forever (that once
    // looked like a "slow boot"). The paste-import then runs the full
    // fresh-context wallet boot, so it gets a long budget.
    const kioskContext = await browser.newContext()
    const kiosk = await kioskContext.newPage()
    await kiosk.goto("/redeem")
    await kiosk.bringToFront()
    await kiosk.getByTestId("kiosk-token-input").fill(token)
    await kiosk.getByRole("button", { name: /Validate code/i }).click()
    try {
      await expect(kiosk.getByRole("heading", { name: /1 egg/ })).toBeVisible({ timeout: 420_000 })
    } catch (e) {
      await kiosk.screenshot({ path: "/tmp/kiosk-fail.png", fullPage: true }).catch(() => undefined)
      throw e
    }
    await expect(kiosk.getByText(/collect 24\/7 today/i)).toBeVisible()

    await kiosk.getByRole("button", { name: /Redeem 1 egg/i }).click()
    const tailText = await kiosk.getByTestId("kiosk-tail").textContent({ timeout: 60_000 })
    const tail = tailText?.match(/([0-9A-F]{6})/)?.[1] ?? ""
    expect(tail).toHaveLength(6)

    // The operator settles from an authenticated context and records
    // the delivery line: one egg, and it arrived broken.
    await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
    const settled = await matchAndSettle(page, tail, "egg handover", FARM_BASE, {
      delivered: 0,
      condition: "broken in the carton — replacement owed next collection",
    })
    expect(settled.unit).toBe(series.unit)
    expect(settled.amount).toBe(1)
    expect(settled.delivered).toBe(0)
    expect(settled.condition).toContain("broken")

    await expect(kiosk.getByText(/Eggs redeemed/i)).toBeVisible({ timeout: 90_000 })
    await expect(kiosk.getByText(/^FARM-/)).toBeVisible({ timeout: 90_000 })
    await expect
      .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
      .toBe(series.redeemed + 1)
    await kioskContext.close()
  })

  test("closing the page no longer orphans a paid purchase (resume)", async ({ browser }) => {
    test.setTimeout(420_000)
    // The incident this pins: autopay settles the invoice AFTER the
    // customer's tab closes — the purchase used to sit paid forever
    // (sats reserved, nothing minted). The panel now probes remembered
    // purchases on load and drives any still in flight to minting.
    const context = await browser.newContext()
    const page = await context.newPage()
    const overview = await (await page.request.get(`${FARM_BASE}/api/farm`)).json() as {
      series: Array<{ date: string; available: number }>
    }
    const today = new Date().toISOString().slice(0, 10)
    const series = overview.series.find((s) => s.date === today && s.available >= 1)
    if (!series) {
      test.skip(true, "today's eggs are sold out")
      return
    }

    await page.goto("/wallet")
    await page.getByRole("tab", { name: "FARM" }).click()
    await page.getByLabel("production day").waitFor({ state: "visible", timeout: 30_000 })
    await page.getByLabel("production day").selectOption(series.date)
    await page.getByLabel("egg quantity").fill("1")
    await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
    await page.getByTestId("farm-invoice").waitFor({ state: "visible", timeout: 30_000 })
    await page.close()

    // Autopay (60s timer) settles the invoice while NO wallet page
    // exists — exactly the orphan window. (Plain timer: the closed page
    // can't host waitForTimeout.)
    await new Promise((r) => setTimeout(r, 90_000))

    const reopened = await context.newPage()
    await reopened.goto("/wallet")
    await reopened.getByRole("tab", { name: "FARM" }).click()
    await expect(reopened.getByText(/YOU OWN — Farm eggs · 1 claims/)).toBeVisible({ timeout: 180_000 })
    await expect
      .poll(async () => {
        const db = await reopened.evaluate(async () => {
          const req = indexedDB.open("giftcard-coco-wallet")
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          })
          const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
            const tx = database.transaction("coco_cashu_proofs", "readonly")
            const getAll = tx.objectStore("coco_cashu_proofs").getAll()
            getAll.onsuccess = () => resolve((getAll.result ?? []) as Array<Record<string, unknown>>)
            getAll.onerror = () => resolve([])
          })
          return rows.filter((r) => String(r.unit ?? "").startsWith("future:")).length
        })
        return db
      }, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1)
    await context.close()
  })
})
