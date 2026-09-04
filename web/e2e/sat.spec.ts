import { test, expect, type Page } from "@playwright/test"
import {
  createLightningInvoice,
  expectNoWalletErrors,
  expectNoWalletWarnsSince,
  payLightningInvoice,
  readBalance,
  readWalletDb,
  readWalletLog,
  trackWalletErrors,
  waitForDepositFormReset,
} from "./helpers/wallet"

// SAT pair: the external signut mint (Nutshell-CF, bolt11+sat only) —
// no pecan rails, no console, native Cashu flows. This spec pins the
// full loop: bolt11 deposit (mint pays in on invoice payment) and
// bolt11 melt withdraw (mint pays the invoice). Amounts are whole sats.
const DEPOSIT_SAT = 21
const WITHDRAW_SAT = 5

test.describe("SAT wallet E2E (external signut mint, bolt11 only)", () => {
  test.describe.configure({ mode: "serial" })

  let sharedPage: Page | null = null
  let walletErrors: string[] = []
  let warnCursorT = 0

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    await context.addInitScript(() => {
      window.localStorage.setItem("pecan-debug", "1")
      window.localStorage.setItem("pecan-currency", "sat")
    })
    sharedPage = await context.newPage()
    walletErrors = trackWalletErrors(sharedPage)
    await sharedPage.goto("/wallet")
    await sharedPage
      .getByRole("heading", { name: "Wallet" })
      .waitFor({ state: "visible", timeout: 30_000 })
  })

  test.afterEach(async ({}, testInfo) => {
    if (!sharedPage) return
    const failed = testInfo.status !== testInfo.expectedStatus
    let warnError: Error | null = null
    if (!failed) {
      try {
        await expectNoWalletWarnsSince(sharedPage, warnCursorT)
      } catch (e) {
        warnError = e as Error
      }
    }
    if (failed || warnError) {
      const log = await readWalletLog(sharedPage).catch(() => [])
      await testInfo.attach("wallet-log", {
        body: JSON.stringify(log, null, 2),
        contentType: "application/json",
      })
      if (warnError) throw warnError
    }
    const entries = await readWalletLog(sharedPage).catch(() => [])
    if (entries.length > 0) {
      warnCursorT = Math.max(warnCursorT, entries[entries.length - 1].t)
    }
  })

  test.afterAll(async () => {
    expectNoWalletErrors(walletErrors)
    if (sharedPage) await sharedPage.close()
  })

  test("boots in sat mode: SATS tab, no console links, no rail tabs", async () => {
    const page = sharedPage!
    await expect(
      page.getByRole("tab", { name: "SATS" }),
    ).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("tab", { name: "EUR" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "USD" })).toBeVisible()

    // Rail-less currency: no pecan console behind it.
    await expect(
      page.getByRole("link", { name: "Operator console" }),
    ).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Teller" })).toHaveCount(0)

    // The deposit form has no Teller/On-chain tabs — just the invoice flow.
    await expect(page.getByRole("tab", { name: "Teller" })).toHaveCount(0)
    await expect(page.getByRole("tab", { name: "On-chain" })).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Create lightning invoice" }),
    ).toBeVisible()

    await readBalance(page)
  })

  test("bolt11 deposit: invoice → paid by hub node → balance credited", async () => {
    const page = sharedPage!
    test.setTimeout(120_000)

    const before = await readBalance(page)
    await page.getByPlaceholder("21").fill(String(DEPOSIT_SAT))
    await page.getByRole("button", { name: "Create lightning invoice" }).click()

    const invoiceBox = page.locator('p.font-mono:has-text("lntbs")')
    await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
    const invoice = (await invoiceBox.textContent())?.trim() ?? ""
    expect(invoice.startsWith("lntbs")).toBeTruthy()

    const preimage = payLightningInvoice(invoice)
    expect(preimage).toHaveLength(64)

    await expect
      .poll(async () => readBalance(page), { timeout: 60_000 })
      .toBe(before + DEPOSIT_SAT)
    await waitForDepositFormReset(page, "Create lightning invoice")
    expectNoWalletErrors(walletErrors)
  })

  test("bolt11 withdraw: melt to a lab invoice → preimage receipt, exact balance", async () => {
    const page = sharedPage!
    test.setTimeout(120_000)

    const before = await readBalance(page)
    test.skip(before < WITHDRAW_SAT, "insufficient sat balance for withdraw")

    const invoice = createLightningInvoice(
      WITHDRAW_SAT,
      `melt-${Date.now()}`,
    )
    await page.getByLabel("Lightning invoice").fill(invoice)
    await page.getByRole("button", { name: "Send", exact: true }).click()

    // Pending lightning card → done receipt (the preimage proves the
    // mint actually paid the invoice; only the payee can produce it).
    await expect(page.getByText("Paying lightning invoice")).toBeVisible()
    const receipt = page.locator("p.break-all.font-mono.text-sm")
    await receipt.waitFor({ state: "visible", timeout: 60_000 })
    await expect(receipt).toHaveText(/^[0-9a-f]{64}$/)

    // The melt's fee reserve rides with the payment — the exact-balance
    // check must subtract the finalized op's effective fee.
    await expect
      .poll(
        async () =>
          (await readWalletDb(page)).meltOps.some((o) => o.state === "finalized"),
        { timeout: 30_000 },
      )
      .toBe(true)
    const db = await readWalletDb(page)
    const meltFee = db.meltOps
      .filter((o) => o.state === "finalized")
      .reduce((sum, o) => sum + parseFloat(o.fee ?? "0"), 0)

    await expect
      .poll(async () => readBalance(page), { timeout: 60_000 })
      .toBe(before - WITHDRAW_SAT - meltFee)
    expectNoWalletErrors(walletErrors)
  })

  test("switch isolation: EUR view leaves the sat wallet intact", async () => {
    const page = sharedPage!
    const satBalance = await readBalance(page)

    await page.getByRole("tab", { name: "EUR" }).click()
    await readBalance(page)
    // The fiat view has the teller rails; the sat pending state must not
    // leak into it.
    await expect(page.getByRole("link", { name: "Operator console" })).toBeVisible()

    await page.getByRole("tab", { name: "SATS" }).click()
    await expect
      .poll(async () => readBalance(page), { timeout: 30_000 })
      .toBe(satBalance)
  })
})
