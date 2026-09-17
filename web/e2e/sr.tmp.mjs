import { chromium } from "@playwright/test"
import { execSync } from "node:child_process"
const BASE = "https://giftcard.cashu.exchange"
const browser = await chromium.launch()
const page = await browser.newPage()
page.on("console", (m) => {
  const t = m.text()
  if (m.type() === "error" || t.includes("coco-boot") || t.includes("[farm]")) console.log(`[${m.type()}]`, t.slice(0, 160))
})
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)))
await page.goto(BASE + "/wallet")
await page.getByRole("tab", { name: "FARM" }).click()
await page.getByLabel("production day").waitFor({ timeout: 60_000 })
const seriesList = await page.evaluate(async () => (await (await fetch("/farm-console/api/farm")).json()).series)
const target = seriesList.find((s) => !s.matured && s.available >= 2 && s.date >= "2026-09-20")
console.log("series:", target.date)
await page.getByLabel("production day").selectOption(target.date)
await page.getByLabel("egg quantity").fill("2")
await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
const box = page.getByTestId("farm-invoice")
await box.waitFor({ state: "visible", timeout: 30_000 })
const invoice = await box.inputValue()
let paid = false
for (const node of ["cln-hub-signet", "cln-clboss-signet", "cln-nostr-signet"]) {
  try {
    execSync(`ssh -o BatchMode=yes root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`, { timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] })
    paid = true; console.log("paid via", node); break
  } catch { continue }
}
if (!paid) throw new Error("no payer")
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(2_000)
  if (/2 egg claims/.test((await page.locator("main").textContent()) ?? "")) { console.log("SARAH OWNS 2 ✓"); break }
}
for (const wait of [0, 5, 15]) {
  if (wait) await page.waitForTimeout(wait * 1000)
  const rows = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("giftcard-coco-wallet")
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return await new Promise((resolve) => {
      const tx = db.transaction("coco_cashu_proofs", "readonly")
      const req = tx.objectStore("coco_cashu_proofs").getAll()
      req.onsuccess = () => resolve(req.result.length)
      req.onerror = () => resolve(-1)
    })
  }).catch(() => "eval-dead")
  console.log(`proof rows t+${wait}s:`, rows)
}
await page.getByLabel(`send quantity for ${target.unit}`).fill("1")
await page.getByRole("button", { name: /Send to Bob/i }).click()
let token = null
for (let i = 0; i < 20 && (!token || token.length < 50); i++) {
  token = await page
    .getByTestId("farm-token")
    .inputValue()
    .catch(() => null)
    .catch(() => null)
  if (!token || token.length < 50) {
    await page.waitForTimeout(2_000).catch(() => {})
  }
}
console.log("token:", token ? `len ${token.length}` : "MISSING")
const sarahAlive = async () => {
  try {
    await page.evaluate(() => 1)
    return true
  } catch {
    return false
  }
}
console.log("sarah page alive after send:", await sarahAlive())
// free the first browser before booting a second full wallet
await browser.close()
console.log("sarah browser closed")
const bobBrowser = await chromium.launch({ dumpIO: true })
const bp = await bobBrowser.newPage()
bp.on("pageerror", (e) => console.log("[bob pageerror]", String(e).slice(0, 300)))
bp.on("console", (m) => { const t = m.text(); if (m.type() === "error" || t.includes("[bob]")) console.log("[bob]", t.slice(0, 120)) })
await bp.goto(BASE + "/wallet")
await bp.getByRole("tab", { name: "FARM" }).click()
await bp.getByPlaceholder(/paste a token/i).waitFor({ timeout: 60_000 })

await bp.getByPlaceholder(/paste a token/i).fill(token)
await bp.getByRole("button", { name: /Receive token/i }).click()
for (let i = 0; i < 40; i++) {
  await bp.waitForTimeout(3_000)
  const body = (await bp.locator("main").textContent()) ?? ""
  if (/1 egg claims/.test(body)) { console.log("BOB OWNS 1 ✓"); process.exit(0) }
  const err = await bp.locator("div.border-destructive").textContent().catch(() => "")
  if (err && err.trim()) { console.log("BOB ERROR:", err.trim().slice(0, 300)); break }
}
console.log("bob failed")
process.exit(1)
