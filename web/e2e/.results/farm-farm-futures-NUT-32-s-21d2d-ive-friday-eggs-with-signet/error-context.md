# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:112:3

# Error details

```
Error: Timeout 90000ms exceeded while waiting on the predicate
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
            - generic [ref=e22]: Farm — Tuesday, Sep 22 eggs
            - generic [ref=e23]: ·
            - generic [ref=e24]: "3"
            - button "details" [ref=e25] [cursor=pointer]
          - generic [ref=e26]:
            - textbox "send quantity for future:farm-egg:20260922t160000z" [ref=e27]: "2"
            - button "Send to Bob (token)" [ref=e28] [cursor=pointer]
            - textbox "redeem quantity for future:farm-egg:20260922t160000z" [ref=e29]: "2"
            - button "Redeem at farm" [ref=e30] [cursor=pointer]
        - generic [ref=e31]:
          - generic [ref=e32]: "Token to hand Bob (2 eggs) — normal Cashu bearer transfer:"
          - textbox [ref=e33]: cashuBo2FteCRodHRwczovL2dpZnRjYXJkLmNhc2h1LmV4Y2hhbmdlL2Zhcm1hdXggZnV0dXJlOmZhcm0tZWdnOjIwMjYwOTIydDE2MDAwMHphdIGiYWlIAMHtUhDnzn9hcIGkYWECYXN423sic2VjcmV0IjoiMTJkYjc0NmEyMTZhNTZlMDU2MzA4OTVkZTNhNzQ3ODVlNjI5YWRjMmFkOTE0ZDEwM2Y1YzE2MzdiZTlmNjJhZCIsInRhZ3MiOltbImZ1dHVyZSIsIjEiLCJodHRwczovL2dpZnRjYXJkLmNhc2h1LmV4Y2hhbmdlL2Zhcm0tY29uc29sZS90ZXJtcy9lMWVhMjg2MWVkMGIwNzIyOTM2NTRiOThiMDliNDY0MmIzYTNmZTY3MTkwYjVhMmY4OTRiYjE2MDgyOTJkNzZmIl1dfWFjWCEDa8ZL4kTdRUlhQ36q2dDrrqS9otAG248DEXL0zane0dZhZKNhZVgg2288Gzf3GVp6uH8ecuKQMrmWfFjQRusLx4YzUdIV-dthc1ggJZUisvbLSa8UyQarAYNn8kgwFfiCYY99-2PXY8bn_0VhclggIRYuR4wR1nPrplDOfxsbbBudOhJvwfO8znQd9y98Y3g
    - generic [ref=e35]:
      - textbox "paste a token to receive eggs" [ref=e36]
      - button "Receive token" [ref=e37] [cursor=pointer]
    - generic [ref=e38]:
      - generic [ref=e39]:
        - generic [ref=e40]: FARM
        - generic [ref=e41]:
          - combobox "production day" [ref=e42]:
            - option "Thursday, Sep 17 · 5 of 10 free · matured"
            - option "Friday, Sep 18 · 5 of 10 free · matured"
            - option "Saturday, Sep 19 · 5 of 10 free · matured"
            - option "Sunday, Sep 20 · 5 of 10 free · matured"
            - option "Monday, Sep 21 · 5 of 10 free · matured"
            - option "Tuesday, Sep 22 · 5 of 10 free · matured" [selected]
            - option "Wednesday, Sep 23 · 10 of 10 free"
            - option "Thursday, Sep 24 · 10 of 10 free"
            - option "Friday, Sep 25 · 10 of 10 free"
            - option "Saturday, Sep 26 · 10 of 10 free"
          - text: · 1000 signet sats / egg
      - generic [ref=e43]:
        - generic [ref=e44]:
          - generic [ref=e45]:
            - generic [ref=e46]: Quantity
            - textbox "egg quantity" [ref=e47]: "5"
          - generic [ref=e48]:
            - generic [ref=e49]: 5 eggs
            - generic [ref=e50]: 5000 signet sats
            - generic [ref=e51]: "Production: Tuesday, Sep 22Available for pickup: Tue, 22 Sep 2026 16:00:00 UTC"
        - generic [ref=e52]: YOU OWN — Farm eggs · 5 claims of future:farm-egg:20260922t160000z
        - button "verify terms" [ref=e54] [cursor=pointer]
        - group [ref=e55]:
          - generic "all series (10)" [ref=e56] [cursor=pointer]
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
  196 | 
  197 |     // The mint advertises NUT-32.
  198 |     const info = await page.request.get("/farm/v1/info").then((r) => r.json())
  199 |     expect(info.nuts?.["32"]).toMatchObject({ supported: true, versions: [1] })
  200 | 
  201 |     // Issuance is wallet-bound: a locked future quote referencing an
  202 |     // unknown purchase is refused by the mint/processor (wrong-key-
  203 |     // for-known-purchase is pinned in processor tests).
  204 |     const foreignQuote = await page.request.post("/farm/v1/mint/quote/future", {
  205 |       data: {
  206 |         amount: 5,
  207 |         unit: series.unit,
  208 |         pubkey: "02" + "ab".repeat(32),
  209 |         description: "foreign key attempt",
  210 |         purchase: "does-not-exist",
  211 |       },
  212 |     })
  213 |     expect(foreignQuote.status()).toBeGreaterThanOrEqual(400)
  214 | 
  215 |     // ---------------------------------------------------------------
  216 |     // Sarah → Bob: 2 of 5 via bearer transfer, farm blind to it.
  217 |     // ---------------------------------------------------------------
  218 |     await page.getByLabel(`send quantity for ${series.unit}`).fill("2")
  219 |     await page.getByRole("button", { name: /Send to Bob/i }).click()
  220 |     const tokenBox = page.getByTestId("farm-token")
  221 |     await tokenBox.waitFor({ state: "visible", timeout: 60_000 })
  222 |     const token = await tokenBox.inputValue()
  223 |     expect(token.length).toBeGreaterThan(50)
  224 | 
  225 |     await expect
  226 |       .poll(async () => {
  227 |         const balances = await readFutureProofs(page)
  228 |         return balances
  229 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  230 |           .reduce((sum, p) => sum + p.amount, 0)
  231 |       })
  232 |       .toBe(3)
  233 | 
  234 |     // The swap preserved unit and terms URI on every replacement proof.
  235 |     const sarahProofs = (await readFutureProofs(page)).filter(
  236 |       (p) => p.unit === series.unit && p.state !== "spent",
  237 |     )
  238 |     for (const proof of sarahProofs) {
  239 |       expect(futureTag(proof.secret)?.uri).toBe(series.terms_uri)
  240 |     }
  241 | 
  242 |     // Bob: a fresh browser profile receives the token and owns 2.
  243 |     const bobContext = await browser.newContext()
  244 |     const bobPage = await bobContext.newPage()
  245 |     await openFarmWallet(bobPage)
  246 |     await bobPage.getByPlaceholder(/paste a token/i).fill(token)
  247 |     await bobPage.getByRole("button", { name: /Receive token/i }).click()
  248 |     // A fresh context boots five mints (incl. the external sat mint)
  249 |     // before the receive can run — give it a real budget.
  250 |     await expect
  251 |       .poll(async () => {
  252 |         const bobProofs = await readFutureProofs(bobPage)
  253 |         return bobProofs
  254 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  255 |           .reduce((sum, p) => sum + p.amount, 0)
  256 |       }, { timeout: 120_000 })
  257 |       .toBe(2)
  258 | 
  259 |     // Total supply unchanged by the transfer: issued unchanged.
  260 |     const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
  261 |     expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)
  262 | 
  263 |     // ---------------------------------------------------------------
  264 |     // Redemption: mature the series (admin demo override), Bob's 2
  265 |     // claims burn at the counter against physical handover.
  266 |     // ---------------------------------------------------------------
  267 |     await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
  268 |     const mature = await page.request.post(`${FARM_BASE}/api/farm/series/${series.date}/mature-now`)
  269 |     expect(mature.status()).toBe(200)
  270 | 
  271 |     // Bearer tokens are single-handover: the same token cannot be
  272 |     // received twice (its proofs are spent), so Bob redeems from the
  273 |     // wallet that already holds them.
  274 |     const bobPage2 = bobPage
  275 |     await bobPage2.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
  276 |     await bobPage2.getByRole("button", { name: /Redeem at farm/i }).click()
  277 |     await expect(
  278 |       bobPage2.getByText(/teller code [0-9A-F]{6}/i),
  279 |     ).toBeVisible({ timeout: 60_000 })
  280 |     const code = await bobPage2.getByText(/teller code ([0-9A-F]{6})/i).textContent()
  281 |     const tail = code?.match(/([0-9A-F]{6})/)?.[1] ?? ""
  282 |     expect(tail).toHaveLength(6)
  283 | 
  284 |     // The admin session lives on Sarah's context — settle from there.
  285 |     const settled = await matchAndSettle(page, tail, "eggs handed over", FARM_BASE)
  286 |     expect(settled.unit).toBe(series.unit)
  287 |     expect(settled.amount).toBe(2)
  288 | 
  289 |     // The melt finalizes asynchronously after the operator settles; the
  290 |     // wallet's poll picks the receipt up on its next tick.
  291 |     await expect
  292 |       .poll(
  293 |         async () => (await bobPage2.getByText(/FARM-/i).first().textContent().catch(() => "")) ?? "",
  294 |         { timeout: 90_000 },
  295 |       )
> 296 |       .toMatch(/FARM-/)
      |        ^ Error: Timeout 90000ms exceeded while waiting on the predicate
  297 |     await expect
  298 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
  299 |       .toBe(series.redeemed + 2)
  300 | 
  301 |     // Double redemption dies on spent proofs: Bob's own wallet no longer
  302 |     // shows the claims, so the melt cannot even lock inputs.
  303 |     const bobLeft = (await readFutureProofs(bobPage2)).filter(
  304 |       (p) => p.unit === series.unit && p.state !== "spent",
  305 |     )
  306 |     expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
  307 |     await bobContext.close()
  308 |   })
  309 | 
  310 |   test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
  311 |     test.setTimeout(120_000)
  312 |     const series = await firstOpenSeries(page)
  313 | 
  314 |     // An 11-egg claim cannot exist: the API refuses beyond capacity.
  315 |     const tooMany = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  316 |       data: {
  317 |         production_date: series.date,
  318 |         quantity: series.capacity + 1,
  319 |         pubkey: "02" + "cd".repeat(32),
  320 |       },
  321 |     })
  322 |     expect(tooMany.status()).toBeGreaterThanOrEqual(400)
  323 | 
  324 |     // Purchase everything that is left — the next one must fail.
  325 |     if (series.available > 0) {
  326 |       const grab = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  327 |         data: {
  328 |           production_date: series.date,
  329 |           quantity: series.available,
  330 |           pubkey: "02" + "ef".repeat(32),
  331 |         },
  332 |       })
  333 |       expect(grab.status()).toBe(200)
  334 |       const none = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  335 |         data: {
  336 |           production_date: series.date,
  337 |           quantity: 1,
  338 |           pubkey: "02" + "ef".repeat(32),
  339 |         },
  340 |       })
  341 |       expect(none.status()).toBeGreaterThanOrEqual(400)
  342 |       expect((await none.json()).error).toContain("capacity")
  343 |     }
  344 |   })
  345 | 
  346 |   test("redemption before maturity is refused", async ({ page }) => {
  347 |     const series = (await farmOverview(page)).series.find((s) => !s.matured)
  348 |     if (!series) {
  349 |       test.skip(true, "no immature series left")
  350 |       return
  351 |     }
  352 |     const r = await page.request.post("/farm/v1/melt/quote/future", {
  353 |       data: {
  354 |         method: "future",
  355 |         request: "farm redemption",
  356 |         unit: series.unit,
  357 |         amount: 1,
  358 |       },
  359 |     })
  360 |     // Refused at some layer (mint unit gate or the farm's maturity gate —
  361 |     // the message depends on which check fires first); the invariant is
  362 |     // that an immature redemption never creates a quote.
  363 |     expect(r.status()).toBeGreaterThanOrEqual(400)
  364 |     const body = await r.text()
  365 |     expect(body.toLowerCase()).toMatch(/matur|unsupported|refus|invalid/)
  366 |   })
  367 | })
  368 | 
```