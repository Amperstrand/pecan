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
- Timeout 10000ms exceeded while waiting on the predicate
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
            - generic [ref=e22]: Farm — Monday, Sep 28 eggs
            - generic [ref=e23]: ·
            - generic [ref=e24]: "3"
            - button "details" [ref=e25] [cursor=pointer]
          - generic [ref=e26]:
            - textbox "send quantity for future:farm-egg:20260928t160000z" [ref=e27]: "2"
            - button "Send to Bob (token)" [ref=e28] [cursor=pointer]
            - textbox "redeem quantity for future:farm-egg:20260928t160000z" [ref=e29]: "2"
            - button "Redeem at farm" [ref=e30] [cursor=pointer]
        - generic [ref=e31]:
          - generic [ref=e32]: "Token to hand Bob (2 eggs) — normal Cashu bearer transfer:"
          - textbox [ref=e33]: cashuBo2FteCRodHRwczovL2dpZnRjYXJkLmNhc2h1LmV4Y2hhbmdlL2Zhcm1hdXggZnV0dXJlOmZhcm0tZWdnOjIwMjYwOTI4dDE2MDAwMHphdIGiYWlIAL4hb9q4yKVhcIGkYWECYXN423sic2VjcmV0IjoiMzA4ZDUwNDQ4ZDFjNDM5MmMyMmJiZTRmZTY4YTAxM2YwMTdhM2JmNTBiMDZhYTU0ZGUxNmQ0YzU1YzQ3YTdlMiIsInRhZ3MiOltbImZ1dHVyZSIsIjEiLCJodHRwczovL2dpZnRjYXJkLmNhc2h1LmV4Y2hhbmdlL2Zhcm0tY29uc29sZS90ZXJtcy80NDAzNGQ3ZTNkN2ZlODRlN2YyM2NhMTRiNzY4ZDZjZTMxNzkyMmI5OTNmNDEyYThmZGJkOWI1ZTNhYWEwMDljIl1dfWFjWCECSTW4QexHI5sYvUzawwSQpr0yQ60LraSlNhcj_WQZuRNhZKNhZVggtmY976DUOg2ct3yX8rZ52L7pu-aWt2QaTgymtlIuOk9hc1ggNR13mhySXc-aynK19r02UN6I1s1u2xFChkJZtQ-LEVJhclggnHh9ntbuRtLuRIublbgmv3md1NQCG5CkwjTPC97v214
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
            - option "Thursday, Sep 24 · 0 of 10 free"
            - option "Friday, Sep 25 · 0 of 10 free"
            - option "Saturday, Sep 26 · 0 of 10 free"
            - option "Sunday, Sep 27 · 0 of 10 free"
            - option "Monday, Sep 28 · 0 of 10 free" [selected]
            - option "Tuesday, Sep 29 · 10 of 10 free"
          - text: · 1000 signet sats / egg
      - generic [ref=e43]:
        - generic [ref=e44]:
          - generic [ref=e45]:
            - generic [ref=e46]: Quantity
            - textbox "egg quantity" [ref=e47]: "5"
          - generic [ref=e48]:
            - generic [ref=e49]: 5 eggs
            - generic [ref=e50]: 5000 signet sats
            - generic [ref=e51]: "Production: Monday, Sep 28Available for pickup: Mon, 28 Sep 2026 16:00:00 UTC"
        - generic [ref=e52]: YOU OWN — Farm eggs · 5 claims of future:farm-egg:20260928t160000z
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
  145 |         "FUTURE ROWS:",
  146 |         JSON.stringify(
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
  238 |     await expect
  239 |       .poll(async () => {
  240 |         const bobProofs = await readFutureProofs(bobPage)
  241 |         return bobProofs
  242 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  243 |           .reduce((sum, p) => sum + p.amount, 0)
  244 |       })
> 245 |       .toBe(2)
      |        ^ Error: expect(received).toBe(expected) // Object.is equality
  246 |     await bobContext.close()
  247 | 
  248 |     // Total supply unchanged by the transfer: issued unchanged.
  249 |     const transferred = (await farmOverview(page)).series.find((s) => s.date === series.date)
  250 |     expect(transferred?.issued).toBe(after?.issued ?? series.issued + 5)
  251 | 
  252 |     // ---------------------------------------------------------------
  253 |     // Redemption: mature the series (admin demo override), Bob's 2
  254 |     // claims burn at the counter against physical handover.
  255 |     // ---------------------------------------------------------------
  256 |     await apiLogin(page, FARM_BASE, FARM_ADMIN_PASSWORD || process.env.PECAN_ADMIN_PASSWORD || "")
  257 |     const mature = await page.request.post(`${FARM_BASE}/api/farm/series/${series.date}/mature-now`)
  258 |     expect(mature.status()).toBe(200)
  259 | 
  260 |     const bobContext2 = await browser.newContext()
  261 |     const bobPage2 = await bobContext2.newPage()
  262 |     await openFarmWallet(bobPage2)
  263 |     await bobPage2.getByPlaceholder(/paste a token/i).fill(token)
  264 |     await bobPage2.getByRole("button", { name: /Receive token/i }).click()
  265 |     await expect
  266 |       .poll(async () => {
  267 |         const bobProofs = await readFutureProofs(bobPage2)
  268 |         return bobProofs
  269 |           .filter((p) => p.unit === series.unit && p.state !== "spent")
  270 |           .reduce((sum, p) => sum + p.amount, 0)
  271 |       })
  272 |       .toBe(2)
  273 | 
  274 |     await bobPage2.getByLabel(`redeem quantity for ${series.unit}`).fill("2")
  275 |     await bobPage2.getByRole("button", { name: /Redeem at farm/i }).click()
  276 |     await expect(
  277 |       bobPage2.getByText(/teller code [0-9A-F]{6}/i),
  278 |     ).toBeVisible({ timeout: 60_000 })
  279 |     const code = await bobPage2.getByText(/teller code ([0-9A-F]{6})/i).textContent()
  280 |     const tail = code?.match(/([0-9A-F]{6})/)?.[1] ?? ""
  281 |     expect(tail).toHaveLength(6)
  282 | 
  283 |     // The admin session lives on Sarah's context — settle from there.
  284 |     const settled = await matchAndSettle(page, tail, "eggs handed over", FARM_BASE)
  285 |     expect(settled.unit).toBe(series.unit)
  286 |     expect(settled.amount).toBe(2)
  287 | 
  288 |     await expect
  289 |       .poll(async () => (await bobPage2.getByText(/FARM-/i).first().textContent()) ?? "")
  290 |       .toMatch(/FARM-/)
  291 |     await expect
  292 |       .poll(async () => (await farmOverview(page)).series.find((s) => s.date === series.date)?.redeemed ?? -1)
  293 |       .toBe(series.redeemed + 2)
  294 | 
  295 |     // Double redemption dies on spent proofs: Bob's own wallet no longer
  296 |     // shows the claims, so the melt cannot even lock inputs.
  297 |     const bobLeft = (await readFutureProofs(bobPage2)).filter(
  298 |       (p) => p.unit === series.unit && p.state !== "spent",
  299 |     )
  300 |     expect(bobLeft.reduce((sum, p) => sum + p.amount, 0)).toBe(0)
  301 |     await bobContext2.close()
  302 |   })
  303 | 
  304 |   test("capacity invariant: unpaid purchases reserve and expire", async ({ page }) => {
  305 |     test.setTimeout(120_000)
  306 |     const series = await firstOpenSeries(page)
  307 | 
  308 |     // An 11-egg claim cannot exist: the API refuses beyond capacity.
  309 |     const tooMany = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  310 |       data: {
  311 |         production_date: series.date,
  312 |         quantity: series.capacity + 1,
  313 |         pubkey: "02" + "cd".repeat(32),
  314 |       },
  315 |     })
  316 |     expect(tooMany.status()).toBeGreaterThanOrEqual(400)
  317 | 
  318 |     // Purchase everything that is left — the next one must fail.
  319 |     if (series.available > 0) {
  320 |       const grab = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  321 |         data: {
  322 |           production_date: series.date,
  323 |           quantity: series.available,
  324 |           pubkey: "02" + "ef".repeat(32),
  325 |         },
  326 |       })
  327 |       expect(grab.status()).toBe(200)
  328 |       const none = await page.request.post(`${FARM_BASE}/api/farm/futures/quote`, {
  329 |         data: {
  330 |           production_date: series.date,
  331 |           quantity: 1,
  332 |           pubkey: "02" + "ef".repeat(32),
  333 |         },
  334 |       })
  335 |       expect(none.status()).toBeGreaterThanOrEqual(400)
  336 |       expect((await none.json()).error).toContain("capacity")
  337 |     }
  338 |   })
  339 | 
  340 |   test("redemption before maturity is refused", async ({ page }) => {
  341 |     const series = (await farmOverview(page)).series.find((s) => !s.matured)
  342 |     if (!series) {
  343 |       test.skip(true, "no immature series left")
  344 |       return
  345 |     }
```