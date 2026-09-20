import { test } from "@playwright/test"
import { chromium } from "@playwright/test"
import fs from "node:fs"
import { payInvoice, PROFILE_A, WALLET, WARM_MARKER } from "./portal-film-lib"

// Off-camera token supplier: buys two of today's eggs on the warm A
// profile and writes the bearer token to /tmp/portal-token.txt. The
// transfer leg is the wallet's slowest wedge — run this wherever it is
// fastest (the builder), then film anywhere; the token is a string.
// Env gate: PECAN_SUPPLY=1 (run via scripts/portal-movie.sh supply).

test.skip(!process.env.PECAN_SUPPLY, "supplier run only")

test("supply a two-egg bearer token", async () => {
  test.setTimeout(3_600_000)
  if (!fs.existsSync(WARM_MARKER)) throw new Error("run portal-warm first")
  const overview = (await (await fetch("https://giftcard.cashu.exchange/farm-console/api/farm")).json()) as {
    series: Array<{ date: string; unit: string }>
  }
  const today = new Date().toISOString().slice(0, 10)
  const series = overview.series.find((s) => s.date === today)
  if (!series) throw new Error("no series for today")

  for (let cycle = 0; cycle < 4; cycle++) {
    const ctx = await chromium.launchPersistentContext(PROFILE_A, { headless: true })
    const page = await ctx.newPage()
    try {
      await page.goto(WALLET, { waitUntil: "domcontentloaded" })
      await page.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
      const held = /\b2 egg claims\b/.test(
        (await page.locator("main").textContent().catch(() => "")) ?? "",
      )
      if (!held) {
        await page.getByLabel("production day").waitFor({ timeout: 60_000 })
        await page.getByLabel("egg quantity").fill("2")
        await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
        await page.getByTestId("farm-invoice").waitFor({ timeout: 60_000 })
        const inv = await page.getByTestId("farm-invoice").inputValue()
        if (!(await payInvoice(inv))) throw new Error("supplier payment failed")
      }
      for (let i = 0; i < 180; i++) {
        if (/\b2 egg claims\b/.test((await page.locator("main").textContent().catch(() => "")) ?? "")) break
        await page.waitForTimeout(5_000)
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
        await page.getByRole("button", { name: /Transfer ownership/i }).click({ timeout: 120_000 })
        try {
          await page.getByTestId("farm-token").waitFor({ timeout: 90_000 })
          const token = await page.getByTestId("farm-token").inputValue()
          fs.writeFileSync("/tmp/portal-token.txt", token)
          console.error("SUPPLY token written")
          await ctx.close()
          return
        } catch {
          await page.reload()
          await page.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
          await page.waitForTimeout(15_000)
        }
      }
      throw new Error("transfer never produced a token")
    } catch (e) {
      await ctx.close().catch(() => undefined)
      console.error(`SUPPLY cycle ${cycle} failed: ${e}`)
      if (cycle === 3) throw e
    }
  }
})
