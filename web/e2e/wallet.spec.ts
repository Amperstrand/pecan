import { test, expect, type Page } from "@playwright/test"
import {
  apiLogin,
  expectNoWalletErrors,
  matchAndSettle,
  payLightningInvoice,
  readBalance,
  readTellerCode,
  readWalletDb,
  sendOnchainFromExternal,
  trackWalletErrors,
  waitForDepositFormReset,
  waitForOpState,
} from "./helpers/wallet"

const WALLET = "/console/wallet"
const DEPOSIT_AMOUNT = 5

async function waitForBalance(page: Page, expected: number, timeout = 45_000) {
  await expect
    .poll(async () => readBalance(page), { timeout })
    .toBeCloseTo(expected, 2)
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

test.describe("EUR wallet E2E (teller + lightning + on-chain)", () => {
  test.describe.configure({ mode: "serial" })

  test("fresh wallet loads (new browser context = fresh IndexedDB)", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
    await readBalance(page)
  })

  test("teller deposit: quote → teller settle → auto-claim", async () => {
    const page = sharedPage!
    await apiLogin(page)

    const before = await readBalance(page)
    await page.getByPlaceholder("5.00").fill(String(DEPOSIT_AMOUNT))
    await page.getByRole("button", { name: "Create deposit quote" }).click()

    const code = await readTellerCode(page)
    const ticket = await matchAndSettle(page, code, "E2E teller deposit")
    expect(ticket.status).toBe("paid")
    expect(ticket.kind).toBe("incoming")
    expect(ticket.amount).toBe(DEPOSIT_AMOUNT * 100)

    await waitForBalance(page, before + DEPOSIT_AMOUNT)
    await waitForDepositFormReset(page)
    expectNoWalletErrors(walletErrors)

    await waitForOpState(page, "mint", code, "finalized")
    const db = await readWalletDb(page)
    expect(db.spendableSum).toBeGreaterThanOrEqual((before + DEPOSIT_AMOUNT) * 100)
  })

  test("lightning deposit: invoice → paid by hub node → auto-claim", async () => {
    const page = sharedPage!
    const before = await readBalance(page)

    await page.getByRole("button", { name: "Lightning", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("1")
    await page.getByRole("button", { name: "Create lightning invoice" }).click()

    const invoiceBox = page.locator('p.font-mono:has-text("lntbs")')
    await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
    const invoice = (await invoiceBox.textContent())?.trim() ?? ""
    expect(invoice.startsWith("lntbs")).toBeTruthy()

    const preimage = payLightningInvoice(invoice)
    expect(preimage).toHaveLength(64)

    await waitForBalance(page, before + 1, 60_000)
    await waitForDepositFormReset(page, "Create lightning invoice")
    expectNoWalletErrors(walletErrors)
  })

  test("onchain deposit: external wallet → mempool → settled → receipt", async () => {
    // Signet blocks can take 5-30+ minutes; adapt timeout to current cadence
    const blocks = await sharedPage!.request.get(
      "https://mempool.space/signet/api/blocks",
    ).then((r) => r.json());
    const now = Math.floor(Date.now() / 1000);
    const intervals = blocks.slice(0, 3).map((b: { timestamp: number }, i: number) =>
      i === 0 ? now - b.timestamp : blocks[i - 1].timestamp - b.timestamp,
    );
    const avgInterval = intervals.reduce((a: number, b: number) => a + b, 0) / intervals.length;
    const timeout = Math.min(Math.ceil((avgInterval * 3) / 60) * 60_000, 1_800_000);
    test.setTimeout(timeout + 60_000);
    console.log(`  signet avg block interval: ${Math.round(avgInterval)}s → timeout ${Math.round(timeout / 1000)}s`);
    const page = sharedPage!
    const before = await readBalance(page)

    await page.getByRole("button", { name: "On-chain", exact: true }).click()
    await page.getByPlaceholder("5.00").fill("50")
    await page.getByRole("button", { name: "Create on-chain address" }).click()

    const addressBox = page.locator('p.font-mono:has-text("tb1")')
    await addressBox.waitFor({ state: "visible", timeout: 30_000 })
    const address = (await addressBox.textContent())?.trim() ?? ""
    expect(address.startsWith("tb1")).toBeTruthy()

    const sendCaption = await page
      .getByText(/Send \d+ sat \(signet\)/)
      .textContent()
    const expectedSat = Number(sendCaption?.match(/\d+/)?.[0] ?? 0)
    expect(expectedSat).toBeGreaterThan(1000)

    const txid = sendOnchainFromExternal(address, expectedSat)
    expect(txid).toHaveLength(64)

    // At 0 required confirmations the rail settles on mempool visibility and
    // the deposit card can go straight to claimed — the "detected in mempool"
    // toast only reliably exists while confirmations are actually required.
    const rail = await sharedPage!
      .request.get(`/api/onchain-status/${address}`)
      .then((r) => r.json())
    if (rail.required_confirmations >= 1) {
      await expect(
        page.getByText("Payment detected in mempool"),
      ).toBeVisible({ timeout: 30_000 })
    }

    await waitForBalance(page, before + 50, timeout)
    expectNoWalletErrors(walletErrors)
  })

  test("one-way mint: ln and btc melt quotes are refused", async () => {
    const page = sharedPage!

    const lnMelt = await page.request.post("/v1/melt/quote/ln", {
      headers: { "Content-Type": "application/json" },
      data: { unit: "eur", amount: 500, request: "lntbs1test", rail: "ln" },
    })
    expect(lnMelt.status()).toBeGreaterThanOrEqual(400)

    const btcMelt = await page.request.post("/v1/melt/quote/btc", {
      headers: { "Content-Type": "application/json" },
      data: { unit: "eur", amount: 500, request: "tb1qtest", rail: "btc" },
    })
    expect(btcMelt.status()).toBeGreaterThanOrEqual(400)
  })

  test("withdraw: melt → teller payout → finalized, proofs released", async () => {
    const page = sharedPage!
    await apiLogin(page)

    const before = await readBalance(page)
    test.skip(before < DEPOSIT_AMOUNT, "insufficient balance for withdraw")

    await page.getByPlaceholder("Phone or reference").fill("e2e-recipient")
    await page.getByPlaceholder("1.00").fill(String(DEPOSIT_AMOUNT))
    await page.getByRole("button", { name: "Send", exact: true }).click()

    const code = await readTellerCode(page)
    const ticket = await matchAndSettle(page, code, "E2E payout")
    expect(ticket.status).toBe("paid")
    expect(ticket.kind).toBe("outgoing")

    await waitForBalance(page, before - DEPOSIT_AMOUNT, 60_000)
    expectNoWalletErrors(walletErrors)

    await waitForOpState(page, "melt", code, "finalized")
    const db = await readWalletDb(page)
    expect(db.spendableSum).toBeLessThan(before * 100)
  })

  test("withdraw survives reload (durable saga)", async () => {
    const page = sharedPage!
    await apiLogin(page)
    const start = await readBalance(page)

    await page.getByPlaceholder("5.00").fill(String(DEPOSIT_AMOUNT)).catch(() => {})
    // fund if needed
    if (start < DEPOSIT_AMOUNT * 2) {
      await page.getByPlaceholder("5.00").fill(String(DEPOSIT_AMOUNT))
      await page.getByRole("button", { name: "Create deposit quote" }).click()
      const depCode = await readTellerCode(page)
      await matchAndSettle(page, depCode, "E2E reload-saga funding")
      await waitForBalance(page, start + DEPOSIT_AMOUNT)
    }

    const before = await readBalance(page)
    await page.getByPlaceholder("Phone or reference").fill("e2e-reload")
    await page.getByPlaceholder("1.00").fill(String(DEPOSIT_AMOUNT))
    await page.getByRole("button", { name: "Send", exact: true }).click()
    const code = await readTellerCode(page)

    await page.reload()
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

    const ticket = await matchAndSettle(page, code, "E2E payout after reload")
    expect(ticket.status).toBe("paid")

    await waitForOpState(page, "melt", code, "finalized", 90_000)
    await waitForBalance(page, before - DEPOSIT_AMOUNT, 90_000)
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
