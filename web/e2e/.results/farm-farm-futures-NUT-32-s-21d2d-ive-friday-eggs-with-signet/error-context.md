# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:103:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/minting 5 egg claims/i)
Expected: visible
Timeout: 60000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 60000ms
  - waiting for getByText(/minting 5 egg claims/i)

```

```yaml
- main:
  - img
  - heading "Wallet" [level=1]
  - tablist "Currency":
    - tab "EUR"
    - tab "NOK"
    - tab "USD"
    - tab "SATS"
    - tab "FARM" [selected]
  - text: YOU OWN 0 egg claims FARM
  - combobox "production day":
    - option "Wednesday, Sep 16 · 4 of 10 free"
    - option "Thursday, Sep 17 · 0 of 10 free" [selected]
    - option "Friday, Sep 18 · 10 of 10 free"
    - option "Saturday, Sep 19 · 10 of 10 free"
    - option "Sunday, Sep 20 · 10 of 10 free"
    - option "Monday, Sep 21 · 10 of 10 free"
    - option "Tuesday, Sep 22 · 10 of 10 free"
  - text: · 1000 signet sats / egg Quantity
  - textbox "egg quantity": "5"
  - text: "5 eggs 5000 signet sats Production: Thursday, Sep 17 Available for pickup: Thu, 17 Sep 2026 16:00:00 UTC"
  - button "Buy for 5000 signet sats" [disabled]
  - button "verify terms"
  - group: all series (7)
  - text: "minting failed: Invalid payment request Developer Tools Signet/test only. These actions are irreversible."
  - button "Export wallet data (JSON)"
  - button "Force clear wallet (downloads backup first)"
  - paragraph: Self-custodied — Coco 2 · keys stay in your browser.
- region "Notifications alt+T"
```

# Test source

```ts
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
  49  |   await expect(page.getByLabel("production day")).toBeVisible({ timeout: 30_000 })
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
  109 |     // Drive the production-day picker to the verified series — the
  110 |     // panel's default is merely the first open day.
  111 |     await page.getByLabel("production day").selectOption(series.date)
  112 | 
  113 |     // Unpaid quote reserves capacity: the overview shows 5 fewer free
  114 |     // eggs the moment the purchase exists.
  115 |     await page.getByLabel("egg quantity").fill("5")
  116 |     await page.getByRole("button", { name: /Buy for \d+ signet sats/ }).click()
  117 |     const invoiceBox = page.locator("textarea.font-mono")
  118 |     await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
  119 |     const invoice = (await invoiceBox.inputValue()) || (await invoiceBox.textContent()) || ""
  120 |     expect(invoice.startsWith("lntb")).toBeTruthy()
  121 | 
  122 |     await expect
  123 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.available ?? -1)
  124 |       .toBe(series.available - 5)
  125 | 
  126 |     // Real signet payment from an external lab node.
  127 |     const preimage = payLightningInvoice(invoice.trim())
  128 |     expect(preimage).toMatch(/^[0-9a-f]{64}$/)
  129 | 
  130 |     // Payment confirmed → minting → owned.
> 131 |     await expect(page.getByText(/minting 5 egg claims/i)).toBeVisible({ timeout: 60_000 })
      |                                                           ^ Error: expect(locator).toBeVisible() failed
  132 |     await expect(page.getByText("5 egg claims")).toBeVisible({ timeout: 60_000 })
  133 | 
  134 |     // Proofs really exist, carry the unit, the exactly-one future tag,
  135 |     // and the series' exact terms URI.
  136 |     const proofs = await readFutureProofs(page)
  137 |     const mine = proofs.filter((p) => p.unit === series.unit && p.state !== "spent")
  138 |     expect(mine.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
  139 |     for (const proof of mine) {
  140 |       const tag = futureTag(proof.secret)
  141 |       expect(tag, `proof secret must carry exactly one future tag: ${proof.secret.slice(0, 80)}`).not.toBeNull()
  142 |       expect(tag?.version).toBe("1")
  143 |       expect(tag?.uri).toBe(series.terms_uri)
  144 |     }
  145 | 
  146 |     // Series accounting moved; capacity ledger is aggregate-only.
  147 |     const after = (await farmOverview(page)).series.find((s) => s.date === series.date)
  148 |     expect(after?.issued).toBe(series.issued + 5)
  149 |     expect(after?.available).toBe(series.available - 5)
  150 | 
  151 |     // Terms blob is content-addressed: the digest in the URI addresses
  152 |     // the exact bytes served.
  153 |     const termsResp = await page.request.get(`${FARM_BASE}/terms/${series.terms_sha256}`)
  154 |     expect(termsResp.status()).toBe(200)
  155 |     const blob = await termsResp.text()
  156 |     const digest = await page.evaluate(async (text) => {
  157 |       const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  158 |       return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")
  159 |     }, blob)
  160 |     expect(digest).toBe(series.terms_sha256)
  161 |     const envelope = JSON.parse(blob) as { mint: string; signature: string; terms: { unit: string } }
  162 |     expect(envelope.terms.unit).toBe(series.unit)
  163 |     expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/)
  164 |     expect(envelope.mint).toContain("/farm")
  165 | 
  166 |     // The mint advertises NUT-32.
  167 |     const info = await page.request.get("/farm/v1/info").then((r) => r.json())
  168 |     expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })
  169 | 
  170 |     // Issuance is wallet-bound: a locked future quote referencing an
  171 |     // unknown purchase is refused by the mint/processor (wrong-key-
  172 |     // for-known-purchase is pinned in processor tests).
  173 |     const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
  174 |       data: {
  175 |         amount: 5,
  176 |         unit: series.unit,
  177 |         pubkey: "02" + "ab".repeat(32),
  178 |         description: "foreign key attempt",
  179 |         purchase: "does-not-exist",
  180 |       },
  181 |     })
  182 |     expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)
  183 | 
  184 |     // ---------------------------------------------------------------
  185 |     // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
  186 |     // ---------------------------------------------------------------
  187 |     await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
  188 |     await page.getByRole("button", { name: /Send to Bob/i }).click()
  189 |     const tokenBox = page.locator("textarea[readonly]")
  190 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
  191 |     const token = await tokenBox.inputValue()
  192 |     expect(token.length).toBeGreaterThan(50)
  193 | 
  194 |     await expect
  195 |       .poll(async () => {
  196 |         const balances = await readFutureProofs(page)
  197 |         return balances
  198 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  199 |           .reduce((sum, p) => sum + p.amount, 0)
  200 |       })
  201 |       .toBe(3)
  202 | 
  203 |     // The swap preserved unit and terms URI on every replacement proof.
  204 |     const sarahProofs = (await readFutureProofs(page)).filter(
  205 |       (p) => p.unit === series.unit && p.state !== "spent",
  206 |     )
  207 |     for (const proof of sarahProofs) {
  208 |       expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
  209 |     }
  210 | 
  211 |     // Bob: a fresh browser profile receives the token and owns 2.
  212 |     const bobContext = await browser.newContext()
  213 |     const bobPage = await bobContext.newPage()
  214 |     await openFarmWallet(bobPage)
  215 |     await bobPage.locator("textarea").first().fill(token)
  216 |     await bobPage.getByRole("button", { name: /Receive token/i }).click()
  217 |     await expect
  218 |       .poll(async () => {
  219 |         const bobProofs = await readFutureProofs(bobPage)
  220 |         return bobProofs
  221 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  222 |           .reduce((sum, p) => sum + p.amount, 0)
  223 |       })
  224 |       .toBe(2)
  225 |     await bobContext.close()
  226 | 
  227 |     // Total supply unchanged by the transfer: issued still 5.
  228 |     const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
  229 |     expect(transferred?.issued).toBe(series.issued + 5)
  230 | 
  231 |     // ---------------------------------------------------------------
```