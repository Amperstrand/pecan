# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:103:3

# Error details

```
TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('textarea.font-mono') to be visible

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - main [ref=e3]:
    - generic [ref=e4]:
      - heading "Wallet" [level=1] [ref=e8]
      - tablist "Currency" [ref=e9]:
        - tab "EUR" [ref=e10]
        - tab "NOK" [ref=e11]
        - tab "USD" [ref=e12]
        - tab "SATS" [ref=e13]
        - tab "FARM" [selected] [ref=e14]
    - generic [ref=e16]:
      - generic [ref=e17]: YOU OWN
      - generic [ref=e18]: 0 egg claims
    - generic [ref=e19]:
      - generic [ref=e20]:
        - generic [ref=e21]: FARM
        - generic [ref=e22]: Wednesday, Sep 16 · 10 eggs produced · 4 available · 1000 signet sats / egg
      - generic [ref=e23]:
        - generic [ref=e24]:
          - generic [ref=e25]:
            - generic [ref=e26]: Quantity
            - textbox "egg quantity" [ref=e27]: "5"
          - generic [ref=e28]:
            - generic [ref=e29]: 5 eggs
            - generic [ref=e30]: 5000 signet sats
            - generic [ref=e31]: "Production: Wednesday, Sep 16Available for pickup: Wed, 16 Sep 2026 16:00:00 UTC"
        - button "Buy for 5000 signet sats" [active] [ref=e32] [cursor=pointer]
        - button "verify terms" [ref=e34] [cursor=pointer]
        - group [ref=e35]:
          - generic "all series (7)" [ref=e36] [cursor=pointer]
        - generic [ref=e37]: quantity must be 1..4
    - generic [ref=e38]:
      - generic [ref=e39]:
        - generic [ref=e40]: Developer Tools
        - generic [ref=e41]: Signet/test only. These actions are irreversible.
      - generic [ref=e42]:
        - button "Export wallet data (JSON)" [ref=e43] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e44] [cursor=pointer]
    - paragraph [ref=e45]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
  14  | const FARM_ADMIN_PASSWORD = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""
  15  | 
  16  | interface FarmSeries {
  17  |   date: string
  18  |   unit: string
  19  |   maturity: number
  20  |   capacity: number
  21  |   issued: number
  22  |   redeemed: number
  23  |   available: number
  24  |   price_sats: number
  25  |   terms_uri: string
  26  |   terms_sha256: string
  27  |   matured: boolean
  28  | }
  29  | 
  30  | async function farmOverview(page: Page): Promise<{ series: FarmSeries[] }> {
  31  |   const r = await page.request.get(`${FARM_BASE}/api/farm`)
  32  |   expect(r.status()).toBe(200)
  33  |   return await r.json()
  34  | }
  35  | 
  36  | async function firstOpenSeries(page: Page): Promise<FarmSeries> {
  37  |   const overview = await farmOverview(page)
  38  |   const open = overview.series.filter((s) => !s.matured && s.available >= 5)
  39  |   const series = open[0]
  40  |   expect(series, "farm must expose a series with 5+ eggs free").toBeDefined()
  41  |   return series
  42  | }
  43  | 
  44  | async function openFarmWallet(page: Page): Promise<void> {
  45  |   await page.goto("/wallet")
  46  |   await page
  47  |     .getByRole("tab", { name: "FARM" })
  48  |     .click()
  49  |   await expect(page.getByText(/eggs produced/)).toBeVisible({ timeout: 30_000 })
  50  | }
  51  | 
  52  | /** Read the future-unit proof rows straight out of the wallet's IDB —
  53  |  * the independent "proofs really exist and carry the NUT-32 tag" check. */
  54  | async function readFutureProofs(page: Page): Promise<
  55  |   Array<{ unit: string; amount: number; secret: string; state: string }>
  56  | > {
  57  |   return page.evaluate(async () => {
  58  |     const db = await new Promise<IDBDatabase>((resolve, reject) => {
  59  |       const req = indexedDB.open("giftcard-coco-wallet")
  60  |       req.onsuccess = () => resolve(req.result)
  61  |       req.onerror = () => reject(req.error)
  62  |     })
  63  |     const rows = await new Promise<Array<Record<string, unknown>>>((resolve) => {
  64  |       const tx = db.transaction("coco_cashu_proofs", "readonly")
  65  |       const req = tx.objectStore("coco_cashu_proofs").getAll()
  66  |       req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>)
  67  |       req.onerror = () => resolve([])
  68  |     })
  69  |     return rows
  70  |       .filter((r) => String(r.unit ?? "").startsWith("future:"))
  71  |       .map((r) => ({
  72  |         unit: String(r.unit),
  73  |         amount: Number(r.amount ?? (r.proof as { amount?: number })?.amount ?? 0),
  74  |         secret: String(r.secret ?? (r.proof as { secret?: string })?.secret ?? ""),
  75  |         state: String(r.state ?? ""),
  76  |       }))
  77  |   })
  78  | }
  79  | 
  80  | function futureTag(secret: string): { version: string; uri: string } | null {
  81  |   try {
  82  |     const parsed = JSON.parse(secret) as { tags?: string[][] }
  83  |     const futures = (parsed.tags ?? []).filter(
  84  |       (t) => Array.isArray(t) && t[0] === "future" && t.length === 3,
  85  |     )
  86  |     if (futures.length !== 1) return null
  87  |     return { version: futures[0][1], uri: futures[0][2] }
  88  |   } catch {
  89  |     return null
  90  |   }
  91  | }
  92  | 
  93  | test.describe("farm futures (NUT-32 spike)", () => {
  94  |   test.describe.configure({ mode: "serial" })
  95  | 
  96  |   test.beforeEach(async ({ page }) => {
  97  |     if (!FARM_ADMIN_PASSWORD && !process.env.PECAN_ADMIN_PASSWORD) {
  98  |       test.skip(true, "no farm admin password (fetch via scripts/e2e.sh)")
  99  |     }
  100 |     await openFarmWallet(page)
  101 |   })
  102 | 
  103 |   test("sarah_buys_five_friday_eggs_with_signet", async ({ page, browser }) => {
  104 |     test.setTimeout(180_000)
  105 |     const series = await firstOpenSeries(page)
  106 |     const price = series.price_sats
  107 |     expect(price).toBeGreaterThan(0)
  108 | 
  109 |     // Unpaid quote reserves capacity: the overview shows 5 fewer free
  110 |     // eggs the moment the purchase exists.
  111 |     await page.getByLabel("egg quantity").fill("5")
  112 |     await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  113 |     const invoiceBox = page.locator("textarea.font-mono")
> 114 |     await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
      |                      ^ TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
  115 |     const invoice = (await invoiceBox.inputValue()) || (await invoiceBox.textContent()) || ""
  116 |     expect(invoice.startsWith("lntb")).toBeTruthy()
  117 | 
  118 |     await expect
  119 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.available ?? -1)
  120 |       .toBe(series.available - 5)
  121 | 
  122 |     // Real signet payment from an external lab node.
  123 |     const preimage = payLightningInvoice(invoice.trim())
  124 |     expect(preimage).toMatch(/^[0-9a-f]{64}$/)
  125 | 
  126 |     // Payment confirmed → minting → owned.
  127 |     await expect(page.getByText(/minting 5 egg claims/i)).toBeVisible({ timeout: 60_000 })
  128 |     await expect(page.getByText("5 egg claims")).toBeVisible({ timeout: 60_000 })
  129 | 
  130 |     // Proofs really exist, carry the unit, the exactly-one future tag,
  131 |     // and the series' exact terms URI.
  132 |     const proofs = await readFutureProofs(page)
  133 |     const mine = proofs.filter((p) => p.unit === series.unit && p.state !== "spent")
  134 |     expect(mine.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
  135 |     for (const proof of mine) {
  136 |       const tag = futureTag(proof.secret)
  137 |       expect(tag, `proof secret must carry exactly one future tag: ${proof.secret.slice(0, 80)}`).not.toBeNull()
  138 |       expect(tag?.version).toBe("1")
  139 |       expect(tag?.uri).toBe(series.terms_uri)
  140 |     }
  141 | 
  142 |     // Series accounting moved; capacity ledger is aggregate-only.
  143 |     const after = (await farmOverview(page)).series.find((s) => s.date === series.date)
  144 |     expect(after?.issued).toBe(series.issued + 5)
  145 |     expect(after?.available).toBe(series.available - 5)
  146 | 
  147 |     // Terms blob is content-addressed: the digest in the URI addresses
  148 |     // the exact bytes served.
  149 |     const termsResp = await page.request.get(`${FARM_BASE}/terms/${series.terms_sha256}`)
  150 |     expect(termsResp.status()).toBe(200)
  151 |     const blob = await termsResp.text()
  152 |     const digest = await page.evaluate(async (text) => {
  153 |       const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  154 |       return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")
  155 |     }, blob)
  156 |     expect(digest).toBe(series.terms_sha256)
  157 |     const envelope = JSON.parse(blob) as { mint: string; signature: string; terms: { unit: string } }
  158 |     expect(envelope.terms.unit).toBe(series.unit)
  159 |     expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/)
  160 |     expect(envelope.mint).toContain("/farm")
  161 | 
  162 |     // The mint advertises NUT-32.
  163 |     const info = await page.request.get("/farm/v1/info").then((r) => r.json())
  164 |     expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })
  165 | 
  166 |     // Issuance is wallet-bound: a locked future quote referencing an
  167 |     // unknown purchase is refused by the mint/processor (wrong-key-
  168 |     // for-known-purchase is pinned in processor tests).
  169 |     const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
  170 |       data: {
  171 |         amount: 5,
  172 |         unit: series.unit,
  173 |         pubkey: "02" + "ab".repeat(32),
  174 |         description: "foreign key attempt",
  175 |         purchase: "does-not-exist",
  176 |       },
  177 |     })
  178 |     expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)
  179 | 
  180 |     // ---------------------------------------------------------------
  181 |     // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
  182 |     // ---------------------------------------------------------------
  183 |     await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
  184 |     await page.getByRole("button", { name: /Send to Bob/i }).click()
  185 |     const tokenBox = page.locator("textarea[readonly]")
  186 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
  187 |     const token = await tokenBox.inputValue()
  188 |     expect(token.length).toBeGreaterThan(50)
  189 | 
  190 |     await expect
  191 |       .poll(async () => {
  192 |         const balances = await readFutureProofs(page)
  193 |         return balances
  194 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  195 |           .reduce((sum, p) => sum + p.amount, 0)
  196 |       })
  197 |       .toBe(3)
  198 | 
  199 |     // The swap preserved unit and terms URI on every replacement proof.
  200 |     const sarahProofs = (await readFutureProofs(page)).filter(
  201 |       (p) => p.unit === series.unit && p.state !== "spent",
  202 |     )
  203 |     for (const proof of sarahProofs) {
  204 |       expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
  205 |     }
  206 | 
  207 |     // Bob: a fresh browser profile receives the token and owns 2.
  208 |     const bobContext = await browser.newContext()
  209 |     const bobPage = await bobContext.newPage()
  210 |     await openFarmWallet(bobPage)
  211 |     await bobPage.locator("textarea").first().fill(token)
  212 |     await bobPage.getByRole("button", { name: /Receive token/i }).click()
  213 |     await expect
  214 |       .poll(async () => {
```