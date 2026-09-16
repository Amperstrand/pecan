# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: charger-v.spec.ts >> charger V: virtual device session end to end (no hardware) @smoke
- Location: e2e/charger-v.spec.ts:16:1

# Error details

```
Error: metered delivery beats wall-clock

expect(received).toBeLessThan(expected)

Expected: < 30000
Received:   57467
```

# Page snapshot

```yaml
- generic [ref=f2e2]:
  - main [ref=f2e3]:
    - generic [ref=f2e4]:
      - heading "Wallet" [level=1] [ref=f2e8]
      - tablist "Currency" [ref=f2e9]:
        - tab "EUR" [selected] [ref=f2e10]
        - tab "NOK" [ref=f2e11]
        - tab "USD" [ref=f2e12]
        - tab "SATS" [ref=f2e13]
    - generic [ref=f2e15]:
      - generic [ref=f2e16]: Balance
      - generic [ref=f2e17]: 1.00 €
    - generic [ref=f2e18]:
      - generic [ref=f2e19]:
        - generic [ref=f2e20]: Deposit
        - generic [ref=f2e23]: Mint ecash at the counter (teller) or over lightning.
      - generic [ref=f2e24]:
        - generic [ref=f2e25]:
          - button "Teller" [ref=f2e26]
          - button "Lightning" [ref=f2e27]
          - button "On-chain" [ref=f2e28]
        - generic [ref=f2e29]:
          - generic [ref=f2e30]: Amount (€)
          - spinbutton "Amount (€)" [ref=f2e31]
        - button "Create deposit quote" [disabled]
    - generic [ref=f2e32]:
      - generic [ref=f2e33]:
        - generic [ref=f2e34]: Withdraw
        - generic [ref=f2e37]: Simulated charge point — an API, no hardware. Always on, even with the fleet unplugged. 1 unit = 1 kW·s.
      - generic [ref=f2e39]:
        - paragraph [ref=f2e40]: Charged 40 s at Sim Charger
        - paragraph [ref=f2e41]: €40.00 spent
        - paragraph [ref=f2e42]: EV-atomV-40s-800D3CAB
        - paragraph [ref=f2e43]: Session record — your proof of charging
        - button "New withdraw" [ref=f2e44] [cursor=pointer]
    - generic [ref=f2e45]:
      - generic [ref=f2e46]:
        - generic [ref=f2e47]: Backup
        - generic [ref=f2e48]: Your money lives only in this browser. Download a fresh backup after every transaction — a backup goes stale the moment you spend.
      - generic [ref=f2e49]:
        - button "Download backup (JSON)" [ref=f2e50] [cursor=pointer]
        - button "Restore from backup…" [ref=f2e51] [cursor=pointer]
    - generic [ref=f2e52]:
      - generic [ref=f2e53]: History
      - generic [ref=f2e56]:
        - generic [ref=f2e57]:
          - generic [ref=f2e58]: Withdraw
          - generic [ref=f2e62]: −40.00 €
        - generic [ref=f2e63]:
          - generic [ref=f2e64]: Deposit
          - generic [ref=f2e68]: +41.00 €
    - generic [ref=f2e69]:
      - generic [ref=f2e70]:
        - generic [ref=f2e71]: Developer Tools
        - generic [ref=f2e72]: Signet/test only. These actions are irreversible.
      - generic [ref=f2e73]:
        - button "Export wallet data (JSON)" [ref=f2e74] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=f2e75] [cursor=pointer]
    - paragraph [ref=f2e76]:
      - text: Self-custodied — Coco 2 · keys stay in your browser.
      - link "Operator console" [ref=f2e77] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/
      - text: ·
      - link "Teller" [ref=f2e78] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/teller
  - region "Notifications alt+T"
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test"
  2  | import { bootAndFund } from "./helpers/ev-rail"
  3  | import { readBalance } from "./helpers/wallet"
  4  | 
  5  | // Charger V (atomV) — the API-only virtual device (ev-virtual-charger.
  6  | // service on inr2). The whole charger story — melt, slider, delivered
  7  | // kW·s, receipt, refund of the unspent budget — with ZERO hardware:
  8  | // this lane is what keeps demos (and the @smoke fleet check) green while
  9  | // the physical boxes are down.
  10 | // Budget sized for METERED truth (#30): the car draws 3-10 kW, so a
  11 | // 40 kW·s budget completes in roughly 4-13 wall seconds — comfortably
  12 | // visible, and far faster than the 40 s a wall-clock contract would
  13 | // need, which is exactly what the elapsed-time assertion below pins.
  14 | const BUDGET = 40
  15 | 
  16 | test("charger V: virtual device session end to end (no hardware) @smoke", async ({ page }) => {
  17 |   // Internal waits (charge receipt, refund) budget up to 180s; the
  18 |   // default 60s test timeout would cut them off mid-wait.
  19 |   test.setTimeout(240_000)
  20 |   const WALLET = "https://giftcard.cashu.exchange/eur-console/wallet"
  21 |   await page.addInitScript(() => {
  22 |     window.localStorage.setItem("pecan-debug", "1")
  23 |     window.localStorage.setItem("pecan-currency", "eur")
  24 |   })
  25 |   // The charge point's QR is a deep link (?charger=atomV): the Sim
  26 |   // Charger rail must arrive preselected — scanning is the whole
  27 |   // interaction. Asserted on first boot and again after funding
  28 |   // (bootAndFund re-navigates to the plain wallet URL).
  29 |   await page.goto(`${WALLET}?charger=atomV`)
  30 |   await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible({ timeout: 30_000 })
  31 |   await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
  32 |     "aria-selected",
  33 |     "true",
  34 |   )
  35 |   await bootAndFund(page, "/eur-console", BUDGET + 1)
  36 |   const before = await readBalance(page)
  37 |   await page.goto(`${WALLET}?charger=atomV`)
  38 |   await expect(page.getByRole("tab", { name: "Sim Charger", exact: true })).toHaveAttribute(
  39 |     "aria-selected",
  40 |     "true",
  41 |   )
  42 | 
  43 |   const startedAt = Date.now()
  44 |   await page.getByPlaceholder("1.00").fill(String(BUDGET))
  45 |   await page.getByRole("button", { name: "Start charging" }).click()
  46 | 
  47 |   await expect(page.getByText("Charging at Sim Charger")).toBeVisible({ timeout: 60_000 })
  48 |   await expect(page.getByText(/Charged \d+ s at Sim Charger/)).toBeVisible({
  49 |     timeout: 180_000,
  50 |   })
  51 |   const receipt = await page.locator("p.break-all.font-mono").textContent()
  52 |   expect(receipt).toMatch(/^EV-atomV-\d+s-[0-9A-F]{8}/)
  53 |   const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  54 |   expect(delivered).toBe(BUDGET)
  55 |   // Metered proof: at the car's 3-10 kW draw the budget burns well
  56 |   // inside the wall-clock window — 30 s here rules out the legacy
  57 |   // constant-rate contract (which cannot finish a 40 kW·s budget in
  58 |   // under 40 s).
> 59 |   expect(Date.now() - startedAt, "metered delivery beats wall-clock").toBeLessThan(30_000)
     |                                                                       ^ Error: metered delivery beats wall-clock
  60 | 
  61 |   await expect
  62 |     .poll(async () => readBalance(page), { timeout: 200_000 })
  63 |     .toBeCloseTo(before - delivered, 2)
  64 | })
  65 | 
```