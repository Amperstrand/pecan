# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: wallet.spec.ts >> EUR wallet E2E (teller + lightning + on-chain) >> onchain deposit: external wallet → mempool → settled → receipt
- Location: e2e/wallet.spec.ts:38:3

# Error details

```
TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('p.font-mono:has-text("tb1")') to be visible

```

```
Error: wallet console errors:
  - console: Failed to load resource: the server responded with a status of 400 () (https://giftcard.cashu.exchange/eur/v1/mint/quote/btc)
  - console: deposit failed: MintOperationError: Invalid payment request
    at fre.performFetch (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js:110:354317)
    at async request (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js:110:353337)
    at async u6.createMintQuote (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js:110:77121)
    at async e.createMintQuote (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js:110:142892)
    at async v9.createQuote (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js:112:180265)
    at async cie.createMintQuote (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js:110:450716) (https://giftcard.cashu.exchange/eur-console/assets/index-Dl76604l.js)
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
      - generic [ref=e17]: 1.00 €
    - generic [ref=e18]:
      - generic [ref=e19]:
        - generic [ref=e20]: Deposit
        - generic [ref=e23]: Mint ecash at the counter (teller) or over lightning.
      - generic [ref=e25]:
        - paragraph [ref=e26]: The mint rejected this deposit. The quote may have expired, the mint may have been reset, or the currency unit may have changed. Try cancelling any pending deposits and creating a fresh one.
        - button "Try again" [ref=e27] [cursor=pointer]
    - generic [ref=e28]:
      - generic [ref=e29]:
        - generic [ref=e30]: Withdraw
        - generic [ref=e33]: Send ecash to a recipient via the teller.
      - generic [ref=e34]:
        - tablist "Withdraw rail" [ref=e35]:
          - tab "Teller" [selected] [ref=e36]
          - tab "SEPA" [ref=e37]
          - tab "Instant" [ref=e38]
          - tab "Swish" [ref=e39]
          - tab "MobilePay" [ref=e40]
          - tab "iDEAL" [ref=e41]
          - tab "Bizum" [ref=e42]
          - tab "Sim" [ref=e43]
          - tab "Charger A" [ref=e44]
          - tab "Charger B" [ref=e45]
          - tab "Charger C" [ref=e46]
          - tab "Charger D" [ref=e47]
          - tab "Sim Charger" [ref=e48]
        - generic [ref=e49]:
          - generic [ref=e50]: Destination
          - textbox "Destination" [ref=e51]:
            - /placeholder: Phone or reference
            - text: e2e-eur
        - generic [ref=e52]:
          - generic [ref=e53]: Amount (€)
          - spinbutton "Amount (€)" [ref=e54]: "5"
        - generic [ref=e55]:
          - paragraph [ref=e56]: E2E eur payout
          - paragraph [ref=e57]: Receipt — your proof of payment
          - button "New withdraw" [ref=e58] [cursor=pointer]
    - generic [ref=e59]:
      - generic [ref=e60]:
        - generic [ref=e61]: Backup
        - generic [ref=e62]: Your money lives only in this browser. Download a fresh backup after every transaction — a backup goes stale the moment you spend.
      - generic [ref=e63]:
        - button "Download backup (JSON)" [ref=e64] [cursor=pointer]
        - button "Restore from backup…" [ref=e65] [cursor=pointer]
    - generic [ref=e66]:
      - generic [ref=e67]: History
      - generic [ref=e70]:
        - generic [ref=e71]:
          - generic [ref=e72]: Withdraw
          - generic [ref=e76]: −5.00 €
        - generic [ref=e77]:
          - generic [ref=e78]: Deposit
          - generic [ref=e82]: +1.00 €
        - generic [ref=e83]:
          - generic [ref=e84]: Deposit
          - generic [ref=e88]: +5.00 €
    - generic [ref=e89]:
      - generic [ref=e90]:
        - generic [ref=e91]: Developer Tools
        - generic [ref=e92]: Signet/test only. These actions are irreversible.
      - generic [ref=e93]:
        - button "Export wallet data (JSON)" [ref=e94] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e95] [cursor=pointer]
    - paragraph [ref=e96]:
      - text: Self-custodied — Coco 2 · keys stay in your browser.
      - link "Operator console" [ref=e97] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/
      - text: ·
      - link "Teller" [ref=e98] [cursor=pointer]:
        - /url: https://giftcard.cashu.exchange/eur-console/teller
  - region "Notifications alt+T"
```