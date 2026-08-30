# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: wallet.spec.ts >> EUR wallet E2E (teller + lightning + on-chain) >> onchain deposit: external wallet → mempool → 1-conf → receipt
- Location: e2e/wallet.spec.ts:93:3

# Error details

```
Error: onchain withdraw failed: 
```

# Test source

```ts
  1   | import { execSync } from "node:child_process"
  2   | import { expect, type Page } from "@playwright/test"
  3   | 
  4   | // ---------------------------------------------------------------------------
  5   | // Teller API helpers (operator side of the branch method)
  6   | // ---------------------------------------------------------------------------
  7   | 
  8   | export async function apiLogin(page: Page): Promise<void> {
  9   |   const password = process.env.PECAN_ADMIN_PASSWORD
  10  |   if (!password) {
  11  |     throw new Error(
  12  |       "PECAN_ADMIN_PASSWORD is not set — fetch the generated admin password " +
  13  |         "(scripts/e2e.sh does this) before running the suite",
  14  |     )
  15  |   }
  16  |   const resp = await page.request.post(`/api/login`, {
  17  |     headers: { "Content-Type": "application/json" },
  18  |     data: { username: "admin", password },
  19  |   })
  20  |   if (resp.status() !== 200) throw new Error(`admin login failed: ${resp.status()}`)
  21  | }
  22  | 
  23  | export async function matchAndSettle(
  24  |   page: Page,
  25  |   tellerCode: string,
  26  |   notes: string,
  27  | ): Promise<{ id: string; kind: string; status: string; amount: number }> {
  28  |   const matchResp = await page.request.post(`/api/quotes/match`, {
  29  |     headers: { "Content-Type": "application/json" },
  30  |     data: { code: tellerCode },
  31  |   })
  32  |   const match = await matchResp.json()
  33  |   if (!match.id) {
  34  |     throw new Error(`match failed for ${tellerCode}: ${JSON.stringify(match).slice(0, 200)}`)
  35  |   }
  36  |   const settleResp = await page.request.post(`/api/tickets/${match.id}/mark-paid`, {
  37  |     headers: { "Content-Type": "application/json" },
  38  |     data: { notes },
  39  |   })
  40  |   if (settleResp.status() !== 200) {
  41  |     throw new Error(`mark-paid failed for ${match.id}: ${settleResp.status()} ${await settleResp.text()}`)
  42  |   }
  43  |   return settleResp.json()
  44  | }
  45  | 
  46  | // ---------------------------------------------------------------------------
  47  | // External wallet helpers (pay from lab nodes via SSH)
  48  | // ---------------------------------------------------------------------------
  49  | 
  50  | export function payLightningInvoiceFrom(node: string, invoice: string): string {
  51  |   let out: string
  52  |   try {
  53  |     out = execSync(
  54  |       `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`,
  55  |       { timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] },
  56  |     ).toString()
  57  |   } catch (err) {
  58  |     const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
  59  |     throw new Error(`lightning pay via ${node} failed: ${stderr.slice(0, 300)}`)
  60  |   }
  61  |   const match = out.match(/"payment_preimage":\s*"([0-9a-f]+)"/)
  62  |   if (!match) throw new Error(`payment did not complete: ${out.slice(0, 300)}`)
  63  |   return match[1]
  64  | }
  65  | 
  66  | /** Pays from the hub node (well-connected, multiple channels). */
  67  | export function payLightningInvoice(invoice: string): string {
  68  |   return payLightningInvoiceFrom("cln-hub-signet", invoice)
  69  | }
  70  | 
  71  | /** Sends on-chain sats from the nostr node — a genuinely external wallet. */
  72  | export function sendOnchainFromExternal(address: string, sat: number): string {
  73  |   let out: string
  74  |   try {
  75  |     out = execSync(
  76  |       `ssh root@46.224.104.12 "docker exec cln-nostr-signet lightning-cli --network=signet withdraw ${address} ${sat}sat normal"`,
  77  |       { timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  78  |     ).toString()
  79  |   } catch (err) {
  80  |     const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
> 81  |     throw new Error(`onchain withdraw failed: ${stderr.slice(0, 300)}`)
      |           ^ Error: onchain withdraw failed: 
  82  |   }
  83  |   const match = out.match(/"txid":\s*"([0-9a-f]+)"/)
  84  |   if (!match) throw new Error(`withdraw produced no txid: ${out.slice(0, 300)}`)
  85  |   return match[1]
  86  | }
  87  | 
  88  | // ---------------------------------------------------------------------------
  89  | // Wallet UI helpers (coco wallet at /console/wallet)
  90  | // ---------------------------------------------------------------------------
  91  | 
  92  | export async function clearWalletDb(page: Page): Promise<void> {
  93  |   await page.evaluate(async () => {
  94  |     indexedDB.deleteDatabase("giftcard-coco-wallet")
  95  |     localStorage.removeItem("giftcard-coco-seed-v1")
  96  |   })
  97  |   await page.reload()
  98  | }
  99  | 
  100 | export async function readBalance(page: Page): Promise<number> {
  101 |   // Balance renders as a sibling of the "Balance" label inside a card header
  102 |   const el = page.locator('.text-4xl.tabular-nums')
  103 |   await el.waitFor({ state: "visible", timeout: 20_000 })
  104 |   const text = await el.textContent()
  105 |   return parseFloat(text!.replace(/[^\d.]/g, ""))
  106 | }
  107 | 
  108 | /**
  109 |  * The 6-character code shown under "Give this code to the teller:" for both
  110 |  * deposits (MINT-… quote tail) and withdrawals (MELT-… quote tail).
  111 |  */
  112 | export async function readTellerCode(page: Page): Promise<string> {
  113 |   const code = page.locator("p.font-mono.text-3xl")
  114 |   await code.waitFor({ state: "visible", timeout: 30_000 })
  115 |   const text = (await code.textContent())?.trim() ?? ""
  116 |   if (!/^[A-Z0-9]{6}$/.test(text)) {
  117 |     throw new Error(`expected 6-char teller code, got: "${text}"`)
  118 |   }
  119 |   return text
  120 | }
  121 | 
  122 | export async function waitForDepositFormReset(
  123 |   page: Page,
  124 |   buttonName = "Create deposit quote",
  125 | ): Promise<void> {
  126 |   await page
  127 |     .getByRole("button", { name: buttonName })
  128 |     .waitFor({ state: "visible", timeout: 45_000 })
  129 | }
  130 | 
  131 | // ---------------------------------------------------------------------------
  132 | // Console/page error gate — the wallet itself must run clean
  133 | // ---------------------------------------------------------------------------
  134 | 
  135 | export function trackWalletErrors(page: Page): string[] {
  136 |   const errors: string[] = []
  137 |   page.on("console", (msg) => {
  138 |     if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
  139 |   })
  140 |   page.on("pageerror", (err) => errors.push(`pageerror: ${String(err)}`))
  141 |   return errors
  142 | }
  143 | 
  144 | export function expectNoWalletErrors(errors: string[]): void {
  145 |   if (errors.length > 0) {
  146 |     throw new Error(`wallet console errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  147 |   }
  148 | }
  149 | 
  150 | // ---------------------------------------------------------------------------
  151 | // IndexedDB inspection — prove self-custody state (proofs, operations)
  152 | // ---------------------------------------------------------------------------
  153 | 
  154 | interface IdbProofState {
  155 |   proofCount: number
  156 |   proofSum: number
  157 |   /** Sum of proofs not marked spent — spent proofs stay in the store as history. */
  158 |   spendableSum: number
  159 |   mintOps: Array<{ state: string; quoteTail: string }>
  160 |   meltOps: Array<{ state: string; quoteTail: string }>
  161 | }
  162 | 
  163 | export async function readWalletDb(page: Page): Promise<IdbProofState> {
  164 |   return page.evaluate(async () => {
  165 |     const db = await new Promise<IDBDatabase>((resolve, reject) => {
  166 |       const req = indexedDB.open("giftcard-coco-wallet")
  167 |       req.onsuccess = () => resolve(req.result)
  168 |       req.onerror = () => reject(req.error)
  169 |     })
  170 |     const getAll = (store: string) =>
  171 |       new Promise<unknown[]>((resolve) => {
  172 |         const tx = db.transaction(store, "readonly")
  173 |         const req = tx.objectStore(store).getAll()
  174 |         req.onsuccess = () => resolve(req.result)
  175 |         req.onerror = () => resolve([])
  176 |       })
  177 |     const rows = (await getAll("coco_cashu_proofs")) as Array<{
  178 |       amount?: number | string
  179 |       state?: string
  180 |       proof?: { amount?: number | string }
  181 |     }>
```