# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: wallet.spec.ts >> Coco 2 browser wallet E2E (branch method, teller settlement) >> onchain deposit: external wallet → mempool → 1-conf → receipt
- Location: e2e/wallet.spec.ts:107:3

# Error details

```
Error: expect(received).toBeCloseTo(expected, precision)

Expected: 56
Received: 6

Expected precision:    2
Expected difference: < 0.005
Received difference:   50

Call Log:
- Timeout 480000ms exceeded while waiting on the predicate
```

# Test source

```ts
  1   | import { test, expect, type Page } from "@playwright/test"
  2   | import {
  3   |   apiLogin,
  4   |   expectNoWalletErrors,
  5   |   matchAndSettle,
  6   |   payLightningInvoice,
  7   |   readBalance,
  8   |   readTellerCode,
  9   |   readWalletDb,
  10  |   sendOnchainFromExternal,
  11  |   sendOnchainToAddress,
  12  |   trackWalletErrors,
  13  |   waitForDepositFormReset,
  14  |   waitForOpState,
  15  | } from "./helpers/wallet"
  16  | 
  17  | const WALLET = "/console/wallet"
  18  | const DEPOSIT_KR = 5
  19  | 
  20  | async function waitForBalance(page: Page, expectedKr: number, timeout = 45_000) {
  21  |   await expect
  22  |     .poll(async () => readBalance(page), { timeout })
> 23  |     .toBeCloseTo(expectedKr, 2)
      |      ^ Error: expect(received).toBeCloseTo(expected, precision)
  24  | }
  25  | 
  26  | let sharedPage: Page | null = null
  27  | let walletErrors: string[] = []
  28  | 
  29  | test.beforeAll(async ({ browser }) => {
  30  |   const context = await browser.newContext({ ignoreHTTPSErrors: true })
  31  |   sharedPage = await context.newPage()
  32  |   walletErrors = trackWalletErrors(sharedPage)
  33  | })
  34  | 
  35  | test.afterAll(async () => {
  36  |   expectNoWalletErrors(walletErrors)
  37  |   if (sharedPage) await sharedPage.close()
  38  | })
  39  | 
  40  | test.describe("Coco 2 browser wallet E2E (branch method, teller settlement)", () => {
  41  |   test.describe.configure({ mode: "serial" })
  42  | 
  43  |   test("wallet page loads with zero console errors", async () => {
  44  |     const page = sharedPage!
  45  |     await page.goto(WALLET)
  46  |     await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
  47  |     await readBalance(page)
  48  |   })
  49  | 
  50  |   test("deposit: quote → teller settle → auto-claim to proofs", async () => {
  51  |     const page = sharedPage!
  52  |     await page.goto(WALLET)
  53  |     await apiLogin(page)
  54  | 
  55  |     const before = await readBalance(page)
  56  | 
  57  |     await page.getByPlaceholder("5.00").fill(String(DEPOSIT_KR))
  58  |     await page.getByRole("button", { name: "Create deposit quote" }).click()
  59  | 
  60  |     const code = await readTellerCode(page)
  61  |     await expect(page.getByText("Polling for payment")).toBeVisible()
  62  | 
  63  |     const ticket = await matchAndSettle(page, code, "E2E deposit")
  64  |     expect(ticket.status).toBe("paid")
  65  |     expect(ticket.kind).toBe("incoming")
  66  |     expect(ticket.amount).toBe(DEPOSIT_KR * 100)
  67  | 
  68  |     await waitForBalance(page, before + DEPOSIT_KR)
  69  | 
  70  |     await waitForDepositFormReset(page)
  71  |     expectNoWalletErrors(walletErrors)
  72  | 
  73  |     await waitForOpState(page, "mint", code, "finalized")
  74  |     const db = await readWalletDb(page)
  75  |     expect(db.proofCount).toBeGreaterThan(0)
  76  |     expect(db.spendableSum).toBeGreaterThanOrEqual((before + DEPOSIT_KR) * 100)
  77  |   })
  78  | 
  79  |   test("lightning deposit: invoice → paid by signet node → auto-claim", async () => {
  80  |     const page = sharedPage!
  81  |     await page.goto(WALLET)
  82  | 
  83  |     const before = await readBalance(page)
  84  | 
  85  |     await page.getByRole("button", { name: "Lightning", exact: true }).click()
  86  |     await page.getByPlaceholder("5.00").fill("1")
  87  |     await page.getByRole("button", { name: "Create lightning invoice" }).click()
  88  | 
  89  |     const invoiceBox = page.locator(
  90  |       'p.font-mono:has-text("lntbs")',
  91  |     )
  92  |     await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
  93  |     const invoice = (await invoiceBox.textContent())?.trim() ?? ""
  94  |     expect(invoice.startsWith("lntbs")).toBeTruthy()
  95  | 
  96  |     const preimage = payLightningInvoice(invoice)
  97  |     expect(preimage).toHaveLength(64)
  98  | 
  99  |     await waitForBalance(page, before + 1, 60_000)
  100 |     await waitForDepositFormReset(page, "Create lightning invoice")
  101 |     expectNoWalletErrors(walletErrors)
  102 | 
  103 |     const db = await readWalletDb(page)
  104 |     expect(db.spendableSum).toBeGreaterThanOrEqual((before + 1) * 100)
  105 |   })
  106 | 
  107 |   test("onchain deposit: external wallet → mempool → 1-conf → receipt", async () => {
  108 |     test.setTimeout(600_000)
  109 |     const page = sharedPage!
  110 |     await page.goto(WALLET)
  111 | 
  112 |     const before = await readBalance(page)
  113 | 
  114 |     await page.getByRole("button", { name: "On-chain", exact: true }).click()
  115 |     await page.getByPlaceholder("5.00").fill("50")
  116 |     await page.getByRole("button", { name: "Create on-chain address" }).click()
  117 | 
  118 |     const addressBox = page.locator('p.font-mono:has-text("tb1")')
  119 |     await addressBox.waitFor({ state: "visible", timeout: 30_000 })
  120 |     const address = (await addressBox.textContent())?.trim() ?? ""
  121 |     expect(address.startsWith("tb1")).toBeTruthy()
  122 | 
  123 |     const sendCaption = await page
```