# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:112:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 5
Received: 0
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
            - option "Thursday, Sep 17 · 5 of 10 free · matured"
            - option "Friday, Sep 18 · 0 of 10 free"
            - option "Saturday, Sep 19 · 5 of 10 free" [selected]
            - option "Sunday, Sep 20 · 0 of 10 free"
            - option "Monday, Sep 21 · 0 of 10 free"
            - option "Tuesday, Sep 22 · 8 of 10 free"
            - option "Wednesday, Sep 23 · 10 of 10 free"
            - option "Thursday, Sep 24 · 10 of 10 free"
            - option "Friday, Sep 25 · 10 of 10 free"
            - option "Saturday, Sep 26 · 10 of 10 free"
          - text: · 1000 signet sats / egg
      - generic [ref=e28]:
        - generic [ref=e29]:
          - generic [ref=e30]:
            - generic [ref=e31]: Quantity
            - textbox "egg quantity" [ref=e32]: "5"
          - generic [ref=e33]:
            - generic [ref=e34]: 5 eggs
            - generic [ref=e35]: 5000 signet sats
            - generic [ref=e36]: "Production: Saturday, Sep 19Available for pickup: Sat, 19 Sep 2026 16:00:00 UTC"
        - generic [ref=e37]: Payment received — minting 5 egg claims…
        - button "verify terms" [ref=e41] [cursor=pointer]
        - group [ref=e42]:
          - generic "all series (10)" [ref=e43] [cursor=pointer]
    - generic [ref=e44]:
      - generic [ref=e45]:
        - generic [ref=e46]: Developer Tools
        - generic [ref=e47]: Signet/test only. These actions are irreversible.
      - generic [ref=e48]:
        - button "Export wallet data (JSON)" [ref=e49] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e50] [cursor=pointer]
    - paragraph [ref=e51]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
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
  149 |       const all = await page.evaluate(async () => {
  150 |         const db = await new Promise((resolve, reject) => {
  151 |           const req = indexedDB.open("giftcard-coco-wallet")
  152 |           req.onsuccess = () => resolve(req.result)
  153 |           req.onerror = () => reject(req.error)
  154 |         })
  155 |         return await new Promise((resolve) => {
  156 |           const tx = db.transaction("coco_cashu_proofs", "readonly")
  157 |           const req = tx.objectStore("coco_cashu_proofs").getAll()
  158 |           req.onsuccess = () => resolve(req.result.slice(0, 8))
  159 |           req.onerror = () => resolve([])
  160 |         })
  161 |       })
  162 |       console.log(
  163 |         "RAW ROWS:",
  164 |         JSON.stringify(all.map((r) => ({ unit: r.unit, amount: r.amount, state: r.state, keys: Object.keys(r).join("|") }))),
  165 |       )
  166 |     }
> 167 |     expect(mine.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
      |                                                        ^ Error: expect(received).toBe(expected) // Object.is equality
  168 |     for (const proof of mine) {
  169 |       const tag = futureTag(proof.secret)
  170 |       expect(tag, `proof secret must carry exactly one future tag: ${proof.secret.slice(0, 80)}`).not.toBeNull()
  171 |       expect(tag?.version).toBe("1")
  172 |       expect(tag?.uri).toBe(series.terms_uri)
  173 |     }
  174 | 
  175 |     // Series accounting moved (the farm's minted-marker polls the mint
  176 |     // quote state, so `issued` converges within a few seconds); capacity
  177 |     // ledger is aggregate-only.
  178 |     await expect
  179 |       .poll(
  180 |         async () =>
  181 |           (await farmOverview(page)).series.find((s) => s.date === series.date)?.issued ?? -1,
  182 |         { timeout: 30_000 },
  183 |       )
  184 |       .toBe(series.issued + 5)
  185 |     const after = (await farmOverview(page)).series.find((s) => s.date === series.date)
  186 |     expect(after?.available).toBe(series.available - 5)
  187 | 
  188 |     // Terms blob is content-addressed: the digest in the URI addresses
  189 |     // the exact bytes served.
  190 |     const termsResp = await page.request.get(`${FARM_BASE}/terms/${series.terms_sha256}`)
  191 |     expect(termsResp.status()).toBe(200)
  192 |     const blob = await termsResp.text()
  193 |     const digest = await page.evaluate(async (text) => {
  194 |       const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  195 |       return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")
  196 |     }, blob)
  197 |     expect(digest).toBe(series.terms_sha256)
  198 |     const envelope = JSON.parse(blob) as { mint: string; signature: string; terms: { unit: string } }
  199 |     expect(envelope.terms.unit).toBe(series.unit)
  200 |     expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/)
  201 |     expect(envelope.mint).toContain("/farm")
  202 | 
  203 |     // The mint advertises NUT-32.
  204 |     const info = await page.request.get("/farm/v1/info").then((r) => r.json())
  205 |     expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })
  206 | 
  207 |     // Issuance is wallet-bound: a locked future quote referencing an
  208 |     // unknown purchase is refused by the mint/processor (wrong-key-
  209 |     // for-known-purchase is pinned in processor tests).
  210 |     const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
  211 |       data: {
  212 |         amount: 5,
  213 |         unit: series.unit,
  214 |         pubkey: "02" + "ab".repeat(32),
  215 |         description: "foreign key attempt",
  216 |         purchase: "does-not-exist",
  217 |       },
  218 |     })
  219 |     expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)
  220 | 
  221 |     // ---------------------------------------------------------------
  222 |     // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
  223 |     // ---------------------------------------------------------------
  224 |     await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
  225 |     await page.getByRole("button", { name: /Send to Bob/i }).click()
  226 |     const tokenBox = page.getByTestId("farm-token")
  227 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
  228 |     const token = await tokenBox.inputValue()
  229 |     expect(token.length).toBeGreaterThan(50)
  230 | 
  231 |     await expect
  232 |       .poll(async () => {
  233 |         const balances = await readFutureProofs(page)
  234 |         return balances
  235 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  236 |           .reduce((sum, p) => sum + p.amount, 0)
  237 |       })
  238 |       .toBe(3)
  239 | 
  240 |     // The swap preserved unit and terms URI on every replacement proof.
  241 |     const sarahProofs = (await readFutureProofs(page)).filter(
  242 |       (p) => p.unit === series.unit && p.state !== "spent",
  243 |     )
  244 |     for (const proof of sarahProofs) {
  245 |       expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
  246 |     }
  247 | 
  248 |     // Bob: a fresh browser profile receives the token and owns 2.
  249 |     const bobContext = await browser.newContext()
  250 |     const bobPage = await bobContext.newPage()
  251 |     await openFarmWallet(bobPage)
  252 |     await bobPage.getByPlaceholder(/paste a token/i).fill(token)
  253 |     await bobPage.getByRole("button", { name: /Receive token/i }).click()
  254 |     // A fresh context boots five mints (incl. the external sat mint)
  255 |     // before the receive can run — give it a real budget.
  256 |     await expect
  257 |       .poll(async () => {
  258 |         const bobProofs = await readFutureProofs(bobPage)
  259 |         return bobProofs
  260 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  261 |           .reduce((sum, p) => sum + p.amount, 0)
  262 |       }, { timeout: 120_000 })
  263 |       .toBe(2)
  264 | 
  265 |     // Total supply unchanged by the transfer: issued unchanged.
  266 |     const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
  267 |     expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)
```