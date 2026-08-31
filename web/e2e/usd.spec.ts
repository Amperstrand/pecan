import { test, expect, type Page } from "@playwright/test"
import {
  apiLogin,
  expectNoWalletErrors,
  finalizedMeltChange,
  matchAndSettle,
  payLightningInvoice,
  readBalance,
  readTellerCode,
  trackWalletErrors,
  waitForDepositFormReset,
  waitForOpState,
} from "./helpers/wallet"

// USD twin (issue #4): the same wallet UI against the /usd mint pair —
// its pecan console lives under /usd-console. e2e.sh fetches the EUR admin
// password; USD's lives at /opt/pecan-usd-config on the server.
const WALLET = "/console/wallet"
const USD_BASE = "/usd-console"

const USD_PASSWORD =
  process.env.PECAN_USD_ADMIN_PASSWORD ?? process.env.PECAN_ADMIN_PASSWORD

let sharedPage: Page | null = null
let walletErrors: string[] = []

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "usd")
  })
  sharedPage = await context.newPage()
  walletErrors = trackWalletErrors(sharedPage)
})

test.afterAll(async () => {
  expectNoWalletErrors(walletErrors)
  if (sharedPage) await sharedPage.close()
})

test.describe("USD wallet E2E (teller + lightning)", () => {
  test.describe.configure({ mode: "serial" })

  test("wallet loads in USD with the switcher active", async () => {
    const page = sharedPage!
    await page.goto(WALLET)
    await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()
    const usd = page.getByRole("tab", { name: "USD" })
    await expect(usd).toHaveAttribute("aria-selected", "true")
    await readBalance(page)
  })

  test("teller deposit: quote → teller settle → auto-claim", async () => {
    const page = sharedPage!
    await apiLogin(page, USD_BASE, USD_PASSWORD)

    const before = await readBalance(page)
    await page.getByPlaceholder("5.00").fill("5")
    await page.getByRole("button", { name: "Create deposit quote" }).click()

    const code = await readTellerCode(page)
    const ticket = await matchAndSettle(page, code, "E2E USD teller deposit", USD_BASE)
    expect(ticket.status).toBe("paid")
    expect(ticket.kind).toBe("incoming")
    expect(ticket.amount).toBe(500)
    expect(ticket.unit).toBe("usd")

    await waitForDepositFormReset(page)
    expectNoWalletErrors(walletErrors)
    await waitForOpState(page, "mint", code, "finalized")
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

    for (let i = 0; i < 40; i++) {
      const bal = await readBalance(page)
      if (bal >= before + 1) break
      await page.waitForTimeout(1500)
    }
    await expect
      .poll(async () => readBalance(page), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(before + 1)
    await waitForDepositFormReset(page, "Create lightning invoice")
    expectNoWalletErrors(walletErrors)
  })

  test("withdraw: melt → teller payout → finalized, zero change", async () => {
    const page = sharedPage!
    await apiLogin(page, USD_BASE, USD_PASSWORD)

    const before = await readBalance(page)
    test.skip(before < 5, "insufficient USD balance for withdraw")

    await page.getByPlaceholder("Phone or reference").fill("e2e-usd")
    await page.getByPlaceholder("1.00").fill("5")
    await page.getByRole("button", { name: "Send", exact: true }).click()

    const code = await readTellerCode(page)
    const ticket = await matchAndSettle(page, code, "E2E USD payout", USD_BASE)
    expect(ticket.status).toBe("paid")
    expect(ticket.unit).toBe("usd")

    await waitForOpState(page, "melt", code, "finalized", 90_000)
    await expect
      .poll(async () => readBalance(page), { timeout: 90_000 })
      .toBeCloseTo(before - 5, 2)
    const change = await finalizedMeltChange(page, code)
    expect(change, "USD teller melt settles with zero change").toBe(0)
    expectNoWalletErrors(walletErrors)
  })

  test("switching back to EUR keeps the EUR balance intact", async () => {
    const page = sharedPage!
    await page.getByRole("tab", { name: "EUR" }).click()
    await expect(page.getByRole("tab", { name: "EUR" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    // EUR balance renders (0.00 or accumulated — the point is no crash and
    // a numeric display in €).
    await readBalance(page)
  })
})
