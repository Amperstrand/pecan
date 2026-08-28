// e2e-wallet.spec.ts — Playwright test for the pecan browser wallet
// Run: npx playwright test e2e-wallet.spec.ts
//
// Tests the full deposit + withdraw cycle through the browser wallet,
// with the teller approval simulated via the pecan API.
//
// Prerequisites:
//   - Pecan running at https://giftcard.cashu.exchange/console/
//   - Wallet page at https://giftcard.cashu.exchange/console/wallet
//   - Admin credentials for the pecan API (for teller settlement)

import { test, expect, type Page } from "@playwright/test"

const WALLET_URL = "https://giftcard.cashu.exchange/console/wallet"
const PECAN_INTERNAL = "http://127.0.0.1:9091"
const ADMIN_USER = "admin"
const ADMIN_PASS = "admin"

// ── Helpers ──────────────────────────────────────────────────

async function tellerLogin(baseURL: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  const cookie = res.headers.get("set-cookie") || ""
  return cookie.split(";")[0]
}

async function tellerSettle(baseURL: string, cookie: string, ticketId: string, notes: string) {
  const res = await fetch(`${baseURL}/api/tickets/${ticketId}/mark-paid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ notes }),
  })
  return res.json()
}

// SSH to inr2 to call the pecan API (it's on localhost only)
// We use a simpler approach: run via SSH
const { execSync } = require("child_process")

function settleViaSSH(ticketId: string, notes: string): { status: string } {
  const cmd = `ssh root@46.224.104.12 'curl -s -b /tmp/pc -X POST "http://127.0.0.1:9091/api/tickets/${ticketId}/mark-paid" -H "Content-Type: application/json" -d '{"notes":"${notes}"}'`
  const output = execSync(cmd, { encoding: "utf8" })
  return JSON.parse(output)
}

// ── Tests ────────────────────────────────────────────────────

test.describe("Pecan browser wallet", () => {
  test.describe.configure({ mode: "serial" })

  test("wallet page loads", async ({ page }) => {
    await page.goto(WALLET_URL)
    await expect(page.locator("h1")).toContainText("Wallet")
    // Balance should show (0.00 kr on fresh visit, or cached from IndexedDB)
    await expect(page.locator(".text-4xl")).toBeVisible()
  })

  test("deposit: create quote → teller approves → balance updates", async ({ page }) => {
    await page.goto(WALLET_URL)

    // Get balance before
    const balanceBefore = await page.locator(".text-4xl").textContent()
    console.log("  balance before:", balanceBefore)

    // Enter deposit amount
    await page.fill("#dep-amt", "5")
    await page.click("button:has-text('Create deposit quote')")

    // Wait for the teller code to appear
    await expect(page.locator(".font-mono.text-3xl")).toBeVisible({ timeout: 15000 })
    const tailCode = await page.locator(".font-mono.text-3xl").textContent()
    console.log("  teller code:", tailCode)
    expect(tailCode).toBeTruthy()
    expect(tailCode!.length).toBeGreaterThanOrEqual(6)

    // Extract the full quote ID from the page (or from the mint)
    // The wallet displays the tail; we need the full ID for the teller API
    // We'll use the mint API to find the pending quote
    const mintInfo = await page.evaluate(async () => {
      const r = await fetch("/v1/info")
      return r.json()
    })
    expect(mintInfo.name).toBeTruthy()

    // For the teller settlement, we need the full ticket ID
    // The wallet page stores the quote in IndexedDB — let's get it from the UI state
    // Actually, let's use the mint API to find the pending quote
    // But the simplest approach: the teller code IS the quote tail — we can find the ticket
    // by searching the pecan API

    // For now, we'll use a different approach: intercept the quote creation
    // and capture the full ID
    const quoteId = await page.evaluate(async () => {
      // Read from IndexedDB — the wallet stores pending quotes
      const db = await indexedDB.open("giftcard-wallet")
      return new Promise<string>((resolve) => {
        const tx = db.transaction(["pending"], "readonly")
        const store = tx.objectStore("pending")
        const req = store.getAll()
        req.onsuccess = () => {
          const items = req.result as Array<{ quote_id: string }>
          const latest = items[items.length - 1]
          resolve(latest?.quote_id || "")
        }
      })
    })

    console.log("  quote ID from IndexedDB:", quoteId)
    expect(quoteId).toBeTruthy()

    // Settle via SSH (teller approves the deposit)
    const ticketId = `MINT-${quoteId}`
    const result = settleViaSSH(ticketId, "E2E Playwright deposit")
    console.log("  teller settle:", result)
    expect(result.status).toBe("paid")

    // Wait for the wallet to auto-claim (polls every 3s)
    await expect(page.locator("button:has-text('✓ Deposited')")).toBeVisible({ timeout: 30000 })

    // Verify balance increased
    const balanceAfter = await page.locator(".text-4xl").textContent()
    console.log("  balance after:", balanceAfter)
    expect(parseFloat(balanceAfter!.replace(/[^\d.]/g, ""))).toBeGreaterThan(
      parseFloat(balanceBefore!.replace(/[^\d.]/g, "")),
    )
  })

  test("withdraw: create melt → teller approves → shows PAID", async ({ page }) => {
    await page.goto(WALLET_URL)

    // Fill withdraw form
    await page.fill("#wd-recipient", "44000001")
    await page.fill("#wd-amt", "1")
    await page.click("button:has-text('Send')")

    // Wait for the teller code
    await expect(page.locator(".font-mono.text-3xl")).toBeVisible({ timeout: 15000 })
    const tailCode = await page.locator(".font-mono.text-3xl").textContent()
    console.log("  withdraw teller code:", tailCode)

    // Get the melt quote ID from IndexedDB or from the page
    // For now, let's use the pecan API to find the pending melt
    // We need to SSH and list tickets
    const sshCmd = `ssh root@46.224.104.12 'python3 -c "
import json
d = json.load(open(\\"/opt/pecan-data/tickets.json\\"))
for id, t in d[\\"tickets\\"].items():
    if t[\\"kind\\"] == \\"outgoing\\" and t[\\"status\\"] == \\"pending\\":
        print(t[\\"id\\"])
        break
"'`
    const ticketId = execSync(sshCmd, { encoding: "utf8" }).trim()
    console.log("  melt ticket:", ticketId)
    expect(ticketId).toBeTruthy()

    // Settle via SSH (teller confirms payout)
    const result = settleViaSSH(ticketId, "E2E Playwright payout")
    console.log("  teller settle:", result)

    // Wait for PAID to appear (or done state)
    // The wallet shows "✓ Paid — <preimage>" when done
    await expect(page.locator("button:has-text('✓ Paid')")).toBeVisible({ timeout: 60000 })
  })

  test("history shows transactions", async ({ page }) => {
    await page.goto(WALLET_URL)
    await page.waitForTimeout(2000)

    // Should have at least one deposit and one withdraw in history
    const historyItems = await page.locator(".flex.items-center.justify-between").all()
    expect(historyItems.length).toBeGreaterThanOrEqual(2)
  })
})
