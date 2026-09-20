import { execSync } from "node:child_process"
import fs from "node:fs"
import { chromium, type Page } from "@playwright/test"

export const PROFILE_A = "/tmp/portal-film-a"
export const PROFILE_B = "/tmp/portal-film-b"
export const PROFILE_C = "/tmp/portal-film-c"
export const WARM_MARKER = "/tmp/portal-film-warmed.json"
export const ORIGIN = "https://giftcard.cashu.exchange"
export const WALLET = `${ORIGIN}/wallet`
export const PORTAL = `${ORIGIN}/redeem`

function mark(m: string) {
  console.error(`WARM ${m}`)
}

export async function payInvoice(invoice: string): Promise<boolean> {
  try {
    execSync(
      `ssh -o BatchMode=yes root@46.224.104.12 "docker exec cln-swap-signet lightning-cli --network=signet pay ${invoice}"`,
      { timeout: 75_000, stdio: ["ignore", "pipe", "pipe"] },
    )
    return true
  } catch {
    return false
  }
}

/** The warm-up IS a full vending-machine cycle, off camera: A buys and
 * transfers two eggs to B; B's portal imports and virtually redeems
 * them. A wallet that has completed one op of every kind is fast at
 * the second — the first-ever mint op is what crawls for ~13 minutes
 * (the background watcher's cold path). Both devices end at zero. */
export async function warmProfiles(seriesUnit: string) {
  // -- A: boot, buy 2, mint, transfer out --
  const ctxA = await chromium.launchPersistentContext(PROFILE_A, { headless: true })
  const a = await ctxA.newPage()
  await a.goto(WALLET, { waitUntil: "domcontentloaded" })
  await a.getByRole("tab", { name: "FARM" }).click({ timeout: 240_000 })
  await a.getByLabel("production day").waitFor({ timeout: 240_000 })
  await a.getByLabel("egg quantity").fill("2")
  await a.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  await a.getByTestId("farm-invoice").waitFor({ timeout: 30_000 })
  const warmInvoice = await a.getByTestId("farm-invoice").inputValue()
  if (!(await payInvoice(warmInvoice))) throw new Error("warm-up payment failed")
  const warmDeadline = Date.now() + 900_000
  while (Date.now() < warmDeadline) {
    if (/\b2 egg claims\b/.test((await a.locator("main").textContent().catch(() => "")) ?? "")) break
    await a.waitForTimeout(5_000)
  }
  let warmToken = ""
  for (let attempt = 0; attempt < 4 && !warmToken; attempt++) {
    if (attempt) {
      await a.reload()
      await a.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
      await a.waitForTimeout(15_000)
    }
    await a.getByLabel(`send quantity for ${seriesUnit}`).fill("2")
    await a.getByRole("button", { name: /Transfer ownership/i }).click({ timeout: 120_000 })
    try {
      await a.getByTestId("farm-token").waitFor({ timeout: 90_000 })
      warmToken = await a.getByTestId("farm-token").inputValue()
    } catch {
      /* first-ever transfer can lag — retry */
    }
  }
  if (!warmToken) throw new Error("warm-up transfer never produced a token")
  await ctxA.close()
  mark("A done")

  // -- B: seed via the wallet page, then portal-import + virtual redeem --
  const ctxB = await chromium.launchPersistentContext(PROFILE_B, { headless: true })
  const b = await ctxB.newPage()
  await b.goto(WALLET, { waitUntil: "domcontentloaded" })
  await b.getByRole("tab", { name: "FARM" }).click({ timeout: 240_000 })
  await b.goto(PORTAL, { waitUntil: "domcontentloaded" })
  await b.getByTestId("kiosk-token-input").fill(warmToken)
  await b.getByRole("button", { name: /Validate code/i }).click()
  await b.getByRole("heading", { name: /2 eggs/ }).waitFor({ timeout: 600_000 })
  await b.getByTestId("kiosk-redeem-virtual").click()
  await b.getByText(/^FARM-VIRTUAL-/).first().waitFor({ timeout: 300_000 })
  await ctxB.close()
  mark("B done")

  // -- C: the off-camera supplier's wallet — buy + transfer once, so its
  // filmed runs are fast. The throwaway token is never received (the
  // proofs die with it — signet demo).
  // C's first cycle can crash the renderer (the known post-mint
  // vector) — the profile's storage survives, so relaunch and resume.
  for (let cycle = 0; cycle < 4; cycle++) {
    const ctxC = await chromium.launchPersistentContext(PROFILE_C, { headless: true })
    const c = await ctxC.newPage()
    try {
      await c.goto(WALLET, { waitUntil: "domcontentloaded" })
      await c.getByRole("tab", { name: "FARM" }).click({ timeout: 240_000 })
      await c.getByLabel("production day").waitFor({ timeout: 240_000 })
      const held = /\b2 egg claims\b/.test(
        (await c.locator("main").textContent().catch(() => "")) ?? "",
      )
      if (!held) {
        await c.getByLabel("egg quantity").fill("2")
        await c.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
        await c.getByTestId("farm-invoice").waitFor({ timeout: 30_000 })
        const invC = await c.getByTestId("farm-invoice").inputValue()
        if (!(await payInvoice(invC))) throw new Error("warm C payment failed")
      }
      for (let i = 0; i < 180; i++) {
        if (/\b2 egg claims\b/.test((await c.locator("main").textContent().catch(() => "")) ?? "")) break
        await c.waitForTimeout(5_000)
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        await c.getByLabel(`send quantity for ${seriesUnit}`).fill("2")
        await c.getByRole("button", { name: /Transfer ownership/i }).click({ timeout: 120_000 })
        try {
          await c.getByTestId("farm-token").waitFor({ timeout: 90_000 })
          attempt = 99
          break
        } catch {
          await c.reload()
          await c.getByRole("tab", { name: "FARM" }).click({ timeout: 120_000 })
          await c.waitForTimeout(15_000)
        }
      }
      await ctxC.close()
      mark("C done")
      break
    } catch {
      await ctxC.close().catch(() => undefined)
      mark("C crashed — relaunching")
    }
  }
}


export async function ensureWarm(seriesUnit: string) {
  if (fs.existsSync(WARM_MARKER) && fs.existsSync(PROFILE_A) && fs.existsSync(PROFILE_B)) {
    mark("already warm — skipping")
    return
  }
  await warmProfiles(seriesUnit)
  fs.writeFileSync(WARM_MARKER, JSON.stringify({ at: new Date().toISOString() }))
}
