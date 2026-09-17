import { chromium } from "@playwright/test"
const browser = await chromium.launch()
const page = await browser.newPage()
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url())
  const proxy = (target) => route.fetch({ url: target }).then((r) => route.fulfill({ response: r })).catch(() => route.abort())
  if (url.port === "4174" && /^\/(eur|usd|nok|farm)(\/|$)/.test(url.pathname)) {
    return proxy("https://giftcard.cashu.exchange" + url.pathname + url.search)
  }
  if (url.hostname === "signut.cashu.exchange") {
    return proxy(url.toString())
  }
  if (url.port === "4174") {
    // local static + APIs otherwise — continue normally
  }
  await route.continue()
})
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 250)))
page.on("console", (m) => {
  if (m.type() === "error") console.log("[err]", m.text().slice(0, 200))
})
await page.goto("http://localhost:4174/wallet")
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2_500)
  const bal = await page.locator(".text-4xl").first().textContent().catch(() => null)
  if (bal && /\d/.test(bal)) { console.log("BOOTED (proxied)", JSON.stringify(bal)); break }
  if (i === 11) {
    console.log("NEVER (proxied)")
    const seed = await page.evaluate(() => (localStorage.getItem("giftcard-coco-seed-v1") ?? "").length)
    console.log("seed len:", seed)
  }
}
await browser.close()
