# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:103:3

# Error details

```
Error: locator.waitFor: Error: strict mode violation: locator('textarea.font-mono') resolved to 2 elements:
    1) <textarea placeholder="paste a token to receive eggs" class="flex rounded-md border border-input bg-background px-3 py-2 text-xs font-mono break-all h-16"></textarea> aka getByRole('textbox', { name: 'paste a token to receive eggs' })
    2) <textarea readonly class="rounded bg-muted p-2 text-xs font-mono break-all h-20">lntbs50u1p424a26sp5z5za82lcz2hgqeytywrl3htaqz38as…</textarea> aka getByText('lntbs50u1p424a26sp5z5za82lcz2hgqeytywrl3htaqz38asyr0p9mzeltlhsu288rs8lspp5lqxplg')

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
    - generic [ref=e20]:
      - textbox "paste a token to receive eggs" [ref=e21]
      - button "Receive token" [ref=e22] [cursor=pointer]
    - generic [ref=e23]:
      - generic [ref=e24]:
        - generic [ref=e25]: FARM
        - generic [ref=e26]:
          - combobox "production day" [ref=e27]:
            - option "Wednesday, Sep 16 · 10 of 10 free · matured"
            - option "Thursday, Sep 17 · 0 of 10 free"
            - option "Friday, Sep 18 · 0 of 10 free"
            - option "Saturday, Sep 19 · 4 of 10 free"
            - option "Sunday, Sep 20 · 0 of 10 free"
            - option "Monday, Sep 21 · 0 of 10 free"
            - option "Tuesday, Sep 22 · 1 of 10 free"
            - option "Wednesday, Sep 23 · 3 of 10 free"
            - option "Thursday, Sep 24 · 0 of 10 free"
            - option "Friday, Sep 25 · 0 of 10 free"
            - option "Saturday, Sep 26 · 5 of 10 free" [selected]
            - option "Sunday, Sep 27 · 10 of 10 free"
            - option "Monday, Sep 28 · 10 of 10 free"
            - option "Tuesday, Sep 29 · 10 of 10 free"
          - text: · 1000 signet sats / egg
      - generic [ref=e28]:
        - generic [ref=e29]:
          - generic [ref=e30]:
            - generic [ref=e31]: Quantity
            - textbox "egg quantity" [ref=e32]: "5"
          - generic [ref=e33]:
            - generic [ref=e34]: 5 eggs
            - generic [ref=e35]: 5000 signet sats
            - generic [ref=e36]: "Production: Saturday, Sep 26Available for pickup: Sat, 26 Sep 2026 16:00:00 UTC"
        - generic [ref=e37]:
          - generic [ref=e38]: Pay 5000 signet sats — waiting for payment
          - textbox [ref=e42]: lntbs50u1p424a26sp5z5za82lcz2hgqeytywrl3htaqz38asyr0p9mzeltlhsu288rs8lspp5lqxplgf535nh3lczv74hpg9nf7ns4wam2rvhqnss9ft3rs50z4wsdp6geshymfqxgcryd3dxquj6v3k8gsr2gr9vanjsuefypuzqvfsxqczqumpwsxqrpcgcqp2rzjq24p9s7hz42lhzxsh396ax482t6qvy5j23g76j5m248ykuuu83gcxp82avqqqjcqqqqqqqqqqqqp92cqqc9qxpqysgqcyy3k45f7ttja5tet56yvn9y74gsfnqhr48tflq3v22nl69u5kj9yxcksywqthu93juka24tth3we83uh5xrctsveq6xntyelxg2gwcpwl5xyd
          - button "Copy invoice" [ref=e43] [cursor=pointer]
        - button "verify terms" [ref=e45] [cursor=pointer]
        - group [ref=e46]:
          - generic "all series (14)" [ref=e47] [cursor=pointer]
    - generic [ref=e48]:
      - generic [ref=e49]:
        - generic [ref=e50]: Developer Tools
        - generic [ref=e51]: Signet/test only. These actions are irreversible.
      - generic [ref=e52]:
        - button "Export wallet data (JSON)" [ref=e53] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e54] [cursor=pointer]
    - paragraph [ref=e55]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
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
  104 |     test.setTimeout(420_000)
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
> 118 |     await invoiceBox.waitFor({ state: "visible", timeout: 30_000 })
      |                      ^ Error: locator.waitFor: Error: strict mode violation: locator('textarea.font-mono') resolved to 2 elements:
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
  130 |     // Payment confirmed → the panel mints → owned. (The transient
  131 |     // "minting…" phase can complete while the external pay call is still
  132 |     // returning — assert the outcome, not the intermediate.)
  133 |     await expect(page.getByText("5 egg claims").first()).toBeVisible({ timeout: 90_000 })
  134 | 
  135 |     // Proofs really exist, carry the unit, the exactly-one future tag,
  136 |     // and the series' exact terms URI.
  137 |     const proofs = await readFutureProofs(page)
  138 |     const mine = proofs.filter((p) => p.unit === series.unit && p.state !== "spent")
  139 |     if (mine.reduce((sum, p) => sum + p.amount, 0) !== 5) {
  140 |       console.log(
  141 |         "FUTURE ROWS:",
  142 |         JSON.stringify(
  143 |           proofs.map((p) => ({ unit: p.unit, amount: p.amount, state: p.state, secretHead: p.secret.slice(0, 40) })),
  144 |         ),
  145 |       )
  146 |     }
  147 |     expect(mine.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
  148 |     for (const proof of mine) {
  149 |       const tag = futureTag(proof.secret)
  150 |       expect(tag, `proof secret must carry exactly one future tag: ${proof.secret.slice(0, 80)}`).not.toBeNull()
  151 |       expect(tag?.version).toBe("1")
  152 |       expect(tag?.uri).toBe(series.terms_uri)
  153 |     }
  154 | 
  155 |     // Series accounting moved (the farm's minted-marker polls the mint
  156 |     // quote state, so `issued` converges within a few seconds); capacity
  157 |     // ledger is aggregate-only.
  158 |     await expect
  159 |       .poll(
  160 |         async () =>
  161 |           (await farmOverview(page)).series.find((s) => s.date === series.date)?.issued ?? -1,
  162 |         { timeout: 30_000 },
  163 |       )
  164 |       .toBe(series.issued + 5)
  165 |     const after = (await farmOverview(page)).series.find((s) => s.date === series.date)
  166 |     expect(after?.available).toBe(series.available - 5)
  167 | 
  168 |     // Terms blob is content-addressed: the digest in the URI addresses
  169 |     // the exact bytes served.
  170 |     const termsResp = await page.request.get(`${FARM_BASE}/terms/${series.terms_sha256}`)
  171 |     expect(termsResp.status()).toBe(200)
  172 |     const blob = await termsResp.text()
  173 |     const digest = await page.evaluate(async (text) => {
  174 |       const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  175 |       return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")
  176 |     }, blob)
  177 |     expect(digest).toBe(series.terms_sha256)
  178 |     const envelope = JSON.parse(blob) as { mint: string; signature: string; terms: { unit: string } }
  179 |     expect(envelope.terms.unit).toBe(series.unit)
  180 |     expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/)
  181 |     expect(envelope.mint).toContain("/farm")
  182 | 
  183 |     // The mint advertises NUT-32.
  184 |     const info = await page.request.get("/farm/v1/info").then((r) => r.json())
  185 |     expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })
  186 | 
  187 |     // Issuance is wallet-bound: a locked future quote referencing an
  188 |     // unknown purchase is refused by the mint/processor (wrong-key-
  189 |     // for-known-purchase is pinned in processor tests).
  190 |     const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
  191 |       data: {
  192 |         amount: 5,
  193 |         unit: series.unit,
  194 |         pubkey: "02" + "ab".repeat(32),
  195 |         description: "foreign key attempt",
  196 |         purchase: "does-not-exist",
  197 |       },
  198 |     })
  199 |     expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)
  200 | 
  201 |     // ---------------------------------------------------------------
  202 |     // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
  203 |     // ---------------------------------------------------------------
  204 |     await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
  205 |     await page.getByRole("button", { name: /Send to Bob/i }).click()
  206 |     const tokenBox = page.locator("textarea[readonly]")
  207 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
  208 |     const token = await tokenBox.inputValue()
  209 |     expect(token.length).toBeGreaterThan(50)
  210 | 
  211 |     await expect
  212 |       .poll(async () => {
  213 |         const balances = await readFutureProofs(page)
  214 |         return balances
  215 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  216 |           .reduce((sum, p) => sum + p.amount, 0)
  217 |       })
  218 |       .toBe(3)
```