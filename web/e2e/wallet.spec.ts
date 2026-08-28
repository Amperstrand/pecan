import { test, expect, type Page } from "@playwright/test"

const WALLET = "/console/wallet"

async function apiLogin(page: Page): Promise<void> {
  await page.request.post(`/api/login`, {
    headers: { "Content-Type": "application/json" },
    data: { username: "admin", password: "admin" },
  })
}

async function matchAndSettle(page: Page, tellerCode: string, kind: string): Promise<{ status: string }> {
  const matchResp = await page.request.post(`/api/quotes/match`, {
    headers: { "Content-Type": "application/json" },
    data: { code: tellerCode },
  })
  const match = await matchResp.json()
  if (!match.id) throw new Error(`match failed for ${tellerCode}: ${JSON.stringify(match).slice(0, 200)}`)

  const settleResp = await page.request.post(`/api/tickets/${match.id}/mark-paid`, {
    headers: { "Content-Type": "application/json" },
    data: { notes: `E2E ${kind}` },
  })
  return settleResp.json()
}

async function trySettleOutgoing(page: Page): Promise<boolean> {
  // Use the match endpoint with the quote prefix (same as teller workflow)
  const resp = await page.request.get(`/api/app`)
  const data = await resp.json()
  const quotes = data?.open_quotes || []
  for (const q of quotes) {
    if (q.kind === "outgoing") {
      // Match by the prefix (first 15 chars = enough for unique match)
      const matchResp = await page.request.post(`/api/quotes/match`, {
        headers: { "Content-Type": "application/json" },
        data: { code: q.prefix.slice(-6) },
      })
      const match = await matchResp.json()
      if (match.id) {
        const settleResp = await page.request.post(`/api/tickets/${match.id}/mark-paid`, {
          headers: { "Content-Type": "application/json" },
          data: { notes: "E2E payout" },
        })
        const result = await settleResp.json()
        return result.status === "paid"
      }
    }
  }
  return false
}

let sharedPage: Page | null = null

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  sharedPage = await context.newPage()
})

test.afterAll(async () => {
  if (sharedPage) await sharedPage.close()
})

test.describe("Browser wallet E2E", () => {
  test.describe.configure({ mode: "serial" })

  test("wallet page loads", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
    await expect(page.locator(".text-4xl")).toBeVisible()
  })

  test("deposit: create → teller match → settle → auto-claim", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await apiLogin(page)

    const beforeText = await page.locator(".text-4xl").textContent()
    const before = parseFloat(beforeText?.replace(/[^\d.]/g, "") || "0")

    await page.getByPlaceholder("5.00").fill("5")
    await page.getByRole("button", { name: "Create deposit quote" }).click()

    await expect(page.locator(".font-mono.text-3xl")).toBeVisible({ timeout: 15_000 })
    const tellerCode = await page.locator(".font-mono.text-3xl").textContent()
    expect(tellerCode).toBeTruthy()
    expect(tellerCode!.trim().length).toBeGreaterThanOrEqual(6)
    console.log("  teller code:", tellerCode?.trim())

    const result = await matchAndSettle(page, tellerCode!.trim(), "deposit")
    expect(result.status).toBe("paid")

    await expect(page.getByRole("button", { name: /✓ Deposited/ })).toBeVisible({ timeout: 30_000 })

    const afterText = await page.locator(".text-4xl").textContent()
    const after = parseFloat(afterText?.replace(/[^\d.]/g, "") || "0")
    expect(after).toBeGreaterThan(before)
    console.log(`  balance: ${before.toFixed(2)} → ${after.toFixed(2)} kr`)
  })

  test("withdraw: create → teller match → settle → PAID", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await apiLogin(page)

    const balanceText = await page.locator(".text-4xl").textContent()
    const balance = parseFloat(balanceText?.replace(/[^\d.]/g, "") || "0")
    expect(balance).toBeGreaterThan(0)
    console.log(`  balance: ${balance.toFixed(2)} kr`)

    await page.getByPlaceholder("Phone or reference").fill("e2e-recipient")
    await page.getByPlaceholder("1.00").fill("1")
    await page.getByRole("button", { name: "Send", exact: true }).click()

    // The mint's async settlement timeout is ~30s — the teller code appears after
    await page.waitForTimeout(35000)
    const content = await page.content()

    if (content.includes("Give this code to the teller")) {
      const tellerCode = await page.locator(".font-mono.text-3xl").textContent()
      console.log("  withdraw code:", tellerCode?.trim())

      const result = await matchAndSettle(page, tellerCode!.trim(), "payout")
      expect(result.status).toBe("paid")

      await expect(page.getByRole("button", { name: /✓ Paid/ })).toBeVisible({ timeout: 60_000 })
      console.log("  withdraw: PAID ✓")
    } else if (content.includes("Need exactly")) {
      console.log("  withdraw: exact subset not available — skipping")
      test.skip(true, "exact subset not available")
    } else {
      console.log("  withdraw: checking for pending outgoing ticket…")
      const settled = await trySettleOutgoing(page)
      if (settled) {
        await expect(page.getByRole("button", { name: /✓ Paid/ })).toBeVisible({ timeout: 60_000 })
        console.log("  withdraw: PAID ✓")
      } else {
        throw new Error("withdraw: no teller code and no pending outgoing ticket")
      }
    }
  })

  test("history shows transactions", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await page.waitForTimeout(3000)
    const items = await page.locator(".flex.items-center.justify-between.py-1").all()
    expect(items.length).toBeGreaterThanOrEqual(1)
  })
})
