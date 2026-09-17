import { chromium } from "@playwright/test"
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto("https://giftcard.cashu.exchange/wallet")
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2_500)
  const bal = await page.locator(".text-4xl").first().textContent().catch(() => null)
  if (bal && /\d/.test(bal)) { console.log("BOOTED", JSON.stringify(bal), "viewport1280"); break }
  if (i === 7) {
    console.log("NEVER at viewport1280; body:", ((await page.locator("main").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 200))
    // Check IndexedDB open + coco init progress at 420px
    const diag = await page.evaluate(async () => {
      const out = {}
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open("giftcard-coco-wallet")
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
          setTimeout(() => reject(new Error("idb-open-timeout")), 3000)
        })
        out.idb = "open:" + db.objectStoreNames.length
      } catch (e) { out.idb = "ERR:" + String(e).slice(0, 80) }
      out.seed = (localStorage.getItem("giftcard-coco-seed-v1") ?? "").length
      return out
    })
    console.log("diag:", JSON.stringify(diag))
  }
}
await browser.close()
