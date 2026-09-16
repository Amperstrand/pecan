# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: farm.spec.ts >> farm futures (NUT-32 spike) >> sarah_buys_five_friday_eggs_with_signet
- Location: e2e/farm.spec.ts:103:3

# Error details

```
Error: lightning pay failed on all nodes:
cln-hub-signet: lightning pay via cln-hub-signet failed: 
cln-clboss-signet: lightning pay via cln-clboss-signet failed: 
cln-nostr-signet: lightning pay via cln-nostr-signet failed: 
cln-vls-signet: lightning pay via cln-vls-signet failed: 
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
    - generic [ref=e20]:
      - textbox "paste a token to receive eggs" [ref=e21]
      - button "Receive token" [ref=e22] [cursor=pointer]
    - generic [ref=e23]:
      - generic [ref=e24]:
        - generic [ref=e25]: FARM
        - generic [ref=e26]:
          - combobox "production day" [ref=e27]:
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
            - option "Sunday, Sep 27 · 5 of 10 free" [selected]
            - option "Monday, Sep 28 · 10 of 10 free"
            - option "Tuesday, Sep 29 · 10 of 10 free"
          - text: · 1000 signet sats / egg
      - generic [ref=e28]:
        - generic [ref=e29]:
          - generic [ref=e30]:
            - generic [ref=e31]: Quantity
            - textbox "egg quantity" [ref=e32]: "5"
          - generic [ref=e33]:
            - generic [ref=e34]: 5 eggs
            - generic [ref=e35]: 5000 signet sats
            - generic [ref=e36]: "Production: Sunday, Sep 27Available for pickup: Sun, 27 Sep 2026 16:00:00 UTC"
        - generic [ref=e37]:
          - generic [ref=e38]: Pay 5000 signet sats — waiting for payment
          - textbox [ref=e42]: lntbs50u1p4247pgsp5lefmrym6y3cju0nfev802zltrs53u05407tpmg22vsyl0tz8zwkqpp5prxusrqk6wp7p3xpkj302r0c88e8efmskfr5x88yn66y58883wkqdp6geshymfqxgcryd3dxquj6v3h8gsr2gr9vanjsuefypuzqvfsxqczqumpwsxqrpcgcqp2rzjq24p9s7hz42lhzxsh396ax482t6qvy5j23g76j5m248ykuuu83gcxp82avqqqjcqqqqqqqqqqqx0g3cqqc9qxpqysgqsjwsdsrgdfl9d5qmwme65rw8lh9py4e98wyfhkmz66rvfm70ez3938uu4dgl62gy3dg39tag2j4vy0uelzyrsxhqw3qdl4vw9flzgxsqpg50q4
          - button "Copy invoice" [ref=e43] [cursor=pointer]
        - button "verify terms" [ref=e45] [cursor=pointer]
        - group [ref=e46]:
          - generic "all series (14)" [ref=e47] [cursor=pointer]
    - generic [ref=e48]:
      - generic [ref=e49]:
        - generic [ref=e50]: Developer Tools
        - generic [ref=e51]: Signet/test only. These actions are irreversible.
      - generic [ref=e52]:
        - button "Export wallet data (JSON)" [ref=e53] [cursor=pointer]
        - button "Force clear wallet (downloads backup first)" [ref=e54] [cursor=pointer]
    - paragraph [ref=e55]: Self-custodied — Coco 2 · keys stay in your browser.
  - region "Notifications alt+T"
```

# Test source

```ts
  39  | }> {
  40  |   const matchResp = await page.request.post(`${base}/api/quotes/match`, {
  41  |     headers: { "Content-Type": "application/json" },
  42  |     data: { code: tellerCode },
  43  |   })
  44  |   const match = await matchResp.json()
  45  |   if (!match.id) {
  46  |     throw new Error(`match failed for ${tellerCode}: ${JSON.stringify(match).slice(0, 200)}`)
  47  |   }
  48  | 
  49  |   // Outgoing tickets sit in `waiting` until the wallet locks funds at the
  50  |   // mint — a swap-then-melt wallet needs two round trips, so poll until the
  51  |   // operator would actually be allowed to pay out.
  52  |   let ticket = match as { id: string; kind: string; status: string; amount: number }
  53  |   const deadline = Date.now() + 30_000
  54  |   while (ticket.status === "waiting" && Date.now() < deadline) {
  55  |     await page.waitForTimeout(500)
  56  |     const poll = await page.request.post(`${base}/api/quotes/match`, {
  57  |       headers: { "Content-Type": "application/json" },
  58  |       data: { code: tellerCode },
  59  |     })
  60  |     ticket = await poll.json()
  61  |   }
  62  |   if (ticket.status === "waiting") {
  63  |     throw new Error(`ticket ${match.id} never left 'waiting' (wallet did not lock funds)`)
  64  |   }
  65  | 
  66  |   const settleResp = await page.request.post(
  67  |     `${base}/api/tickets/${match.id}/mark-paid`,
  68  |     {
  69  |     headers: { "Content-Type": "application/json" },
  70  |     data: { notes },
  71  |   })
  72  |   if (settleResp.status() !== 200) {
  73  |     throw new Error(`mark-paid failed for ${match.id}: ${settleResp.status()} ${await settleResp.text()}`)
  74  |   }
  75  |   return settleResp.json()
  76  | }
  77  | 
  78  | // ---------------------------------------------------------------------------
  79  | // External wallet helpers (pay from lab nodes via SSH)
  80  | // ---------------------------------------------------------------------------
  81  | 
  82  | export function payLightningInvoiceFrom(node: string, invoice: string): string {
  83  |   let out: string
  84  |   try {
  85  |     out = execSync(
  86  |       `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet pay ${invoice}"`,
  87  |       { timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] },
  88  |     ).toString()
  89  |   } catch (err) {
  90  |     const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
  91  |     throw new Error(`lightning pay via ${node} failed: ${stderr.slice(0, 300)}`)
  92  |   }
  93  |   const match = out.match(/"payment_preimage":\s*"([0-9a-f]+)"/)
  94  |   if (!match) throw new Error(`payment did not complete: ${out.slice(0, 300)}`)
  95  |   return match[1]
  96  | }
  97  | 
  98  | /**
  99  |  * Decodes a bolt11 on a lab node to read back what the payer's wallet
  100 |  * shows — the invoice description must carry the exchange rate.
  101 |  */
  102 | export function decodeInvoiceDescription(invoice: string): string {
  103 |   let out: string
  104 |   try {
  105 |     out = execSync(
  106 |       `ssh root@46.224.104.12 "docker exec cln-hub-signet lightning-cli --network=signet decode ${invoice}"`,
  107 |       { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
  108 |     ).toString()
  109 |   } catch (err) {
  110 |     const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
  111 |     throw new Error(`bolt11 decode failed: ${stderr.slice(0, 300)}`)
  112 |   }
  113 |   const match = out.match(/"description":\s*"((?:[^"\\]|\\.)*)"/)
  114 |   if (!match) throw new Error(`no description in decode output: ${out.slice(0, 300)}`)
  115 |   return JSON.parse(`"${match[1]}"`) as string
  116 | }
  117 | 
  118 | /**
  119 |  * Pays from the lab nodes, failing over: the hub is usually the best
  120 |  * connected, but its channel to a given mint node can be locally
  121 |  * disabled (seen 2026-09-16: hub→farm mint channels dark, clboss fine).
  122 |  */
  123 | const LIGHTNING_PAYERS = [
  124 |   "cln-hub-signet",
  125 |   "cln-clboss-signet",
  126 |   "cln-nostr-signet",
  127 |   "cln-vls-signet",
  128 | ] as const
  129 | 
  130 | export function payLightningInvoice(invoice: string): string {
  131 |   const failures: string[] = []
  132 |   for (const node of LIGHTNING_PAYERS) {
  133 |     try {
  134 |       return payLightningInvoiceFrom(node, invoice)
  135 |     } catch (err) {
  136 |       failures.push(`${node}: ${err instanceof Error ? err.message : String(err)}`)
  137 |     }
  138 |   }
> 139 |   throw new Error(`lightning pay failed on all nodes:\n${failures.join("\n")}`)
      |         ^ Error: lightning pay failed on all nodes:
  140 | }
  141 | 
  142 | /**
  143 |  * Creates a bolt11 invoice on the hub node — the melt destination for
  144 |  * sat withdrawals (the wallet pays it, the lab node receives).
  145 |  */
  146 | export function createLightningInvoice(amountSat: number, label: string): string {
  147 |   let out: string
  148 |   try {
  149 |     out = execSync(
  150 |       `ssh root@46.224.104.12 "docker exec cln-hub-signet lightning-cli --network=signet invoice ${amountSat * 1000}msat pecan-${label} e2e"`,
  151 |       { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
  152 |     ).toString()
  153 |   } catch (err) {
  154 |     const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ""
  155 |     throw new Error(`invoice creation on cln-hub-signet failed: ${stderr.slice(0, 300)}`)
  156 |   }
  157 |   const match = out.match(/"bolt11":\s*"((?:[^"\\]|\\.)*)"/)
  158 |   if (!match) throw new Error(`no bolt11 in invoice output: ${out.slice(0, 300)}`)
  159 |   return match[1]
  160 | }
  161 | 
  162 | /**
  163 |  * Sends on-chain sats from a genuinely external lab wallet. The CLN nodes run
  164 |  * esplora chain mode; a withdraw can stall on slow esplora fetches, and
  165 |  * killing the RPC mid-flight strands the node's inputs as reserved for a long
  166 |  * block window — so we fail over across every lab wallet and keep the
  167 |  * timeout generous. €50 is the mint's onchain minimum, so each run burns
  168 |  * ~7.4k sat of payer liquidity; top the payers up from a signet faucet when
  169 |  * they run dry.
  170 |  */
  171 | const ONCHAIN_PAYERS = ["cln-hub-signet", "cln-vls-signet", "cln-nostr-signet"] as const
  172 | 
  173 | export function sendOnchainFromExternal(address: string, sat: number): string {
  174 |   const failures: string[] = []
  175 |   for (const node of ONCHAIN_PAYERS) {
  176 |     // Health probe first: a wedged RPC (the vls signer outage of
  177 |     // 2026-09-03) accepts the connection and then hangs, which would
  178 |     // burn the whole 300s withdraw budget on a dead node before the
  179 |     // failover ever reaches a healthy payer. getinfo must answer fast.
  180 |     try {
  181 |       execSync(
  182 |         `ssh -o ConnectTimeout=10 root@46.224.104.12 "timeout 15 docker exec ${node} lightning-cli --network=signet getinfo"`,
  183 |         { timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] },
  184 |       )
  185 |     } catch (err) {
  186 |       const e = err as { stderr?: Buffer; stdout?: Buffer }
  187 |       failures.push(
  188 |         `${node}: RPC unhealthy, skipped (${`${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 160)})`,
  189 |       )
  190 |       continue
  191 |     }
  192 |     let out: string
  193 |     try {
  194 |       // Feerate is PINNED, not estimated: signet fee estimates
  195 |       // occasionally explode (observed 4.28M sat/kB on 2026-09-04 —
  196 |       // every payer answered "0 available UTXOs, 184k sats short" while
  197 |       // holding healthy balances). A 1.5k/kw floor-rate tx always
  198 |       // propagates; the deposit is esplora-watched, not fee-raced.
  199 |       out = execSync(
  200 |         `ssh root@46.224.104.12 "docker exec ${node} lightning-cli --network=signet withdraw ${address} ${sat}sat 1500perkw"`,
  201 |         { timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] },
  202 |       ).toString()
  203 |     } catch (err) {
  204 |       const e = err as { stderr?: Buffer; stdout?: Buffer }
  205 |       // lightning-cli reports RPC errors on stdout; keep both for diagnosis
  206 |       failures.push(
  207 |         `${node}: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 300)}`,
  208 |       )
  209 |       continue
  210 |     }
  211 |     const match = out.match(/"txid":\s*"([0-9a-f]+)"/)
  212 |     if (!match) {
  213 |       failures.push(`${node}: no txid in output: ${out.slice(0, 300)}`)
  214 |       continue
  215 |     }
  216 |     return match[1]
  217 |   }
  218 |   throw new Error(`onchain withdraw failed on all payers:\n${failures.join("\n")}`)
  219 | }
  220 | 
  221 | // ---------------------------------------------------------------------------
  222 | // Wallet UI helpers (coco wallet at /console/wallet)
  223 | // ---------------------------------------------------------------------------
  224 | 
  225 | export async function readBalance(page: Page): Promise<number> {
  226 |   // Balance renders as a sibling of the "Balance" label inside a card header;
  227 |   // it shows "… €" until the wallet initializes, so retry until a number
  228 |   // appears — a NaN here would poison every later `before ± amount` check.
  229 |   const el = page.locator('.text-4xl.tabular-nums')
  230 |   await el.waitFor({ state: "visible", timeout: 20_000 })
  231 |   // A currency switch re-renders the figure asynchronously; guard against
  232 |   // reading the previous currency's number under the new tab (a stale read
  233 |   // once poisoned a `before + amount` baseline and cost a full suite run).
  234 |   const activeTab = await page
  235 |     .locator('[role="tablist"][aria-label="Currency"] [aria-selected="true"]')
  236 |     .textContent()
  237 |     .catch(() => null)
  238 |   const expectedSymbol = activeTab ? CURRENCY_SYMBOLS[activeTab.trim()] : undefined
  239 |   const deadline = Date.now() + 20_000
```