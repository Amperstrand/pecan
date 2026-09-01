import { test, expect, type Page } from "@playwright/test"
import {
  apiLogin,
  expectNoWalletErrors,
  finalizedMeltChange,
  fundLockReleaseEntry,
  matchAndSettle,
  payLightningInvoice,
  readBalance,
  readTellerCode,
  readWalletDb,
  readWalletLog,
  trackWalletErrors,
  waitForDepositFormReset,
  waitForOpState,
  expectNoWalletWarnsSince,
} from "./wallet"

/**
 * The per-currency wallet suite: the deposit/withdraw flows every pair must
 * pass identically. Currency-specific extras (deep saga tests, switcher
 * checks) register through the callback inside the same serial describe so
 * they share the page and the gates.
 */
export interface CurrencySuiteConfig {
  /** Currency the wallet boots in (localStorage pecan-currency). */
  currency: string
  /** Pecan console path prefix for teller API calls, e.g. "/eur-console". */
  consoleBase: string
  /** That pair's admin password. */
  password: string
  /** Describe block label. */
  name: string
}

export interface SuiteContext {
  page: () => Page
  walletErrors: () => string[]
  consoleBase: string
  currency: string
}

export const DEPOSIT_AMOUNT = 5

export function defineWalletSuite(
  cfg: CurrencySuiteConfig,
  extraTests?: (ctx: SuiteContext) => void,
): void {
  const WALLET = "/eur-console/wallet"

  let sharedPage: Page | null = null
  let walletErrors: string[] = []
  // Warn-gate cursor: warns are attributed to the test that produced them
  // (timestamp-based so the ring buffer's 400-entry wrap cannot create a
  // false window).
  let warnCursorT = 0

  test.describe(cfg.name, () => {
    test.describe.configure({ mode: "serial" })

    test.beforeAll(async ({ browser }) => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true })
      await context.addInitScript((currency) => {
        window.localStorage.setItem("pecan-debug", "1")
        window.localStorage.setItem("pecan-currency", currency)
      }, cfg.currency)
      sharedPage = await context.newPage()
      walletErrors = trackWalletErrors(sharedPage)
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

    test("fresh wallet loads with the switcher active", async () => {
      const page = sharedPage!
      await page.goto(WALLET)
      await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
      await expect(
        page.getByRole("tab", { name: cfg.currency.toUpperCase() }),
      ).toHaveAttribute("aria-selected", "true")
      await readBalance(page)
    })

    test("teller deposit: quote → teller settle → auto-claim", async () => {
      const page = sharedPage!
      await apiLogin(page, cfg.consoleBase, cfg.password)

      const before = await readBalance(page)
      await page.getByPlaceholder("5.00").fill(String(DEPOSIT_AMOUNT))
      await page.getByRole("button", { name: "Create deposit quote" }).click()

      const code = await readTellerCode(page)
      const ticket = await matchAndSettle(
        page,
        code,
        `E2E ${cfg.currency} teller deposit`,
        cfg.consoleBase,
      )
      expect(ticket.status).toBe("paid")
      expect(ticket.kind).toBe("incoming")
      expect(ticket.amount).toBe(DEPOSIT_AMOUNT * 100)
      expect(ticket.unit).toBe(cfg.currency)

      await expect
        .poll(async () => readBalance(page), { timeout: 45_000 })
        .toBeCloseTo(before + DEPOSIT_AMOUNT, 2)
      await waitForDepositFormReset(page)
      expectNoWalletErrors(walletErrors)

      await waitForOpState(page, "mint", code, "finalized")
      const db = await readWalletDb(page)
      expect(db.spendableSum).toBeGreaterThanOrEqual(
        (before + DEPOSIT_AMOUNT) * 100,
      )
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

      // The card shows the invoice's remaining life (30 min TTL).
      await expect(page.getByText(/^Expires in \d+:\d{2}/)).toBeVisible()

      const preimage = payLightningInvoice(invoice)
      expect(preimage).toHaveLength(64)

      await expect
        .poll(async () => readBalance(page), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(before + 1)
      await waitForDepositFormReset(page, "Create lightning invoice")
      expectNoWalletErrors(walletErrors)
    })

    test("withdraw: melt → teller payout → finalized, zero change", async () => {
      const page = sharedPage!
      await apiLogin(page, cfg.consoleBase, cfg.password)

      const before = await readBalance(page)
      test.skip(before < DEPOSIT_AMOUNT, "insufficient balance for withdraw")

      await page.getByPlaceholder("Phone or reference").fill(`e2e-${cfg.currency}`)
      await page.getByPlaceholder("1.00").fill(String(DEPOSIT_AMOUNT))
      await page.getByRole("button", { name: "Send", exact: true }).click()

      const code = await readTellerCode(page)
      const ticket = await matchAndSettle(
        page,
        code,
        `E2E ${cfg.currency} payout`,
        cfg.consoleBase,
      )
      expect(ticket.status).toBe("paid")
      expect(ticket.unit).toBe(cfg.currency)

      await expect
        .poll(async () => readBalance(page), { timeout: 60_000 })
        .toBeCloseTo(before - DEPOSIT_AMOUNT, 2)

      await waitForOpState(page, "melt", code, "finalized")
      const lock = await fundLockReleaseEntry(page, code)
      expect(lock, "fund-lock entry for this withdraw").toBeDefined()
      expect(lock!.data?.state).toBe("pending")
      const change = await finalizedMeltChange(page, code)
      expect(
        change,
        `${cfg.currency} teller melts settle with zero change (exact-amount pre-swap)`,
      ).toBe(0)
      const db = await readWalletDb(page)
      expect(db.spendableSum).toBeLessThan(before * 100)
      expectNoWalletErrors(walletErrors)
    })

    extraTests?.({
      page: () => sharedPage!,
      walletErrors: () => walletErrors,
      consoleBase: cfg.consoleBase,
      currency: cfg.currency,
    })
  })
}
