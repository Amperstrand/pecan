# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pw-boot.tmp.spec.ts >> pw boot probe
- Location: e2e/pw-boot.tmp.spec.ts:2:1

# Error details

```
TimeoutError: locator.click: Timeout 60000ms exceeded.
Call log:
  - waiting for getByRole('tab', { name: 'FARM' })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - main [ref=e3]:
    - generic [ref=e4]:
      - heading "Wallet" [level=1] [ref=e8]
      - tablist "Currency" [ref=e9]:
        - tab "EUR" [selected] [ref=e10]
        - tab "NOK" [ref=e11]
        - tab "USD" [ref=e12]
        - tab "SATS" [ref=e13]
    - generic [ref=e15]:
      - generic [ref=e16]: Balance
      - generic [ref=e17]: 0.00 €
    - generic [ref=e18]:
      - generic [ref=e19]:
        - generic [ref=e20]: Deposit
        - generic [ref=e23]: Mint ecash at the counter (teller) or over lightning.
      - generic [ref=e24]:
        - generic [ref=e25]:
          - button "Teller" [ref=e26]
          - button "Lightning" [ref=e27]
          - button "On-chain" [ref=e28]
        - generic [ref=e29]:
          - generic [ref=e30]: Amount (€)
          - spinbutton "Amount (€)" [ref=e31]
        - button "Create deposit quote" [disabled]
    - generic [ref=e32]:
      - generic [ref=e33]:
        - generic [ref=e34]: Withdraw
        - generic [ref=e37]: Send ecash to a recipient via the teller.
      - generic [ref=e38]:
        - tablist "Withdraw rail" [ref=e39]:
          - tab "Teller" [selected] [ref=e40]
          - tab "SEPA" [ref=e41]
          - tab "Instant" [ref=e42]
          - tab "Swish" [ref=e43]
          - tab "MobilePay" [ref=e44]
          - tab "iDEAL" [ref=e45]
          - tab "Bizum" [ref=e46]
          - tab "Sim" [ref=e47]
          - tab "Charger A" [ref=e48]
          - tab "Charger B" [ref=e49]
          - tab "Charger C" [ref=e50]
          - tab "Charger D" [ref=e51]
          - tab "Sim Charger" [ref=e52]
        - generic [ref=e53]:
          - generic [ref=e54]: Destination
          - textbox "Destination" [ref=e55]:
            - /placeholder: Phone or reference
        - generic [ref=e56]:
          - generic [ref=e57]: Amount (€)
          - spinbutton "Amount (€)" [ref=e58]
        - button "Send" [disabled]
    - generic [ref=e59]:
      - generic [ref=e60]:
        - generic [ref=e61]: Backup
        - generic [ref=e62]: Your money lives only in this browser. Download a fresh backup after every transaction — a backup goes stale the moment you spend.
      - generic [ref=e63]:
        - button "Download backup (JSON)" [ref=e64] [cursor=pointer]
        - button "Restore from backup…" [ref=e65] [cursor=pointer]
    - generic [ref=e66]:
      - generic [ref=e67]:
        - generic [ref=e68]: Developer Tools
        - generic [ref=e69]: Signet/test only. These actions are irreversible.
      - generic [ref=e70]:
        - button "Export wallet data (JSON)" [ref=e71] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e72] [cursor=pointer]
    - paragraph [ref=e73]:
      - text: Self-custodied — Coco 2 · keys stay in your browser.
      - link "Operator console" [ref=e74] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/
      - text: ·
      - link "Teller" [ref=e75] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/teller
  - region "Notifications alt+T"
```

# Test source

```ts
  1 | import { test } from "@playwright/test"
  2 | test("pw boot probe", async ({ page }) => {
  3 |   test.setTimeout(90_000)
  4 |   await page.goto("/wallet")
> 5 |   await page.getByRole("tab", { name: "FARM" }).click({ timeout: 60_000 })
    |                                                 ^ TimeoutError: locator.click: Timeout 60000ms exceeded.
  6 |   await page.getByLabel("production day").waitFor({ timeout: 30_000 })
  7 | })
  8 | 
```