# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: wallet.spec.ts >> Browser wallet E2E >> withdraw: create → teller match → settle → PAID
- Location: e2e/wallet.spec.ts:102:3

# Error details

```
Error: withdraw: no teller code and no pending outgoing ticket
```

# Test source

```ts
  39  |       const match = await matchResp.json()
  40  |       if (match.id) {
  41  |         const settleResp = await page.request.post(`/api/tickets/${match.id}/mark-paid`, {
  42  |           headers: { "Content-Type": "application/json" },
  43  |           data: { notes: "E2E payout" },
  44  |         })
  45  |         const result = await settleResp.json()
  46  |         return result.status === "paid"
  47  |       }
  48  |     }
  49  |   }
  50  |   return false
  51  | }
  52  | 
  53  | let sharedPage: Page | null = null
  54  | 
  55  | test.beforeAll(async ({ browser }) => {
  56  |   const context = await browser.newContext({ ignoreHTTPSErrors: true })
  57  |   sharedPage = await context.newPage()
  58  | })
  59  | 
  60  | test.afterAll(async () => {
  61  |   if (sharedPage) await sharedPage.close()
  62  | })
  63  | 
  64  | test.describe("Browser wallet E2E", () => {
  65  |   test.describe.configure({ mode: "serial" })
  66  | 
  67  |   test("wallet page loads", async () => {
  68  |     const page = sharedPage!
  69  |     await page.goto(WALLET)
  70  |     await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
  71  |     await expect(page.locator(".text-4xl")).toBeVisible()
  72  |   })
  73  | 
  74  |   test("deposit: create → teller match → settle → auto-claim", async () => {
  75  |     const page = sharedPage!
  76  |     await page.goto(WALLET)
  77  |     await apiLogin(page)
  78  | 
  79  |     const beforeText = await page.locator(".text-4xl").textContent()
  80  |     const before = parseFloat(beforeText?.replace(/[^\d.]/g, "") || "0")
  81  | 
  82  |     await page.getByPlaceholder("5.00").fill("5")
  83  |     await page.getByRole("button", { name: "Create deposit quote" }).click()
  84  | 
  85  |     await expect(page.locator(".font-mono.text-3xl")).toBeVisible({ timeout: 15_000 })
  86  |     const tellerCode = await page.locator(".font-mono.text-3xl").textContent()
  87  |     expect(tellerCode).toBeTruthy()
  88  |     expect(tellerCode!.trim().length).toBeGreaterThanOrEqual(6)
  89  |     console.log("  teller code:", tellerCode?.trim())
  90  | 
  91  |     const result = await matchAndSettle(page, tellerCode!.trim(), "deposit")
  92  |     expect(result.status).toBe("paid")
  93  | 
  94  |     await expect(page.getByRole("button", { name: /✓ Deposited/ })).toBeVisible({ timeout: 30_000 })
  95  | 
  96  |     const afterText = await page.locator(".text-4xl").textContent()
  97  |     const after = parseFloat(afterText?.replace(/[^\d.]/g, "") || "0")
  98  |     expect(after).toBeGreaterThan(before)
  99  |     console.log(`  balance: ${before.toFixed(2)} → ${after.toFixed(2)} kr`)
  100 |   })
  101 | 
  102 |   test("withdraw: create → teller match → settle → PAID", async () => {
  103 |     const page = sharedPage!
  104 |     await page.goto(WALLET)
  105 |     await apiLogin(page)
  106 | 
  107 |     const balanceText = await page.locator(".text-4xl").textContent()
  108 |     const balance = parseFloat(balanceText?.replace(/[^\d.]/g, "") || "0")
  109 |     expect(balance).toBeGreaterThan(0)
  110 |     console.log(`  balance: ${balance.toFixed(2)} kr`)
  111 | 
  112 |     await page.getByPlaceholder("Phone or reference").fill("e2e-recipient")
  113 |     await page.getByPlaceholder("1.00").fill("1")
  114 |     await page.getByRole("button", { name: "Send", exact: true }).click()
  115 | 
  116 |     // The mint's async settlement timeout is ~30s — the teller code appears after
  117 |     await page.waitForTimeout(35000)
  118 |     const content = await page.content()
  119 | 
  120 |     if (content.includes("Give this code to the teller")) {
  121 |       const tellerCode = await page.locator(".font-mono.text-3xl").textContent()
  122 |       console.log("  withdraw code:", tellerCode?.trim())
  123 | 
  124 |       const result = await matchAndSettle(page, tellerCode!.trim(), "payout")
  125 |       expect(result.status).toBe("paid")
  126 | 
  127 |       await expect(page.getByRole("button", { name: /✓ Paid/ })).toBeVisible({ timeout: 60_000 })
  128 |       console.log("  withdraw: PAID ✓")
  129 |     } else if (content.includes("Need exactly")) {
  130 |       console.log("  withdraw: exact subset not available — skipping")
  131 |       test.skip(true, "exact subset not available")
  132 |     } else {
  133 |       console.log("  withdraw: checking for pending outgoing ticket…")
  134 |       const settled = await trySettleOutgoing(page)
  135 |       if (settled) {
  136 |         await expect(page.getByRole("button", { name: /✓ Paid/ })).toBeVisible({ timeout: 60_000 })
  137 |         console.log("  withdraw: PAID ✓")
  138 |       } else {
> 139 |         throw new Error("withdraw: no teller code and no pending outgoing ticket")
      |               ^ Error: withdraw: no teller code and no pending outgoing ticket
  140 |       }
  141 |     }
  142 |   })
  143 | 
  144 |   test("history shows transactions", async () => {
  145 |     const page = sharedPage!
  146 |     await page.goto(WALLET)
  147 |     await page.waitForTimeout(3000)
  148 |     const items = await page.locator(".flex.items-center.justify-between.py-1").all()
  149 |     expect(items.length).toBeGreaterThanOrEqual(1)
  150 |   })
  151 | })
  152 | 
```