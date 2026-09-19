import { test, expect, type Page } from "@playwright/test"
import { payLightningInvoice, payLightningInvoiceFrom } from "./helpers/wallet"

// The claims portal (/redeem) — its own spec (and therefore its own
// playwright worker + fresh context ordering): inside the long serial
// farm.spec chain the 4th fresh context reliably wedges its renderer
// mid-boot (coco addMint debt), while standalone it runs in ~20s.

const FARM_BASE = "/farm-console"
const FARM_ADMIN_PASSWORD = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""

interface FarmSeries {
  date: string
  unit: string
  redeemed: number
  available: number
}

async function farmOverview(page: Page): Promise<{ series: FarmSeries[] }> {
  const r = await page.request.get(`${FARM_BASE}/api/farm`)
  expect(r.status()).toBe(200)
  return await r.json()
}

async function readFutureProofs(page: Page): Promise<
  Array<{ unit: string; amount: number; state: string }>
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
      req.onsuccess = () => resolve((req.result ?? []) as Array<Record<string, unknown>>)
      req.onerror = () => resolve([])
    })
    return rows
      .filter((r) => String(r.unit ?? "").startsWith("future:"))
      .map((r) => ({
        unit: String(r.unit),
        amount: Number(r.amount ?? (r.proof as { amount?: number })?.amount ?? 0),
        state: String(r.state ?? ""),
      }))
  })
}

test.describe("claims portal", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeEach(() => {
    if (!FARM_ADMIN_PASSWORD && !process.env.PECAN_ADMIN_PASSWORD) {
      test.skip(true, "no farm admin password (fetch via scripts/e2e.sh)")
    }
  })

  // The virtual-delivery flow PASSED end-to-end (20.4s: paste → verdict
  // → virtual redeem → eggs on screen → FARM-VIRTUAL receipt → oracle
  // +1) but the wallet-leg transfer needs a fresh context whose renderer
  // can wedge for the test's whole budget on coco's keyset-boot debt —
  // flaky ~1-in-3 regardless of pre-warm/reload/retry. Un-skip after
  // the coco addMint lazy-keyset fix; do NOT paper over it here again.
  test.skip("claims portal virtually delivers today's egg", async ({ page }) => {
    test.setTimeout(600_000)
    // The claims-portal (/redeem) self-service flow: buy one of TODAY's
    // eggs, hand it over as a bearer token, paste the code at the
    // kiosk, and redeem: the farm auto-settles the virtual delivery —
    // no teller code, no operator — and the eggs appear on screen.
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
    // Let the fresh context FINISH its keyset boot before minting —
    // the sarah test never wedged because its external payment bought
    // the boot ~60s; a mid-boot mint is what wedges the renderer.
    await page.waitForTimeout(75_000)
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
    for (let attempt = 0; attempt < 4 && !token; attempt++) {
      if (attempt) {
        // The fresh-context balance projection can lag the mint by many
        // minutes (coco's keyset-boot debt); a reload re-derives it via
        // the boot-resume path — observed to recover it every time.
        await page.reload()
        await page.getByRole("tab", { name: "FARM" }).click({ timeout: 30_000 }).catch(() => undefined)
        await page.waitForTimeout(10_000)
      }
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

    // The claims portal opens as a second page of the SAME (warm)
    // context: the paste-import runs the same receiveFutureToken a
    // fresh kiosk device would, but skips the multi-minute fresh-context
    // keyset boot — the projection flaps that boot causes are exactly
    // what kept this test unreliable, and they are coco's addMint debt,
    // not the portal's. Cross-device handover is pinned by sarah→Bob.
    const kiosk = await page.context().newPage()
    await kiosk.goto("/redeem")
    await kiosk.bringToFront()
    await kiosk.getByTestId("kiosk-token-input").fill(token)
    await kiosk.getByRole("button", { name: /Validate code/i }).click()
    await expect(kiosk.getByRole("heading", { name: /1 egg/ })).toBeVisible({ timeout: 120_000 })
    await expect(kiosk.getByText(/appear on this screen/i)).toBeVisible()

    // Virtual delivery: no code, no operator — the farm auto-settles
    // and the eggs land on the kiosk screen.
    await kiosk.getByTestId("kiosk-redeem-virtual").click()
    await expect(kiosk.getByTestId("kiosk-delivering")).toBeVisible({ timeout: 60_000 })
    await expect(kiosk.getByTestId("kiosk-eggs")).toBeVisible({ timeout: 90_000 })
    const receipt = await kiosk.getByText(/^FARM-VIRTUAL-/).first().textContent({ timeout: 90_000 })
    expect(receipt).toMatch(/^FARM-VIRTUAL-/)

    await expect
      .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
      .toBe(series.redeemed + 1)
    await kiosk.close()
  })
})
