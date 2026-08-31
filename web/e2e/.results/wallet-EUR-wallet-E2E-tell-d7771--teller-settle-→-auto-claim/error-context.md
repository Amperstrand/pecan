# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: wallet.spec.ts >> EUR wallet E2E (teller + lightning + on-chain) >> teller deposit: quote → teller settle → auto-claim
- Location: e2e/wallet.spec.ts:89:3

# Error details

```
Error: admin login failed: 404
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
  8   | export async function apiLogin(
  9   |   page: Page,
  10  |   base = "",
  11  |   password = process.env.PECAN_ADMIN_PASSWORD,
  12  | ): Promise<void> {
  13  |   if (!password) {
  14  |     throw new Error(
  15  |       "PECAN_ADMIN_PASSWORD is not set — fetch the generated admin password " +
  16  |         "(scripts/e2e.sh does this) before running the suite",
  17  |     )
  18  |   }
  19  |   void password
  20  |   const resp = await page.request.post(`${base}/api/login`, {
  21  |     headers: { "Content-Type": "application/json" },
  22  |     data: { username: "admin", password },
  23  |   })
> 24  |   if (resp.status() !== 200) throw new Error(`admin login failed: ${resp.status()}`)
      |                                    ^ Error: admin login failed: 404
  25  | }
  26  | 
  27  | export async function matchAndSettle(
  28  |   page: Page,
  29  |   tellerCode: string,
  30  |   notes: string,
  31  |   base = "",
  32  | ): Promise<{
  33  |   id: string
  34  |   kind: string
  35  |   status: string
  36  |   amount: number
  37  |   unit?: string
  38  | }> {
  39  |   const matchResp = await page.request.post(`${base}/api/quotes/match`, {
  40  |     headers: { "Content-Type": "application/json" },
  41  |     data: { code: tellerCode },
  42  |   })
  43  |   const match = await matchResp.json()
  44  |   if (!match.id) {
  45  |     throw new Error(`match failed for ${tellerCode}: ${JSON.stringify(match).slice(0, 200)}`)
  46  |   }
  47  | 
  48  |   // Outgoing tickets sit in `waiting` until the wallet locks funds at the
  49  |   // mint — a swap-then-melt wallet needs two round trips, so poll until the
  50  |   // operator would actually be allowed to pay out.
  51  |   let ticket = match as { id: string; kind: string; status: string; amount: number }
  52  |   const deadline = Date.now() + 30_000
  53  |   while (ticket.status === "waiting" && Date.now() < deadline) {
  54  |     await page.waitForTimeout(500)
  55  |     const poll = await page.request.post(`${base}/api/quotes/match`, {
  56  |       headers: { "Content-Type": "application/json" },
  57  |       data: { code: tellerCode },
  58  |     })
  59  |     ticket = await poll.json()
  60  |   }
  61  |   if (ticket.status === "waiting") {
  62  |     throw new Error(`ticket ${match.id} never left 'waiting' (wallet did not lock funds)`)
  63  |   }
  64  | 
  65  |   const settleResp = await page.request.post(
  66  |     `${base}/api/tickets/${match.id}/mark-paid`,
  67  |     {
  68  |     headers: { "Content-Type": "application/json" },
  69  |     data: { notes },
  70  |   })
  71  |   if (settleResp.status() !== 200) {
  72  |     throw new Error(`mark-paid failed for ${match.id}: ${settleResp.status()} ${await settleResp.text()}`)
  73  |   }
  74  |   return settleResp.json()
  75  | }
  76  | 
  77  | // ---------------------------------------------------------------------------
  78  | // External wallet helpers (pay from lab nodes via SSH)
  79  | // ---------------------------------------------------------------------------
  80  | 
  81  | export function payLightningInvoiceFrom(node: string, invoice: string): string {
  82  |   let out: string
  83  |   try {
  84  |     out = execSync(
  85  |       `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`,
  86  |       { timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] },
  87  |     ).toString()
  88  |   } catch (err) {
  89  |     const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
  90  |     throw new Error(`lightning pay via ${node} failed: ${stderr.slice(0, 300)}`)
  91  |   }
  92  |   const match = out.match(/"payment_preimage":\s*"([0-9a-f]+)"/)
  93  |   if (!match) throw new Error(`payment did not complete: ${out.slice(0, 300)}`)
  94  |   return match[1]
  95  | }
  96  | 
  97  | /** Pays from the hub node (well-connected, multiple channels). */
  98  | export function payLightningInvoice(invoice: string): string {
  99  |   return payLightningInvoiceFrom("cln-hub-signet", invoice)
  100 | }
  101 | 
  102 | /**
  103 |  * Sends on-chain sats from a genuinely external lab wallet. The CLN nodes run
  104 |  * esplora chain mode; a withdraw can stall on slow esplora fetches, and
  105 |  * killing the RPC mid-flight strands the node's inputs as reserved for a long
  106 |  * block window — so we fail over across every lab wallet and keep the
  107 |  * timeout generous. €50 is the mint's onchain minimum, so each run burns
  108 |  * ~7.4k sat of payer liquidity; top the payers up from a signet faucet when
  109 |  * they run dry.
  110 |  */
  111 | const ONCHAIN_PAYERS = ["cln-hub-signet", "cln-vls-signet", "cln-nostr-signet"] as const
  112 | 
  113 | export function sendOnchainFromExternal(address: string, sat: number): string {
  114 |   const failures: string[] = []
  115 |   for (const node of ONCHAIN_PAYERS) {
  116 |     let out: string
  117 |     try {
  118 |       out = execSync(
  119 |         `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet withdraw ${address} ${sat}sat normal"`,
  120 |         { timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
  121 |       ).toString()
  122 |     } catch (err) {
  123 |       const e = err as { stderr?: Buffer; stdout?: Buffer }
  124 |       // lightning-cli reports RPC errors on stdout; keep both for diagnosis
```