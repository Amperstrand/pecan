import { chromium } from "@playwright/test"
import { execSync } from "node:child_process"

const BASE = "https://giftcard.cashu.exchange"
const browser = await chromium.launch()
const page = await browser.newPage()
page.on("console", (m) => {
  const t = m.text()
  if (m.type() === "error" || m.type() === "warning" || t.includes("[farm]")) {
    console.log(`[${m.type()}]`, t.slice(0, 600))
  }
})
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 600)))
page.on("crash", () => console.log("[CRASH] renderer died"))
page.on("close", () => console.log("[CLOSE] page closed"))

await page.goto(BASE + "/wallet?debug=1")
await page.getByRole("tab", { name: "FARM" }).click()
await page.getByLabel("production day").waitFor({ timeout: 30_000 })

const seriesList = await page.evaluate(async () => {
  const r = await fetch("/farm-console/api/farm")
  return (await r.json()).series
})
const target = seriesList.find((s) => !s.matured && s.available >= 2 && s.date >= "2026-09-21")
console.log("series:", target.date, target.unit)

await page.getByLabel("production day").selectOption(target.date)
await page.getByLabel("egg quantity").fill("2")
await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
const box = page.locator("textarea.font-mono")
await box.waitFor({ state: "visible", timeout: 30_000 })
const invoice = await box.inputValue()

let paid = false
for (const node of ["cln-hub-signet", "cln-clboss-signet", "cln-nostr-signet"]) {
  try {
    execSync(
      `ssh -o BatchMode=yes root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`,
      { timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
    )
    paid = true
    console.log("paid via", node)
    break
  } catch {
    continue
  }
}
if (!paid) throw new Error("no payer could pay")

let owned = false
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2_000)
  const body = (await page.locator("main").textContent()) ?? ""
  if (/2 egg claims/.test(body)) {
    console.log("owned 2 claims ✓")
    owned = true
    break
  }
  if (/minting failed/.test(body)) throw new Error("mint failed: " + body.slice(0, 300))
}
if (!owned) throw new Error("never owned the claim")

await page.getByLabel(`send quantity for ${target.unit}`).fill("1")
console.log("clicking send…")
await page.getByRole("button", { name: /Send to Bob/i }).click()
console.log("send clicked, page url:", page.url())
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2_000)
  const token = await page.locator("textarea[readonly]").inputValue().catch(() => null)
  if (token && token.length > 50) {
    console.log("TOKEN OK len", token.length, token.slice(0, 60))
    await browser.close()
    process.exit(0)
  }
}
console.log(
  "no token — final body:",
  ((await page.locator("main").textContent()) ?? "").replace(/\s+/g, " ").slice(0, 400),
)
await browser.close()
