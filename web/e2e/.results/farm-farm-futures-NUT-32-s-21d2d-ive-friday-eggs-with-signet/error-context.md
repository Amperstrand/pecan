# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:107:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 2
Received: 0

Call Log:
- Timeout 120000ms exceeded while waiting on the predicate
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
    - generic [ref=e15]:
      - generic [ref=e16]:
        - generic [ref=e17]: YOU OWN
        - generic [ref=e18]: 3 egg claims
      - generic [ref=e19]:
        - generic [ref=e20]:
          - generic [ref=e21]:
            - generic [ref=e22]: Farm — Tuesday, Sep 29 eggs
            - generic [ref=e23]: ·
            - generic [ref=e24]: "3"
            - button "details" [ref=e25] [cursor=pointer]
          - generic [ref=e26]:
            - textbox "send quantity for future:farm-egg:20260929t160000z" [ref=e27]: "2"
            - button "Send to Bob (token)" [ref=e28] [cursor=pointer]
            - textbox "redeem quantity for future:farm-egg:20260929t160000z" [ref=e29]: "2"
            - button "Redeem at farm" [ref=e30] [cursor=pointer]
        - generic [ref=e31]:
          - generic [ref=e32]: "Token to hand Bob (2 eggs) — normal Cashu bearer transfer:"
          - textbox [ref=e33]: cashuBo2FteCRodHRwczovL2dpZnRjYXJkLmNhc2h1LmV4Y2hhbmdlL2Zhcm1hdXggZnV0dXJlOmZhcm0tZWdnOjIwMjYwOTI5dDE2MDAwMHphdIGiYWlIAEupv09CVHNhcIGkYWECYXN423sic2VjcmV0IjoiNDQ4NjRmODE3MmZlMGI2YTBjMWU2NWVhMjZjYjE0ZTZiYjFjZjVjZTYwMmI3NzFmYWE0MWYwYTFkYTdlNTk5NSIsInRhZ3MiOltbImZ1dHVyZSIsIjEiLCJodHRwczovL2dpZnRjYXJkLmNhc2h1LmV4Y2hhbmdlL2Zhcm0tY29uc29sZS90ZXJtcy83NTZjMjllZjdjZWM4ODk2ZGIyM2NjOGM3YTllNWM4Njc5NWY5MWQ1NzRhYzg2Y2Q5NDFmNDhlMDAxMDc4MDAwIl1dfWFjWCED79ZOaHGkGeygocW5ETOmQ5jTlR9ZqgYIai7jUFgY0nFhZKNhZVggbal4SRl-9D3SFvETApzhQd2pca2g1CODdW5Nu2DTWt1hc1gg9ji0s8QwJeZr62Qrza-IHnK2_cu-Qg8fZ2o7jCeh6bxhclggez5yOByuep9bxxeCFlcXh6B-nKre1zsNOTVuHhcAWRc
    - generic [ref=e35]:
      - textbox "paste a token to receive eggs" [ref=e36]
      - button "Receive token" [ref=e37] [cursor=pointer]
    - generic [ref=e38]:
      - generic [ref=e39]:
        - generic [ref=e40]: FARM
        - generic [ref=e41]:
          - combobox "production day" [ref=e42]:
            - option "Wednesday, Sep 16 · 10 of 10 free · matured"
            - option "Thursday, Sep 17 · 0 of 10 free"
            - option "Friday, Sep 18 · 0 of 10 free"
            - option "Saturday, Sep 19 · 4 of 10 free"
            - option "Sunday, Sep 20 · 0 of 10 free"
            - option "Monday, Sep 21 · 0 of 10 free"
            - option "Tuesday, Sep 22 · 1 of 10 free"
            - option "Wednesday, Sep 23 · 3 of 10 free"
            - option "Thursday, Sep 24 · 5 of 10 free"
            - option "Friday, Sep 25 · 0 of 10 free"
            - option "Saturday, Sep 26 · 0 of 10 free"
            - option "Sunday, Sep 27 · 0 of 10 free"
            - option "Monday, Sep 28 · 0 of 10 free"
            - option "Tuesday, Sep 29 · 0 of 10 free" [selected]
          - text: · 1000 signet sats / egg
      - generic [ref=e43]:
        - generic [ref=e44]:
          - generic [ref=e45]:
            - generic [ref=e46]: Quantity
            - textbox "egg quantity" [ref=e47]: "5"
          - generic [ref=e48]:
            - generic [ref=e49]: 5 eggs
            - generic [ref=e50]: 5000 signet sats
            - generic [ref=e51]: "Production: Tuesday, Sep 29Available for pickup: Tue, 29 Sep 2026 16:00:00 UTC"
        - generic [ref=e52]: YOU OWN — Farm eggs · 5 claims of future:farm-egg:20260929t160000z
        - button "verify terms" [ref=e54] [cursor=pointer]
        - group [ref=e55]:
          - generic "all series (14)" [ref=e56] [cursor=pointer]
    - generic [ref=e57]:
      - generic [ref=e58]:
        - generic [ref=e59]: Developer Tools
        - generic [ref=e60]: Signet/test only. These actions are irreversible.
      - generic [ref=e61]:
        - button "Export wallet data (JSON)" [ref=e62] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e63] [cursor=pointer]
    - paragraph [ref=e64]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
  147 |           proofs.map((p) => ({ unit: p.unit, amount: p.amount, state: p.state, secretHead: p.secret.slice(0, 40) })),
  148 |         ),
  149 |       )
  150 |     }
  151 |     expect(mine.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
  152 |     for (const proof of mine) {
  153 |       const tag = futureTag(proof.secret)
  154 |       expect(tag, `proof secret must carry exactly one future tag: ${proof.secret.slice(0, 80)}`).not.toBeNull()
  155 |       expect(tag?.version).toBe("1")
  156 |       expect(tag?.uri).toBe(series.terms_uri)
  157 |     }
  158 | 
  159 |     // Series accounting moved (the farm's minted-marker polls the mint
  160 |     // quote state, so `issued` converges within a few seconds); capacity
  161 |     // ledger is aggregate-only.
  162 |     await expect
  163 |       .poll(
  164 |         async () =>
  165 |           (await farmOverview(page)).series.find((s) => s.date === series.date)?.issued ?? -1,
  166 |         { timeout: 30_000 },
  167 |       )
  168 |       .toBe(series.issued + 5)
  169 |     const after = (await farmOverview(page)).series.find((s) => s.date === series.date)
  170 |     expect(after?.available).toBe(series.available - 5)
  171 | 
  172 |     // Terms blob is content-addressed: the digest in the URI addresses
  173 |     // the exact bytes served.
  174 |     const termsResp = await page.request.get(`${FARM_BASE}/terms/${series.terms_sha256}`)
  175 |     expect(termsResp.status()).toBe(200)
  176 |     const blob = await termsResp.text()
  177 |     const digest = await page.evaluate(async (text) => {
  178 |       const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  179 |       return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("")
  180 |     }, blob)
  181 |     expect(digest).toBe(series.terms_sha256)
  182 |     const envelope = JSON.parse(blob) as { mint: string; signature: string; terms: { unit: string } }
  183 |     expect(envelope.terms.unit).toBe(series.unit)
  184 |     expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/)
  185 |     expect(envelope.mint).toContain("/farm")
  186 | 
  187 |     // The mint advertises NUT-32.
  188 |     const info = await page.request.get("/farm/v1/info").then((r) => r.json())
  189 |     expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })
  190 | 
  191 |     // Issuance is wallet-bound: a locked future quote referencing an
  192 |     // unknown purchase is refused by the mint/processor (wrong-key-
  193 |     // for-known-purchase is pinned in processor tests).
  194 |     const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
  195 |       data: {
  196 |         amount: 5,
  197 |         unit: series.unit,
  198 |         pubkey: "02" + "ab".repeat(32),
  199 |         description: "foreign key attempt",
  200 |         purchase: "does-not-exist",
  201 |       },
  202 |     })
  203 |     expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)
  204 | 
  205 |     // ---------------------------------------------------------------
  206 |     // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
  207 |     // ---------------------------------------------------------------
  208 |     await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
  209 |     await page.getByRole("button", { name: /Send to Bob/i }).click()
  210 |     const tokenBox = page.getByTestId("farm-token")
  211 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
  212 |     const token = await tokenBox.inputValue()
  213 |     expect(token.length).toBeGreaterThan(50)
  214 | 
  215 |     await expect
  216 |       .poll(async () => {
  217 |         const balances = await readFutureProofs(page)
  218 |         return balances
  219 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  220 |           .reduce((sum, p) => sum + p.amount, 0)
  221 |       })
  222 |       .toBe(3)
  223 | 
  224 |     // The swap preserved unit and terms URI on every replacement proof.
  225 |     const sarahProofs = (await readFutureProofs(page)).filter(
  226 |       (p) => p.unit === series.unit && p.state !== "spent",
  227 |     )
  228 |     for (const proof of sarahProofs) {
  229 |       expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
  230 |     }
  231 | 
  232 |     // Bob: a fresh browser profile receives the token and owns 2.
  233 |     const bobContext = await browser.newContext()
  234 |     const bobPage = await bobContext.newPage()
  235 |     await openFarmWallet(bobPage)
  236 |     await bobPage.getByPlaceholder(/paste a token/i).fill(token)
  237 |     await bobPage.getByRole("button", { name: /Receive token/i }).click()
  238 |     // A fresh context boots five mints (incl. the external sat mint)
  239 |     // before the receive can run — give it a real budget.
  240 |     await expect
  241 |       .poll(async () => {
  242 |         const bobProofs = await readFutureProofs(bobPage)
  243 |         return bobProofs
  244 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  245 |           .reduce((sum, p) => sum + p.amount, 0)
  246 |       }, { timeout: 120_000 })
> 247 |       .toBe(2)
      |        ^ Error: expect(received).toBe(expected) // Object.is equality
  248 |     await bobContext.close()
  249 | 
  250 |     // Total supply unchanged by the transfer: issued unchanged.
  251 |     const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
  252 |     expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)
  253 | 
  254 |     // ---------------------------------------------------------------
  255 |     // Redemption: mature the series (admin demo override), Bob's 2
  256 |     // claims burn at the counter against physical handover.
  257 |     // ---------------------------------------------------------------
  258 |     await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
  259 |     const mature = await page.request.post(`${FARM_BASE}/api/farm/series/${series.date}/mature-now`)
  260 |     expect(mature.status()).toBe(200)
  261 | 
  262 |     const bobContext2 = await browser.newContext()
  263 |     const bobPage2 = await bobContext2.newPage()
  264 |     await openFarmWallet(bobPage2)
  265 |     await bobPage2.getByPlaceholder(/paste a token/i).fill(token)
  266 |     await bobPage2.getByRole("button", { name: /Receive token/i }).click()
  267 |     await expect
  268 |       .poll(async () => {
  269 |         const bobProofs = await readFutureProofs(bobPage2)
  270 |         return bobProofs
  271 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  272 |           .reduce((sum, p) => sum + p.amount, 0)
  273 |       }, { timeout: 120_000 })
  274 |       .toBe(2)
  275 | 
  276 |     await bobPage2.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
  277 |     await bobPage2.getByRole("button", { name: /Redeem at farm/i }).click()
  278 |     await expect(
  279 |       bobPage2.getByText(/teller code [0-9A-F]{6}/i),
  280 |     ).toBeVisible({ timeout: 60_000 })
  281 |     const code = await bobPage2.getByText(/teller code ([0-9A-F]{6})/i).textContent()
  282 |     const tail = code?.match(/([0-9A-F]{6})/)?.[1] ?? ""
  283 |     expect(tail).toHaveLength(6)
  284 | 
  285 |     // The admin session lives on Sarah's context — settle from there.
  286 |     const settled = await matchAndSettle(page, tail, "eggs handed over", FARM_BASE)
  287 |     expect(settled.unit).toBe(series.unit)
  288 |     expect(settled.amount).toBe(2)
  289 | 
  290 |     await expect
  291 |       .poll(async () => (await bobPage2.getByText(/FARM-/i).first().textContent()) ?? "")
  292 |       .toMatch(/FARM-/)
  293 |     await expect
  294 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
  295 |       .toBe(series.redeemed + 2)
  296 | 
  297 |     // Double redemption dies on spent proofs: Bob's own wallet no longer
  298 |     // shows the claims, so the melt cannot even lock inputs.
  299 |     const bobLeft = (await readFutureProofs(bobPage2)).filter(
  300 |       (p) => p.unit === series.unit && p.state !== "spent",
  301 |     )
  302 |     expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
  303 |     await bobContext2.close()
  304 |   })
  305 | 
  306 |   test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
  307 |     test.setTimeout(120_000)
  308 |     const series = await firstOpenSeries(page)
  309 | 
  310 |     // An 11-egg claim cannot exist: the API refuses beyond capacity.
  311 |     const tooMany = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  312 |       data: {
  313 |         production_date: series.date,
  314 |         quantity: series.capacity + 1,
  315 |         pubkey: "02" + "cd".repeat(32),
  316 |       },
  317 |     })
  318 |     expect(tooMany.status()).toBeGreaterThanOrEqual(400)
  319 | 
  320 |     // Purchase everything that is left — the next one must fail.
  321 |     if (series.available > 0) {
  322 |       const grab = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  323 |         data: {
  324 |           production_date: series.date,
  325 |           quantity: series.available,
  326 |           pubkey: "02" + "ef".repeat(32),
  327 |         },
  328 |       })
  329 |       expect(grab.status()).toBe(200)
  330 |       const none = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  331 |         data: {
  332 |           production_date: series.date,
  333 |           quantity: 1,
  334 |           pubkey: "02" + "ef".repeat(32),
  335 |         },
  336 |       })
  337 |       expect(none.status()).toBeGreaterThanOrEqual(400)
  338 |       expect((await none.json()).error).toContain("capacity")
  339 |     }
  340 |   })
  341 | 
  342 |   test("redemption before maturity is refused", async ({ page }) => {
  343 |     const series = (await farmOverview(page)).series.find((s) => !s.matured)
  344 |     if (!series) {
  345 |       test.skip(true, "no immature series left")
  346 |       return
  347 |     }
```