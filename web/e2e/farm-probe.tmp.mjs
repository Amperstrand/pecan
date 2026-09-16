import { chromium } from "@playwright/test"
import { execSync } from "node:child_process"

const BASE = "https://giftcard.cashu.exchange"
const browser = await chromium.launch()
const page = await browser.newPage()
let purchaseId = null
page.on("response", async (r) => {
  if (r.url().includes("/api/farm/futures/quote") && r.request().method() === "POST" && r.ok()) {
    const j = await r.json().catch(() => null)
    purchaseId = j?.purchase_id ?? null
    console.log("[net] purchase created:", purchaseId)
  }
  if (r.url().includes("/v1/mint/quote/future")) {
    console.log("[net] mint quote:", r.status(), (await r.text().catch(() => "")).slice(0, 220))
  }
  if (r.url().includes("/v1/mint/future")) {
    console.log("[net] mint:", r.status(), (await r.text().catch(() => "")).slice(0, 260))
  }
})
page.on("console", (m) => {
  console.log(`[console.${m.type()}]`, m.text().slice(0, 400))
})
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)))

await page.goto(BASE + "/wallet?debug=1")
await page.getByRole("tab", { name: "FARM" }).click()
await page.getByText(/eggs produced/).waitFor({ timeout: 30_000 })

await page.getByLabel("egg quantity").fill("1")
await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
const box = page.locator("textarea.font-mono")
await box.waitFor({ state: "visible", timeout: 30_000 })
const invoice = await box.inputValue()
console.log("invoice:", invoice.slice(0, 44))

execSync(
  `ssh -o BatchMode=yes root@46.224.104.12 "docker exec cln-hub-signet lightning-cli --network=signet pay ${invoice}"`,
  { timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] },
)
console.log("paid. polling purchase + panel…")

for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(3_000)
  if (purchaseId) {
    const state = await page
      .evaluate(async (id) => {
        const r = await fetch(`/farm-console/api/farm/futures/purchase/${id}`)
        return r.ok ? ((await r.json()).state ?? "?") : "http-" + r.status
      }, purchaseId)
      .catch(() => "?")
    const errText = await page
      .locator("div.border-destructive")
      .textContent()
      .catch(() => "")
    console.log(`t+${(i + 1) * 3}s purchase=${state} err=${(errText ?? "").slice(0, 160)}`)
    if (state === "minted" || state === "failed" || state === "authorized") break
  }
}
const owned = (await page.locator("main").textContent())?.replace(/\s+/g, " ").slice(0, 320)
console.log("final body:", owned)
await browser.close()
