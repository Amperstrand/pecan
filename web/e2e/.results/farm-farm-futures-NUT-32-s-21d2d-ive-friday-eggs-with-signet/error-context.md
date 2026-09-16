# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:103:3

# Error details

```
TimeoutError: locator.waitFor: Timeout 60000ms exceeded.
Call log:
  - waiting for locator('textarea[readonly]') to be visible

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
        - generic [ref=e22]:
          - combobox "production day" [ref=e23]:
            - option "Wednesday, Sep 16 · 10 of 10 free · matured"
            - option "Thursday, Sep 17 · 0 of 10 free"
            - option "Friday, Sep 18 · 0 of 10 free"
            - option "Saturday, Sep 19 · 4 of 10 free"
            - option "Sunday, Sep 20 · 0 of 10 free"
            - option "Monday, Sep 21 · 0 of 10 free"
            - option "Tuesday, Sep 22 · 1 of 10 free" [selected]
          - text: · 1000 signet sats / egg
      - generic [ref=e24]:
        - generic [ref=e25]:
          - generic [ref=e26]:
            - generic [ref=e27]: Quantity
            - textbox "egg quantity" [ref=e28]: "5"
          - generic [ref=e29]:
            - generic [ref=e30]: 5 eggs
            - generic [ref=e31]: 5000 signet sats
            - generic [ref=e32]: "Production: Tuesday, Sep 22Available for pickup: Tue, 22 Sep 2026 16:00:00 UTC"
        - generic [ref=e33]: YOU OWN — Farm eggs · 5 claims of future:farm-egg:20260922t160000z
        - button "verify terms" [ref=e35] [cursor=pointer]
        - group [ref=e36]:
          - generic "all series (7)" [ref=e37] [cursor=pointer]
        - generic [ref=e38]: Custom output data total (3) does not match amount (2)
    - generic [ref=e39]:
      - generic [ref=e40]:
        - generic [ref=e41]: Developer Tools
        - generic [ref=e42]: Signet/test only. These actions are irreversible.
      - generic [ref=e43]:
        - button "Export wallet data (JSON)" [ref=e44] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e45] [cursor=pointer]
    - paragraph [ref=e46]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
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
> 207 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
      |                    ^ TimeoutError: locator.waitFor: Timeout 60000ms exceeded.
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
  219 | 
  220 |     // The swap preserved unit and terms URI on every replacement proof.
  221 |     const sarahProofs = (await readFutureProofs(page)).filter(
  222 |       (p) => p.unit === series.unit && p.state !== "spent",
  223 |     )
  224 |     for (const proof of sarahProofs) {
  225 |       expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
  226 |     }
  227 | 
  228 |     // Bob: a fresh browser profile receives the token and owns 2.
  229 |     const bobContext = await browser.newContext()
  230 |     const bobPage = await bobContext.newPage()
  231 |     await openFarmWallet(bobPage)
  232 |     await bobPage.locator("textarea").first().fill(token)
  233 |     await bobPage.getByRole("button", { name: /Receive token/i }).click()
  234 |     await expect
  235 |       .poll(async () => {
  236 |         const bobProofs = await readFutureProofs(bobPage)
  237 |         return bobProofs
  238 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  239 |           .reduce((sum, p) => sum + p.amount, 0)
  240 |       })
  241 |       .toBe(2)
  242 |     await bobContext.close()
  243 | 
  244 |     // Total supply unchanged by the transfer: issued unchanged.
  245 |     const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
  246 |     expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)
  247 | 
  248 |     // ---------------------------------------------------------------
  249 |     // Redemption: mature the series (admin demo override), Bob's 2
  250 |     // claims burn at the counter against physical handover.
  251 |     // ---------------------------------------------------------------
  252 |     await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
  253 |     const mature = await page.request.post(`${FARM_BASE}/api/farm/series/${series.date}/mature-now`)
  254 |     expect(mature.status()).toBe(200)
  255 | 
  256 |     const bobContext2 = await browser.newContext()
  257 |     const bobPage2 = await bobContext2.newPage()
  258 |     await openFarmWallet(bobPage2)
  259 |     await bobPage2.locator("textarea").first().fill(token)
  260 |     await bobPage2.getByRole("button", { name: /Receive token/i }).click()
  261 |     await expect
  262 |       .poll(async () => {
  263 |         const bobProofs = await readFutureProofs(bobPage2)
  264 |         return bobProofs
  265 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  266 |           .reduce((sum, p) => sum + p.amount, 0)
  267 |       })
  268 |       .toBe(2)
  269 | 
  270 |     await bobPage2.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
  271 |     await bobPage2.getByRole("button", { name: /Redeem at farm/i }).click()
  272 |     await expect(
  273 |       bobPage2.getByText(/teller code [0-9A-F]{6}/i),
  274 |     ).toBeVisible({ timeout: 60_000 })
  275 |     const code = await bobPage2.getByText(/teller code ([0-9A-F]{6})/i).textContent()
  276 |     const tail = code?.match(/([0-9A-F]{6})/)?.[1] ?? ""
  277 |     expect(tail).toHaveLength(6)
  278 | 
  279 |     // The admin session lives on Sarah's context — settle from there.
  280 |     const settled = await matchAndSettle(page, tail, "eggs handed over", FARM_BASE)
  281 |     expect(settled.unit).toBe(series.unit)
  282 |     expect(settled.amount).toBe(2)
  283 | 
  284 |     await expect
  285 |       .poll(async () => (await bobPage2.getByText(/FARM-/i).first().textContent()) ?? "")
  286 |       .toMatch(/FARM-/)
  287 |     await expect
  288 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
  289 |       .toBe(series.redeemed + 2)
  290 | 
  291 |     // Double redemption dies on spent proofs: Bob's own wallet no longer
  292 |     // shows the claims, so the melt cannot even lock inputs.
  293 |     const bobLeft = (await readFutureProofs(bobPage2)).filter(
  294 |       (p) => p.unit === series.unit && p.state !== "spent",
  295 |     )
  296 |     expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
  297 |     await bobContext2.close()
  298 |   })
  299 | 
  300 |   test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
  301 |     test.setTimeout(120_000)
  302 |     const series = await firstOpenSeries(page)
  303 | 
  304 |     // An 11-egg claim cannot exist: the API refuses beyond capacity.
  305 |     const tooMany = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  306 |       data: {
  307 |         production_date: series.date,
```