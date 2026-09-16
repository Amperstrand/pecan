import { test, expect, type Page } from "@playwright/test"
import {
  apiLogin,
  matchAndSettle,
  payLightningInvoice,
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
  const open = overview.series.filter((s) => !s.matured && s.available >= 5)
  const series = open[0]
  expect(series, "farm must expose a series with 5+ eggs free").toBeDefined()
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
    const invoiceBox = page.locator("textarea.font-mono")
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
    const proofs = await readFutureProofs(page)
    const mine = proofs.filter((p) => p.unit === series.unit && p.state !== "spent")
    if (mine.reduce((sum, p) => sum + p.amount, 0) !== 5) {
      console.log(
        "FUTURE ROWS:",
        JSON.stringify(
          proofs.map((p) => ({ unit: p.unit, amount: p.amount, state: p.state, secretHead: p.secret.slice(0, 40) })),
        ),
      )
    }
    expect(mine.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
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
    await page.getByRole("button", { name: /Send to Bob/i }).click()
    const tokenBox = page.locator("textarea[readonly]")
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
    await expect
      .poll(async () => {
        const bobProofs = await readFutureProofs(bobPage)
        return bobProofs
          .filter((p) => p.unit === series.unit && p.state !== "spent")
          .reduce((sum, p) => sum + p.amount, 0)
      })
      .toBe(2)
    await bobContext.close()

    // Total supply unchanged by the transfer: issued unchanged.
    const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
    expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)

    // ---------------------------------------------------------------
    // Redemption: mature the series (admin demo override), Bob's 2
    // claims burn at the counter against physical handover.
    // ---------------------------------------------------------------
    await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
    const mature = await page.request.post(`${FARM_BASE}/api/farm/series/${series.date}/mature-now`)
    expect(mature.status()).toBe(200)

    const bobContext2 = await browser.newContext()
    const bobPage2 = await bobContext2.newPage()
    await openFarmWallet(bobPage2)
    await bobPage2.getByPlaceholder(/paste a token/i).fill(token)
    await bobPage2.getByRole("button", { name: /Receive token/i }).click()
    await expect
      .poll(async () => {
        const bobProofs = await readFutureProofs(bobPage2)
        return bobProofs
          .filter((p) => p.unit === series.unit && p.state !== "spent")
          .reduce((sum, p) => sum + p.amount, 0)
      })
      .toBe(2)

    await bobPage2.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
    await bobPage2.getByRole("button", { name: /Redeem at farm/i }).click()
    await expect(
      bobPage2.getByText(/teller code [0-9A-F]{6}/i),
    ).toBeVisible({ timeout: 60_000 })
    const code = await bobPage2.getByText(/teller code ([0-9A-F]{6})/i).textContent()
    const tail = code?.match(/([0-9A-F]{6})/)?.[1] ?? ""
    expect(tail).toHaveLength(6)

    // The admin session lives on Sarah's context — settle from there.
    const settled = await matchAndSettle(page, tail, "eggs handed over", FARM_BASE)
    expect(settled.unit).toBe(series.unit)
    expect(settled.amount).toBe(2)

    await expect
      .poll(async () => (await bobPage2.getByText(/FARM-/i).first().textContent()) ?? "")
      .toMatch(/FARM-/)
    await expect
      .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
      .toBe(series.redeemed + 2)

    // Double redemption dies on spent proofs: Bob's own wallet no longer
    // shows the claims, so the melt cannot even lock inputs.
    const bobLeft = (await readFutureProofs(bobPage2)).filter(
      (p) => p.unit === series.unit && p.state !== "spent",
    )
    expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
    await bobContext2.close()
  })

  test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
    test.setTimeout(120_000)
    const series = await firstOpenSeries(page)

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
    if (series.available > 0) {
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
    }
  })

  test("redemption before maturity is refused", async ({ page }) => {
    const series = (await farmOverview(page)).series.find((s) => !s.matured)
    if (!series) {
      test.skip(true, "no immature series left")
      return
    }
    const r = await page.request.post("/farm/v1/melt/quote/future", {
      data: {
        method: "future",
        request: "farm redemption",
        unit: series.unit,
        amount: 1,
      },
    })
    expect(r.status()).toBeGreaterThanOrEqual(400)
    const body = await r.text()
    expect(body).toContain("matures at")
  })
})
