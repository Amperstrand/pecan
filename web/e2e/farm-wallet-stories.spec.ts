import { test, expect, type Page } from "@playwright/test"
import { chromium } from "@playwright/test"
import { caseOf } from "./helpers/farm-matrix-log"
import { ensureWarm, payInvoice, PROFILE_A, PROFILE_B, WALLET } from "./portal-film-lib"
import { apiLogin, matchAndSettle } from "./helpers/wallet"

// The farm wallet-tier stories: every user journey a human can take,
// on the warm persistent profiles (the film machinery — cold wallets
// crawl). Buys across multiple futures, counter redemption with the
// delivery line, virtual redemption via the claims portal, transfer
// fuzzing, and the day window felt through the UI. One JSONL record
// per case (farm-matrix-results.jsonl) for later analysis.
//
// Run: scripts/farm-fuzz.sh   (warms first; retakes skip warm-up)

const FARM_BASE = "/farm-console"
const MINT = "/farm"
const PASSWORD = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""
const SUITE = "farm-stories"

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

async function openFarmTab(page: Page): Promise<void> {
  await page.goto(WALLET, { waitUntil: "domcontentloaded" })
  await page.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
  await page.getByLabel("production day").waitFor({ timeout: 60_000 })
}

async function mainText(page: Page): Promise<string> {
  return (await page.locator("main").textContent().catch(() => "")) ?? ""
}

/** The header's current total (stories run against wallets that carry
 * earlier stories' claims — counts are always deltas). */
async function headerClaims(page: Page): Promise<number> {
  const m = (await mainText(page)).match(/\b(\d+) egg claims\b/)
  return m ? Number(m[1]) : 0
}

/** Buy `qty` of `date` through the wallet UI, settling the invoice from
 * the farm's own node; resolves when the total claims grew by qty. */
async function buyEggs(page: Page, date: string, qty: number, timeoutMs = 300_000): Promise<void> {
  const before = await headerClaims(page)
  await page.getByLabel("production day").selectOption(date)
  await page.getByLabel("egg quantity").fill(String(qty))
  await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  const box = page.getByTestId("farm-invoice")
  await box.waitFor({ state: "visible", timeout: 30_000 })
  const invoice = (await box.inputValue()) || ""
  expect(invoice.startsWith("lntb")).toBeTruthy()
  expect(await payInvoice(invoice), `self-pay for ${date} x${qty}`).toBe(true)
  const want = before + qty
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await headerClaims(page)) >= want) return
    await page.waitForTimeout(3_000)
  }
  if ((await headerClaims(page)) < want) {
    throw new Error(`claims for ${date} x${qty} never appeared (${before} → ${await headerClaims(page)}, want ${want})`)
  }
}

/** Wait until the header shows exactly n egg claims (projections lag). */
async function claimsVisible(page: Page, n: number, timeoutMs = 240_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (new RegExp(`\\b${n} egg claims\\b`).test(await mainText(page))) return true
    await page.waitForTimeout(4_000)
  }
  return new RegExp(`\\b${n} egg claims\\b`).test(await mainText(page))
}

/** Send `qty` of `unit` as a bearer token from the wallet UI. */
async function transferOut(page: Page, unit: string, qty: number): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) {
      await page.reload()
      await page.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
      await page.waitForTimeout(12_000)
    }
    const tabs = page.getByRole("tablist", { name: "Egg series" }).getByRole("tab")
    if ((await tabs.count()) > 1) await tabs.last().click()
    await page.getByLabel(`send quantity for ${unit}`).fill(String(qty))
    await page.getByRole("button", { name: /Transfer ownership/i }).click({ timeout: 90_000 })
    try {
      const box = page.getByTestId("farm-token")
      await box.waitFor({ state: "visible", timeout: 90_000 })
      return await box.inputValue()
    } catch {
      /* projection flap — retry */
    }
  }
  throw new Error(`transfer of ${unit} x${qty} never produced a token`)
}

/** close() on a wedged page hangs forever and swallows the real test
 * error — race it with a deadline and move on. */
async function closeHard(ctx: { close(): Promise<void> }, ms = 10_000): Promise<void> {
  await Promise.race([
    ctx.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, ms)),
  ]).catch(() => undefined)
}

test.describe("farm wallet stories", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeEach(() => {
    if (!PASSWORD && !process.env.PECAN_ADMIN_PASSWORD) {
      test.skip(true, "no farm admin password (fetch via scripts/e2e.sh)")
    }
  })

  test("the multi-futures wallet: buy three dates in one session", async () => {
    test.setTimeout(1_800_000)
    // WIP (skip-pinned): the journeys below are covered green by
    // farm.spec (sarah: counter + delivery line), farm-portal.spec
    // (virtual redemption) and the film take — this suite's added value
    // is running them BACK-TO-BACK on one persistent wallet, which the
    // coco boot/crawl debt currently makes unusable in-runner (every
    // step sits at its timeout bound for minutes). Un-skip after the
    // addMint fix.
    test.skip(true, "wallet-tier stories pending coco's cold-path fix — see docs/status.md")
    console.error("STORY pre-warm")
    await ensureWarm("future:farm-egg:none") // warm-marker gate only
    console.error("STORY pre-launch")
    const ctx = await chromium.launchPersistentContext(PROFILE_A, { headless: true, timeout: 90_000 })
    console.error("STORY launched")
    const a = await ctx.newPage()
    try {
      await openFarmTab(a)
      const dates = [isoDate(0), isoDate(1), isoDate(2)]
      for (const date of dates) {
        await caseOf(SUITE, "multi-buy", "buy-per-date", { date, qty: 1 }, async () => {
          await buyEggs(a, date, 1)
          return "minted + projected"
        })
      }
      await caseOf(SUITE, "multi-buy", "three-series-tabs", { dates }, async () => {
        const ok = await claimsVisible(a, 3)
        expect(ok, "header shows 3 egg claims").toBe(true)
        const tabs = await a
          .getByRole("tablist", { name: "Egg series" })
          .getByRole("tab")
          .allInnerTexts()
        expect(tabs.length).toBeGreaterThanOrEqual(3)
        return `tabs: ${tabs.join(" | ")}`
      })
      await caseOf(SUITE, "multi-buy", "ledger-counts-them-all", { dates }, async () => {
        const ov = await a.request.get(`${FARM_BASE}/api/farm`).then((r) => r.json())
        for (const date of dates) {
          const s = ov.series.find((x: { date: string }) => x.date === date)
          expect(s.issued, `${date} issued grew`).toBeGreaterThan(0)
        }
        return "all three dates issued"
      })
    } finally {
      await closeHard(ctx)
    }
  })

  test("counter redemption with the delivery line", async () => {
    test.setTimeout(1_200_000)
    const ctx = await chromium.launchPersistentContext(PROFILE_A, { headless: true })
    const a = await ctx.newPage()
    try {
      await openFarmTab(a)
      const today = isoDate(0)
      await caseOf(SUITE, "counter", "buy-one-for-the-counter", { date: today }, async () => {
        await buyEggs(a, today, 1)
        return "1 claim ready"
      })
      await caseOf(SUITE, "counter", "redeem-opens-a-teller-code", { date: today }, async () => {
        await claimsVisible(a, 1, 60_000).catch(() => undefined)
        const tabs = a.getByRole("tablist", { name: "Egg series" }).getByRole("tab")
        if ((await tabs.count()) > 1) await tabs.last().click()
        await a.getByLabel(/redeem quantity for/).first().fill("1")
        await a.getByRole("button", { name: /Redeem at farm/i }).click()
        await expect(a.getByText(/teller code [0-9A-F]{6}/i)).toBeVisible({ timeout: 60_000 })
        return "code shown"
      })
      const codeText = await a.getByText(/teller code ([0-9A-F]{6})/i).first().textContent()
      const tail = codeText?.match(/([0-9A-F]{6})/)?.[1] ?? ""
      await caseOf(
        SUITE,
        "counter",
        "operator-settles-with-delivery-line",
        { tail, delivered: 0, condition: "dropped on the way" },
        async () => {
          await apiLogin(a, FARM_BASE, PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
          const settled = await matchAndSettle(a, tail, "story settle", FARM_BASE, {
            delivered: 0,
            condition: "dropped on the way — voucher owed",
          })
          expect(settled.amount).toBe(1)
          expect(settled.delivered).toBe(0)
          expect(settled.condition).toContain("dropped")
          return `receipt ${settled.receipt}, delivery line recorded`
        },
      )
      await caseOf(SUITE, "counter", "wallet-sees-the-receipt", undefined, async () => {
        await expect(a.getByText(/^FARM-2609/).or(a.getByText(/^FARM-/)).first()).toBeVisible({
          timeout: 90_000,
        })
        return "receipt on the wallet"
      })
    } finally {
      await closeHard(ctx)
    }
  })

  test("virtual redemption through the claims portal", async () => {
    test.setTimeout(1_200_000)
    const ctxA = await chromium.launchPersistentContext(PROFILE_A, { headless: true })
    const a = await ctxA.newPage()
    try {
      await openFarmTab(a)
      const today = isoDate(0)
      let token = ""
      await caseOf(SUITE, "virtual", "buy-and-hand-over", { date: today, qty: 1 }, async () => {
        await buyEggs(a, today, 2)
        await claimsVisible(a, 2).catch(() => undefined)
        token = await transferOut(a, `future:farm-egg:${today.replace(/-/g, "")}t160000z`, 1)
        expect(token.length).toBeGreaterThan(50)
        return "bearer token out"
      })

      const ctxB = await chromium.launchPersistentContext(PROFILE_B, { headless: true })
      const b = await ctxB.newPage()
      try {
        await caseOf(SUITE, "virtual", "portal-redeems-no-operator", { qty: 1 }, async () => {
          await b.goto("https://giftcard.cashu.exchange/redeem")
          await b.getByTestId("kiosk-token-input").fill(token)
          await b.getByRole("button", { name: /Validate code/i }).click()
          await b.getByRole("heading", { name: /1 egg/ }).waitFor({ timeout: 240_000 })
          await b.getByTestId("kiosk-redeem-virtual").click()
          await b.getByTestId("kiosk-eggs").waitFor({ timeout: 120_000 })
          const receipt = await b.getByText(/^FARM-VIRTUAL-/).first().textContent()
          expect(receipt).toMatch(/^FARM-VIRTUAL-/)
          return `eggs on screen, ${receipt}`
        })
      } finally {
        await ctxB.close()
      }
    } finally {
      await ctxA.close()
    }
  })

  test("transfer fuzz: partial sends and refusals", async () => {
    test.setTimeout(1_200_000)
    const ctx = await chromium.launchPersistentContext(PROFILE_A, { headless: true })
    const a = await ctx.newPage()
    try {
      await openFarmTab(a)
      const today = isoDate(0)
      const unit = `future:farm-egg:${today.replace(/-/g, "")}t${today >= "2026-09-28" ? "06" : "16"}0000z`
      await caseOf(SUITE, "transfer", "over-balance-send-refused", { unit, try: 99 }, async () => {
        await buyEggs(a, today, 1)
        await claimsVisible(a, 1).catch(() => undefined)
        const tabs = a.getByRole("tablist", { name: "Egg series" }).getByRole("tab")
        if ((await tabs.count()) > 1) await tabs.last().click()
        await a.getByLabel(`send quantity for ${unit}`).fill("99")
        await a.getByRole("button", { name: /Transfer ownership/i }).click()
        await expect(a.getByText(/Not enough claims/i)).toBeVisible({ timeout: 30_000 })
        return "client refuses: not enough claims"
      })
      await caseOf(SUITE, "transfer", "send-quantity-must-be-integer", { unit, try: "1.5" }, async () => {
        await a.getByLabel(`send quantity for ${unit}`).fill("1.5")
        await a.getByRole("button", { name: /Transfer ownership/i }).click()
        await expect(a.getByText(/positive integer/i)).toBeVisible({ timeout: 15_000 })
        return "client refuses: non-integer"
      })
      await caseOf(SUITE, "transfer", "exact-balance-send-succeeds", { unit, qty: 1 }, async () => {
        await a.getByLabel(`send quantity for ${unit}`).fill("1")
        await a.getByRole("button", { name: /Transfer ownership/i }).click()
        await page_waitToken(a)
        return "last egg handed over"
      })
      void MINT
    } finally {
      await closeHard(ctx)
    }
  })

  test("the day window felt through the wallet", async () => {
    test.setTimeout(1_200_000)
    const ctx = await chromium.launchPersistentContext(PROFILE_A, { headless: true })
    const a = await ctx.newPage()
    try {
      await openFarmTab(a)
      const tomorrow = isoDate(1)
      await caseOf(SUITE, "day-window", "buy-tomorrows-egg", { date: tomorrow }, async () => {
        await buyEggs(a, tomorrow, 1)
        return "tomorrow's claim held"
      })
      await caseOf(
        SUITE,
        "day-window",
        "redeeming-tomorrow-refused-today",
        { date: tomorrow },
        async () => {
          await claimsVisible(a, 1).catch(() => undefined)
          const tabs = a.getByRole("tablist", { name: "Egg series" }).getByRole("tab")
          if ((await tabs.count()) > 1) await tabs.last().click()
          await a.getByLabel(/redeem quantity for/).first().fill("1")
          await a.getByRole("button", { name: /Redeem at farm/i }).click()
          // the melt refuses server-side; the panel surfaces the error
          await expect(
            a.getByText(/come back on the day|claim-it-or-lose-it|refused/i),
          ).toBeVisible({ timeout: 60_000 })
          return "day window enforced through the UI"
        },
      )
    } finally {
      await closeHard(ctx)
    }
  })
})

async function page_waitToken(page: Page): Promise<void> {
  await page.getByTestId("farm-token").waitFor({ state: "visible", timeout: 90_000 })
}
