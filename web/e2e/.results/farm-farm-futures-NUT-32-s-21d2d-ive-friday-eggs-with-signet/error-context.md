# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:112:3

# Error details

```
Test timeout of 60000ms exceeded while running "beforeEach" hook.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('tab', { name: 'FARM' })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - main [ref=e3]:
    - generic [ref=e4]:
      - heading "Wallet" [level=1] [ref=e8]
      - tablist "Currency" [ref=e9]:
        - tab "EUR" [selected] [ref=e10]
        - tab "NOK" [ref=e11]
        - tab "USD" [ref=e12]
        - tab "SATS" [ref=e13]
    - generic [ref=e15]:
      - generic [ref=e16]: Balance
      - generic [ref=e17]: 0.00 €
    - generic [ref=e18]:
      - generic [ref=e19]:
        - generic [ref=e20]: Deposit
        - generic [ref=e23]: Mint ecash at the counter (teller) or over lightning.
      - generic [ref=e24]:
        - generic [ref=e25]:
          - button "Teller" [ref=e26]
          - button "Lightning" [ref=e27]
          - button "On-chain" [ref=e28]
        - generic [ref=e29]:
          - generic [ref=e30]: Amount (€)
          - spinbutton "Amount (€)" [ref=e31]
        - button "Create deposit quote" [disabled]
    - generic [ref=e32]:
      - generic [ref=e33]:
        - generic [ref=e34]: Withdraw
        - generic [ref=e37]: Send ecash to a recipient via the teller.
      - generic [ref=e38]:
        - tablist "Withdraw rail" [ref=e39]:
          - tab "Teller" [selected] [ref=e40]
          - tab "SEPA" [ref=e41]
          - tab "Instant" [ref=e42]
          - tab "Swish" [ref=e43]
          - tab "MobilePay" [ref=e44]
          - tab "iDEAL" [ref=e45]
          - tab "Bizum" [ref=e46]
          - tab "Sim" [ref=e47]
          - tab "Charger A" [ref=e48]
          - tab "Charger B" [ref=e49]
          - tab "Charger C" [ref=e50]
          - tab "Charger D" [ref=e51]
          - tab "Sim Charger" [ref=e52]
        - generic [ref=e53]:
          - generic [ref=e54]: Destination
          - textbox "Destination" [ref=e55]:
            - /placeholder: Phone or reference
        - generic [ref=e56]:
          - generic [ref=e57]: Amount (€)
          - spinbutton "Amount (€)" [ref=e58]
        - button "Send" [disabled]
    - generic [ref=e59]:
      - generic [ref=e60]:
        - generic [ref=e61]: Backup
        - generic [ref=e62]: Your money lives only in this browser. Download a fresh backup after every transaction — a backup goes stale the moment you spend.
      - generic [ref=e63]:
        - button "Download backup (JSON)" [ref=e64] [cursor=pointer]
        - button "Restore from backup…" [ref=e65] [cursor=pointer]
    - generic [ref=e66]:
      - generic [ref=e67]:
        - generic [ref=e68]: Developer Tools
        - generic [ref=e69]: Signet/test only. These actions are irreversible.
      - generic [ref=e70]:
        - button "Export wallet data (JSON)" [ref=e71] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e72] [cursor=pointer]
    - paragraph [ref=e73]:
      - text: Self-custodied — Coco 2 · keys stay in your browser.
      - link "Operator console" [ref=e74] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/
      - text: ·
      - link "Teller" [ref=e75] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/teller
  - region "Notifications alt+T"
```

# Test source

```ts
  1   | import { test, expect, type Page } from "@playwright/test"
  2   | import {
  3   |   apiLogin,
  4   |   matchAndSettle,
  5   |   payLightningInvoice,
  6   |   rebalanceSwapChannels,
  7   | } from "./helpers/wallet"
  8   | 
  9   | // Sarah's story (NUT-32 egg-futures spike): buy five next-Friday egg
  10  | // futures with 5000 real signet sats, receive 5 tagged bearer claims,
  11  | // send 2 to Bob, redeem at the farm counter — the whole physical-futures
  12  | // loop against the deployed farm pair.
  13  | 
  14  | const FARM_BASE = "/farm-console"
  15  | const FARM_ADMIN_PASSWORD = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""
  16  | 
  17  | interface FarmSeries {
  18  |   date: string
  19  |   unit: string
  20  |   maturity: number
  21  |   capacity: number
  22  |   issued: number
  23  |   redeemed: number
  24  |   available: number
  25  |   price_sats: number
  26  |   terms_uri: string
  27  |   terms_sha256: string
  28  |   matured: boolean
  29  | }
  30  | 
  31  | async function farmOverview(page: Page): Promise<{ series: FarmSeries[] }> {
  32  |   const r = await page.request.get(`${FARM_BASE}/api/farm`)
  33  |   expect(r.status()).toBe(200)
  34  |   return await r.json()
  35  | }
  36  | 
  37  | async function firstOpenSeries(page: Page): Promise<FarmSeries> {
  38  |   const overview = await farmOverview(page)
  39  |   const open = overview.series.filter((s) => !s.matured && s.available >= 5)
  40  |   const series = open[0]
  41  |   if (!series) {
  42  |     test.skip(
  43  |       true,
  44  |       "no series with 5+ free eggs (earlier runs consumed the horizon — raise FARM_HORIZON_DAYS or wait for the claim-window sweep)",
  45  |     )
  46  |   }
  47  |   return series
  48  | }
  49  | 
  50  | async function openFarmWallet(page: Page): Promise<void> {
  51  |   await page.goto("/wallet")
  52  |   await page
  53  |     .getByRole("tab", { name: "FARM" })
> 54  |     .click()
      |      ^ Error: locator.click: Test timeout of 60000ms exceeded.
  55  |   await expect(page.getByLabel("production day")).toBeVisible({ timeout: 30_000 })
  56  | }
  57  | 
  58  | /** Read the future-unit proof rows straight out of the wallet's IDB —
  59  |  * the independent "proofs really exist and carry the NUT-32 tag" check. */
  60  | async function readFutureProofs(page: Page): Promise<
  61  |   Array<{ unit: string; amount: number; secret: string; state: string }>
  62  | > {
  63  |   return page.evaluate(async () => {
  64  |     const db = await new Promise<IDBDatabase>((resolve, reject) => {
  65  |       const req = indexedDB.open("giftcard-coco-wallet")
  66  |       req.onsuccess = () => resolve(req.result)
  67  |       req.onerror = () => reject(req.error)
  68  |     })
  69  |     const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
  70  |       const tx = db.transaction("coco_cashu_proofs", "readonly")
  71  |       const req = tx.objectStore("coco_cashu_proofs").getAll()
  72  |       req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>)
  73  |       req.onerror = () => resolve([])
  74  |     })
  75  |     return rows
  76  |       .filter((r) => String(r.unit ?? "").startsWith("future:"))
  77  |       .map((r) => ({
  78  |         unit: String(r.unit),
  79  |         amount: Number(r.amount ?? (r.proof as { amount?: number })?.amount ?? 0),
  80  |         secret: String(r.secret ?? (r.proof as { secret?: string })?.secret ?? ""),
  81  |         state: String(r.state ?? ""),
  82  |       }))
  83  |   })
  84  | }
  85  | 
  86  | function futureTag(secret: string): { version: string; uri: string } | null {
  87  |   try {
  88  |     const parsed = JSON.parse(secret) as { tags?: string[][] }
  89  |     const futures = (parsed.tags ?? []).filter(
  90  |       (t) => Array.isArray(t) && t[0] === "future" && t.length === 3,
  91  |     )
  92  |     if (futures.length !== 1) return null
  93  |     return { version: futures[0][1], uri: futures[0][2] }
  94  |   } catch {
  95  |     return null
  96  |   }
  97  | }
  98  | 
  99  | test.describe("farm futures (NUT-32 spike)", () => {
  100 |   test.describe.configure({ mode: "serial" })
  101 | 
  102 |   test.beforeEach(async ({ page }) => {
  103 |     if (!FARM_ADMIN_PASSWORD && !process.env.PECAN_ADMIN_PASSWORD) {
  104 |       test.skip(true, "no farm admin password (fetch via scripts/e2e.sh)")
  105 |     }
  106 |     // Every Sarah run pays 5000 sat toward cln-swap; keep the payers'
  107 |     // side of the channels funded (best-effort rig maintenance).
  108 |     rebalanceSwapChannels(30_000)
  109 |     await openFarmWallet(page)
  110 |   })
  111 | 
  112 |   test("sarah_buys_five_friday_eggs_with_signet", async ({ page, browser }) => {
  113 |     test.setTimeout(420_000)
  114 |     const series = await firstOpenSeries(page)
  115 |     const price = series.price_sats
  116 |     expect(price).toBeGreaterThan(0)
  117 | 
  118 |     // Drive the production-day picker to the verified series — the
  119 |     // panel's default is merely the first open day.
  120 |     await page.getByLabel("production day").selectOption(series.date)
  121 | 
  122 |     // Unpaid quote reserves capacity: the overview shows 5 fewer free
  123 |     // eggs the moment the purchase exists.
  124 |     await page.getByLabel("egg quantity").fill("5")
  125 |     await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  126 |     const invoiceBox = page.getByTestId("farm-invoice")
  127 |     await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
  128 |     const invoice = (await invoiceBox.inputValue()) || (await invoiceBox.textContent()) || ""
  129 |     expect(invoice.startsWith("lntb")).toBeTruthy()
  130 | 
  131 |     await expect
  132 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.available ?? -1)
  133 |       .toBe(series.available - 5)
  134 | 
  135 |     // Real signet payment from an external lab node.
  136 |     const preimage = payLightningInvoice(invoice.trim())
  137 |     expect(preimage).toMatch(/^[0-9a-f]{64}$/)
  138 | 
  139 |     // Payment confirmed → the panel mints → owned. (The transient
  140 |     // "minting…" phase can complete while the external pay call is still
  141 |     // returning — assert the outcome, not the intermediate.)
  142 |     await expect(page.getByText("5 egg claims").first()).toBeVisible({ timeout: 90_000 })
  143 | 
  144 |     // Proofs really exist, carry the unit, the exactly-one future tag,
  145 |     // and the series' exact terms URI.
  146 |     const proofs = await readFutureProofs(page)
  147 |     const mine = proofs.filter((p) => p.unit === series.unit && p.state !== "spent")
  148 |     if (mine.reduce((sum, p) => sum + p.amount, 0) !== 5) {
  149 |       console.log(
  150 |         "FUTURE ROWS:",
  151 |         JSON.stringify(
  152 |           proofs.map((p) => ({ unit: p.unit, amount: p.amount, state: p.state, secretHead: p.secret.slice(0, 40) })),
  153 |         ),
  154 |       )
```