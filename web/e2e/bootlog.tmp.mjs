import { chromium } from "@playwright/test"
const browser = await chromium.launch()
const page = await browser.newPage()
page.on("request", (r) => { if (r.url().includes("farm")) console.log("[→]", r.method(), r.url().slice(0, 100)) })
page.on("response", (r) => { if (r.url().includes("farm")) console.log("[←]", r.status(), r.url().slice(0, 100)) })
page.on("requestfailed", (r) => { if (r.url().includes("farm")) console.log("[FAIL]", r.url().slice(0, 100)) })
page.on("console", (m) => {
  if (m.text().includes("[coco-boot]") || m.text().includes("addMint")) console.log(m.text().slice(0, 100))
})
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 250)))
await page.goto("https://giftcard.cashu.exchange/wallet")

const t0 = Date.now()
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5_000)
  const ok = await page.evaluate(() => !!window.__farmAdded)
  if (ok) { console.log('FARM ADD DONE at', Math.round((Date.now()-t0)/1000), 's'); break }
  if (i % 6 === 5) console.log('still waiting', (i+1)*5, 's')
}
console.log("done")
await browser.close()
