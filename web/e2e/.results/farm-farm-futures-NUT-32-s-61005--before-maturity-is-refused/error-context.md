# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> redemption before maturity is refused
- Location: e2e/farm.spec.ts:341:3

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected substring: "matures at"
Received string:    "{\"code\":11013,\"detail\":\"Unit unsupported\"}"
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
        - tab "FARM" [active] [selected] [ref=e14]
    - generic [ref=e16]:
      - generic [ref=e17]: YOU OWN
      - generic [ref=e18]: …
    - generic [ref=e20]:
      - textbox "paste a token to receive eggs" [ref=e21]
      - button "Receive token" [ref=e22] [cursor=pointer]
    - generic [ref=e23]:
      - generic [ref=e24]:
        - generic [ref=e25]: FARM
        - generic [ref=e26]:
          - combobox "production day" [ref=e27]:
            - option "Thursday, Sep 17 · 5 of 10 free · matured" [selected]
            - option "Friday, Sep 18 · 0 of 10 free"
            - option "Saturday, Sep 19 · 0 of 10 free"
            - option "Sunday, Sep 20 · 0 of 10 free"
            - option "Monday, Sep 21 · 0 of 10 free"
            - option "Tuesday, Sep 22 · 1 of 10 free · matured"
            - option "Wednesday, Sep 23 · 5 of 10 free · matured"
            - option "Thursday, Sep 24 · 0 of 10 free"
            - option "Friday, Sep 25 · 5 of 10 free · matured"
            - option "Saturday, Sep 26 · 5 of 10 free · matured"
          - text: · 1000 signet sats / egg
      - generic [ref=e28]:
        - generic [ref=e29]:
          - generic [ref=e30]:
            - generic [ref=e31]: Quantity
            - textbox "egg quantity" [ref=e32]: "5"
          - generic [ref=e33]:
            - generic [ref=e34]: 5 eggs
            - generic [ref=e35]: 5000 signet sats
            - generic [ref=e36]: "Production: Thursday, Sep 17Available for pickup: Thu, 17 Sep 2026 16:00:00 UTC"
        - button "Buy for 5000 signet sats" [ref=e37] [cursor=pointer]
        - button "verify terms" [ref=e39] [cursor=pointer]
        - group [ref=e40]:
          - generic "all series (10)" [ref=e41] [cursor=pointer]
    - generic [ref=e42]:
      - generic [ref=e43]:
        - generic [ref=e44]: Developer Tools
        - generic [ref=e45]: Signet/test only. These actions are irreversible.
      - generic [ref=e46]:
        - button "Export wallet data (JSON)" [ref=e47] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e48] [cursor=pointer]
    - paragraph [ref=e49]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
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
  289 |     await expect
  290 |       .poll(async () => (await bobPage2.getByText(/FARM-/i).first().textContent()) ?? "")
  291 |       .toMatch(/FARM-/)
  292 |     await expect
  293 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
  294 |       .toBe(series.redeemed + 2)
  295 | 
  296 |     // Double redemption dies on spent proofs: Bob's own wallet no longer
  297 |     // shows the claims, so the melt cannot even lock inputs.
  298 |     const bobLeft = (await readFutureProofs(bobPage2)).filter(
  299 |       (p) => p.unit === series.unit && p.state !== "spent",
  300 |     )
  301 |     expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
  302 |     await bobContext.close()
  303 |   })
  304 | 
  305 |   test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
  306 |     test.setTimeout(120_000)
  307 |     const series = await firstOpenSeries(page)
  308 | 
  309 |     // An 11-egg claim cannot exist: the API refuses beyond capacity.
  310 |     const tooMany = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  311 |       data: {
  312 |         production_date: series.date,
  313 |         quantity: series.capacity + 1,
  314 |         pubkey: "02" + "cd".repeat(32),
  315 |       },
  316 |     })
  317 |     expect(tooMany.status()).toBeGreaterThanOrEqual(400)
  318 | 
  319 |     // Purchase everything that is left — the next one must fail.
  320 |     if (series.available > 0) {
  321 |       const grab = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  322 |         data: {
  323 |           production_date: series.date,
  324 |           quantity: series.available,
  325 |           pubkey: "02" + "ef".repeat(32),
  326 |         },
  327 |       })
  328 |       expect(grab.status()).toBe(200)
  329 |       const none = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  330 |         data: {
  331 |           production_date: series.date,
  332 |           quantity: 1,
  333 |           pubkey: "02" + "ef".repeat(32),
  334 |         },
  335 |       })
  336 |       expect(none.status()).toBeGreaterThanOrEqual(400)
  337 |       expect((await none.json()).error).toContain("capacity")
  338 |     }
  339 |   })
  340 | 
  341 |   test("redemption before maturity is refused", async ({ page }) => {
  342 |     const series = (await farmOverview(page)).series.find((s) => !s.matured)
  343 |     if (!series) {
  344 |       test.skip(true, "no immature series left")
  345 |       return
  346 |     }
  347 |     const r = await page.request.post("/farm/v1/melt/quote/future", {
  348 |       data: {
  349 |         method: "future",
  350 |         request: "farm redemption",
  351 |         unit: series.unit,
  352 |         amount: 1,
  353 |       },
  354 |     })
  355 |     expect(r.status()).toBeGreaterThanOrEqual(400)
  356 |     const body = await r.text()
> 357 |     expect(body).toContain("matures at")
      |                  ^ Error: expect(received).toContain(expected) // indexOf
  358 |   })
  359 | })
  360 | 
```