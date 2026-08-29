import { test, expect, type Page } from "@playwright/test"
import {
  apiLogin,
  expectNoWalletErrors,
  matchAndSettle,
  payLightningInvoice,
  readBalance,
  readTellerCode,
  readWalletDb,
  sendOnchainToAddress,
  trackWalletErrors,
  waitForDepositFormReset,
  waitForOpState,
} from "./helpers/wallet"

const WALLET = "/console/wallet"
const DEPOSIT_KR = 5

async function waitForBalance(page: Page, expectedKr: number, timeout = 45_000) {
  await expect
    .poll(async () => readBalance(page), { timeout })
    .toBeCloseTo(expectedKr, 2)
}

let sharedPage: Page | null = null
let walletErrors: string[] = []

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  sharedPage = await context.newPage()
  walletErrors = trackWalletErrors(sharedPage)
})

test.afterAll(async () => {
  expectNoWalletErrors(walletErrors)
  if (sharedPage) await sharedPage.close()
})

test.describe("Coco 2 browser wallet E2E (branch method, teller settlement)", () => {
  test.describe.configure({ mode: "serial" })

  test("wallet page loads with zero console errors", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
    await readBalance(page)
  })

  test("deposit: quote → teller settle → auto-claim to proofs", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await apiLogin(page)

    const before = await readBalance(page)

    await page.getByPlaceholder("5.00").fill(String(DEPOSIT_KR))
    await page.getByRole("button", { name: "Create deposit quote" }).click()

    const code = await readTellerCode(page)
    await expect(page.getByText("Polling for payment")).toBeVisible()

    const ticket = await matchAndSettle(page, code, "E2E deposit")
    expect(ticket.status).toBe("paid")
    expect(ticket.kind).toBe("incoming")
    expect(ticket.amount).toBe(DEPOSIT_KR * 100)

    await waitForBalance(page, before + DEPOSIT_KR)

    await waitForDepositFormReset(page)
    expectNoWalletErrors(walletErrors)

    await waitForOpState(page, "mint", code, "finalized")
    const db = await readWalletDb(page)
    expect(db.proofCount).toBeGreaterThan(0)
    expect(db.spendableSum).toBeGreaterThanOrEqual((before + DEPOSIT_KR) * 100)
  })

  test("lightning deposit: invoice → paid by signet node → auto-claim", async () => {
    const page = sharedPage!
    await page.goto(WALLET)

    const before = await readBalance(page)

    await page.getByRole("button", { name: "Lightning", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("1")
    await page.getByRole("button", { name: "Create lightning invoice" }).click()

    const invoiceBox = page.locator(
      'p.font-mono:has-text("lntbs")',
    )
    await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
    const invoice = (await invoiceBox.textContent())?.trim() ?? ""
    expect(invoice.startsWith("lntbs")).toBeTruthy()

    const preimage = payLightningInvoice(invoice)
    expect(preimage).toHaveLength(64)

    await waitForBalance(page, before + 1, 60_000)
    await waitForDepositFormReset(page, "Create lightning invoice")
    expectNoWalletErrors(walletErrors)

    const db = await readWalletDb(page)
    expect(db.spendableSum).toBeGreaterThanOrEqual((before + 1) * 100)
  })

  test("onchain deposit: address → signet tx from hub node → auto-claim", async () => {
    const page = sharedPage!
    await page.goto(WALLET)

    const before = await readBalance(page)

    await page.getByRole("button", { name: "On-chain", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("50")
    await page.getByRole("button", { name: "Create on-chain address" }).click()

    const addressBox = page.locator("p.font-mono:has-text(\"tb1\")")
    await addressBox.waitFor({ state: "visible", timeout: 30_000 })
    const address = (await addressBox.textContent())?.trim() ?? ""
    expect(address.startsWith("tb1")).toBeTruthy()

    const sendCaption = await page
      .getByText(/Send \d+ sat \(signet\)/)
      .textContent()
    const expectedSat = Number(sendCaption?.match(/\d+/)?.[0] ?? 0)
    expect(expectedSat).toBeGreaterThan(1000)

    const txid = sendOnchainToAddress(address, expectedSat)
    expect(txid).toHaveLength(64)

    // Zero-conf settlement config: the poller needs one listfunds sweep
    // (every 5s) to see the mempool output.
    await waitForBalance(page, before + 50, 120_000)
    await waitForDepositFormReset(page, "Create on-chain address")
    expectNoWalletErrors(walletErrors)
  })

  test("withdraw: melt → teller payout → finalized, proofs released", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await apiLogin(page)

    const before = await readBalance(page)
    test.skip(before < DEPOSIT_KR, "insufficient balance for withdraw test")

    await page.getByPlaceholder("Phone or reference").fill("e2e-recipient")
    await page.getByPlaceholder("1.00").fill(String(DEPOSIT_KR))
    await page.getByRole("button", { name: "Send", exact: true }).click()

    const code = await readTellerCode(page)
    await expect(page.getByText("Waiting for payout")).toBeVisible()

    const ticket = await matchAndSettle(page, code, "E2E payout")
    expect(ticket.status).toBe("paid")
    expect(ticket.kind).toBe("outgoing")
    expect(ticket.amount).toBe(DEPOSIT_KR * 100)

    await waitForBalance(page, before - DEPOSIT_KR, 60_000)
    expectNoWalletErrors(walletErrors)

    await waitForOpState(page, "melt", code, "finalized")
    const db = await readWalletDb(page)
    expect(db.spendableSum).toBeLessThan(before * 100)
  })

  test("withdraw survives reload while payout pending (durable saga)", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await apiLogin(page)

    const start = await readBalance(page)

    await page.getByPlaceholder("5.00").fill(String(DEPOSIT_KR))
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    const depositCode = await readTellerCode(page)
    await matchAndSettle(page, depositCode, "E2E reload-saga funding")
    await waitForBalance(page, start + DEPOSIT_KR)

    await page.getByPlaceholder("Phone or reference").fill("e2e-reload")
    await page.getByPlaceholder("1.00").fill(String(DEPOSIT_KR))
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const code = await readTellerCode(page)
    await expect(page.getByText("Waiting for payout")).toBeVisible()

    // Kill the page mid-saga: any poller/UI state is gone; only the durable
    // operation row + coco's boot-recovery watcher can finish the withdraw.
    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

    const ticket = await matchAndSettle(page, code, "E2E payout after reload")
    expect(ticket.status).toBe("paid")

    await waitForOpState(page, "melt", code, "finalized", 90_000)
    await waitForBalance(page, start, 90_000)
    expectNoWalletErrors(walletErrors)
  })

  test("self-custody state persists across reload", async () => {
    const page = sharedPage!
    const before = await readBalance(page)

    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

    const after = await readBalance(page)
    expect(after).toBe(before)

    const db = await readWalletDb(page)
    expect(db.spendableSum).toBe(before * 100)
    expectNoWalletErrors(walletErrors)
  })

  test("history shows finalized transactions without pending tags", async () => {
    const page = sharedPage!
    const history = page.locator("div.flex.items-center.justify-between.py-1")
    await expect(history.first()).toBeVisible()
    const rows = await history.allTextContents()
    expect(rows.some((r) => r.includes("Deposit") && !r.includes("pending"))).toBeTruthy()
    expect(rows.some((r) => r.includes("Withdraw"))).toBeTruthy()
    expectNoWalletErrors(walletErrors)
  })
})
