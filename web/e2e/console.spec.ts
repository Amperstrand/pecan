import { test, expect } from "@playwright/test"

// Console-boot contract for the multi-pair deployment: one bundle serves
// every pair, mounted by the edge proxy under /{currency}-console/* with the
// prefix stripped upstream — so the SPA must derive its API/event/router
// base from the URL at load time. These tests pin the regression where
// root-relative /api calls escaped the prefix and landed on the static site
// (blank console, "must_change_password" TypeError) on every pair.

const PAIRS = [
  { id: "eur", consoleBase: "/eur-console", password: process.env.PECAN_ADMIN_PASSWORD },
  { id: "usd", consoleBase: "/usd-console", password: process.env.PECAN_USD_ADMIN_PASSWORD },
  { id: "nok", consoleBase: "/nok-console", password: process.env.PECAN_NOK_ADMIN_PASSWORD },
] as const

const PAIRS_WITH_PASSWORD = PAIRS.filter(
  (pair): pair is typeof PAIRS[number] & { password: string } => Boolean(pair.password),
)

for (const pair of PAIRS) {
  test.describe(`${pair.id} console @smoke`, () => {
    test("boots to the login form under its pair prefix", async ({ page }) => {
      await page.goto(`${pair.consoleBase}/`)
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
      // Reload-safety: the router must keep the URL inside the prefix.
      expect(page.url()).toContain(`${pair.consoleBase}/login`)
    })
  })
}

for (const pair of PAIRS_WITH_PASSWORD) {
  test.describe(`${pair.id} console (admin) @smoke`, () => {
    test("sign-in → dashboard → teller, session survives reload", async ({ page }) => {
      await page.goto(`${pair.consoleBase}/login`)
      await page.getByRole("textbox", { name: "Username" }).fill("admin")
      await page.getByRole("textbox", { name: "Password" }).fill(pair.password)
      await page.getByRole("button", { name: "Sign in" }).click()

      // The dashboard only renders once /api/app succeeds through the
      // prefixed base; "Open quotes" is on its overview for every role.
      await expect(page.getByText("Open quotes").first()).toBeVisible()
      // Admin-only tabs (tellers never see Mint/Access).
      await expect(page.getByRole("tab", { name: "Mint" })).toBeVisible()

      // The teller surface — where wallet-created deposits get approved —
      // must render at the prefixed route (SPA fallback serves it).
      await page.goto(`${pair.consoleBase}/teller`)
      await expect(page.getByText("Match a quote").first()).toBeVisible()
      // Camera scanning of the wallet's teller-code QR (phone → webcam).
      await expect(page.getByRole("button", { name: "Scan with camera" })).toBeVisible()
      // A demo visitor hitting F5 there must stay signed in, not fall out
      // of the prefix onto the static site.
      await page.reload()
      await expect(page.getByText("Match a quote").first()).toBeVisible()
    })
  })
}

// The charger fleet card rides the NOK pair's Mint tab (the demo pair —
// fleet env is wired in its compose; pairs without the env hide the card).
const NOK = PAIRS.find((pair) => pair.id === "nok")
if (NOK?.password) {
  test.describe("nok console (fleet) @smoke", () => {
    test("Mint tab shows the charger fleet with its devices", async ({ page }) => {
      await page.goto(`${NOK.consoleBase}/login`)
      await page.getByRole("textbox", { name: "Username" }).fill("admin")
      await page.getByRole("textbox", { name: "Password" }).fill(NOK.password)
      await page.getByRole("button", { name: "Sign in" }).click()
      await page.getByRole("tab", { name: "Mint" }).click()
      await expect(page.getByText("Charger fleet", { exact: true })).toBeVisible()
      await expect(page.getByText("atomD", { exact: true })).toBeVisible()
    })
  })
}

// The pairs share one origin, so session cookies carry the unit in their
// name (branch_session_nok…) — with a shared name, the second sign-in
// evicted the first (last cookie wins). Both pages share one context here.
test.skip(
  PAIRS_WITH_PASSWORD.length < 2,
  "needs admin passwords for at least two pairs",
)
test("signing into a second pair's console keeps the first signed in @smoke", async ({
  page,
}) => {
  const [first, second] = PAIRS_WITH_PASSWORD
  async function signIn(pair: (typeof PAIRS_WITH_PASSWORD)[number], target: typeof page) {
    await target.goto(`${pair.consoleBase}/login`)
    await target.getByRole("textbox", { name: "Username" }).fill("admin")
    await target.getByRole("textbox", { name: "Password" }).fill(pair.password)
    await target.getByRole("button", { name: "Sign in" }).click()
    await expect(target.getByText("Open quotes").first()).toBeVisible()
  }

  await signIn(first, page)
  const secondPage = await page.context().newPage()
  await signIn(second, secondPage)

  await page.reload()
  await expect(page.getByText("Open quotes").first()).toBeVisible()
  await secondPage.close()
})
