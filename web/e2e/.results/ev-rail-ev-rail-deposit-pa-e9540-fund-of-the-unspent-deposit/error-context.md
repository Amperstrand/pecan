# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ev-rail.spec.ts >> ev rail: deposit pattern — slider, remote stop, refund of the unspent deposit
- Location: e2e/ev-rail.spec.ts:166:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/€\d+\.00 of the deposit remaining/)
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for getByText(/€\d+\.00 of the deposit remaining/)

```

```yaml
- main:
  - img
  - heading "Wallet" [level=1]
  - tablist "Currency":
    - tab "EUR" [selected]
    - tab "NOK"
    - tab "USD"
    - tab "SATS"
    - tab "FARM"
  - text: Balance 9.00 €
  - img
  - text: Deposit Mint ecash at the counter (teller) or over lightning.
  - button "Teller"
  - button "Lightning"
  - button "On-chain"
  - text: Amount (€)
  - spinbutton "Amount (€)": "15"
  - button "Create deposit quote"
  - img
  - text: Withdraw Demo EV charger — 1 unit = 1 kW·s of charging, fires on send.
  - paragraph: Charged 18 s at Charger A
  - paragraph: €6.00 spent
  - paragraph: EV-atomA-18s-9BD801BD
  - paragraph: Session record — your proof of charging
  - button "New withdraw"
  - text: Backup Your money lives only in this browser. Download a fresh backup after every transaction — a backup goes stale the moment you spend.
  - button "Download backup (JSON)"
  - button "Restore from backup…"
  - text: History
  - img
  - text: Withdraw −6.00 €
  - img
  - text: Deposit +15.00 € Developer Tools Signet/test only. These actions are irreversible.
  - button "Export wallet data (JSON)"
  - button "Force clear wallet (downloads backup first)"
  - paragraph:
    - text: Self-custodied — Coco 2 · keys stay in your browser.
    - link "Operator console":
      - /url: https://giftcard.cashu.exchange/eur-console/
    - text: ·
    - link "Teller":
      - /url: https://giftcard.cashu.exchange/eur-console/teller
- region "Notifications alt+T"
```

# Test source

```ts
  84  | 
  85  | function deviceOnlineOn(topic: string): boolean {
  86  |   if (!MQTT.url) return false
  87  |   try {
  88  |     const out = execSync(
  89  |       `python3 -c '
  90  | import paho.mqtt.client as m, time, os
  91  | c = m.Client(m.CallbackAPIVersion.VERSION2, client_id="liveness-" + str(time.time()))
  92  | c.username_pw_set("${MQTT.user}", "${MQTT.pass}")
  93  | c.tls_set()
  94  | got = []
  95  | c.on_message = lambda cl,u,msg: got.append(bytes(msg.payload))
  96  | c.on_connect = lambda cl,u,f,rc,p=None: cl.subscribe("${topic}")
  97  | host = "${MQTT.url}".replace("mqtts://", "").split(":")[0].split("/")[0]
  98  | c.connect(host, 8883, 15)
  99  | c.loop_start()
  100 | deadline = time.time() + 12
  101 | while not got and time.time() < deadline:
  102 |     time.sleep(0.25)
  103 | c.loop_stop()
  104 | print(got[0].decode() if got else "unknown")
  105 | '`,
  106 |       { timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
  107 |     ).toString().trim()
  108 |     return out === "online"
  109 |   } catch {
  110 |     return false
  111 |   }
  112 | }
  113 | 
  114 | test("ev rail: charger C (T-Display S3) — window runs to done, refund exact", async ({ page }) => {
  115 |   test.setTimeout(300_000)
  116 |   const password = process.env.PECAN_ADMIN_PASSWORD
  117 |   test.skip(!password, "admin password unavailable")
  118 |   test.skip(!deviceOnline(), "charger offline (no box online)")
  119 | 
  120 |   await bootAndFund(page, "/eur-console", 4)
  121 |   await chargeCOnly(page, 3)
  122 | })
  123 | 
  124 | test("ev rail: charger B serves the same contract (atomB window)", async ({ page }) => {
  125 |   test.setTimeout(300_000)
  126 |   const consoleBase = "/eur-console"
  127 |   const password = process.env.PECAN_ADMIN_PASSWORD
  128 |   test.skip(!password, "admin password unavailable")
  129 |   test.skip(!deviceOnline(), "charger offline (Atom unplugged/wedged)")
  130 | 
  131 |   // The fleet is TWO chargers on one box; every other test rides A.
  132 |   // This pins B's relay path: melt → window on B → remote stop →
  133 |   // refund, with the receipt naming the device.
  134 |   const budget = 4
  135 |   await bootAndFund(page, consoleBase, budget + 1)
  136 | 
  137 |   const before = await readBalance(page)
  138 |   await page.getByRole("tab", { name: "Charger B", exact: true }).click()
  139 |   await page.getByPlaceholder("1.00").fill(String(budget))
  140 |   await page.getByRole("button", { name: "Start charging" }).click()
  141 | 
  142 |   await expect(page.getByText("⚡ Charging at Charger B")).toBeVisible({
  143 |     timeout: 60_000,
  144 |   })
  145 |   await expect
  146 |     .poll(
  147 |       async () =>
  148 |         Number(await page.getByRole("progressbar").getAttribute("aria-valuenow")),
  149 |       { timeout: 120_000 },
  150 |     )
  151 |     .toBeGreaterThanOrEqual(1)
  152 |   await page.getByRole("button", { name: "Stop charging" }).click()
  153 | 
  154 |   await expect(page.getByText(/Charging stopped — \d+ s delivered/)).toBeVisible({
  155 |     timeout: 180_000,
  156 |   })
  157 |   const receipt = await page.locator("p.break-all.font-mono").textContent()
  158 |   expect(receipt).toMatch(/^EV-atomB-[1-3]s-[0-9A-F]{8}-STOPPED$/)
  159 |   const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  160 | 
  161 |   await expect
  162 |     .poll(async () => readBalance(page), { timeout: 200_000 })
  163 |     .toBeCloseTo(before - delivered, 2)
  164 | })
  165 | 
  166 | test("ev rail: deposit pattern — slider, remote stop, refund of the unspent deposit", async ({ page }) => {
  167 |   test.setTimeout(300_000)
  168 |   const consoleBase = "/eur-console"
  169 |   const password = process.env.PECAN_ADMIN_PASSWORD
  170 |   test.skip(!password, "admin password unavailable")
  171 |   test.skip(!deviceOnline(), "charger offline (Atom unplugged/wedged)")
  172 | 
  173 |   const budget = 6
  174 |   await bootAndFund(page, consoleBase, budget + 1)
  175 | 
  176 |   const before = await readBalance(page)
  177 |   await page.getByRole("tab", { name: TAB, exact: true }).click()
  178 |   await expect(page.getByLabel("Destination")).toHaveCount(0)
  179 |   await page.getByPlaceholder("1.00").fill(String(budget))
  180 |   await page.getByRole("button", { name: "Start charging" }).click()
  181 | 
  182 |   // The slider appears and tracks delivery against the 6 s window.
  183 |   await expect(page.getByText("⚡ Charging at " + TAB)).toBeVisible({ timeout: 60_000 })
> 184 |   await expect(page.getByText(/€\d+\.00 of the deposit remaining/)).toBeVisible({
      |                                                                     ^ Error: expect(locator).toBeVisible() failed
  185 |     timeout: 30_000,
  186 |   })
  187 |   // Let a second deliver, then stop from the BROWSER — the stop must
  188 |   // reach the relay through the gateway (public, quote-id capability).
  189 |   await expect
  190 |     .poll(
  191 |       async () =>
  192 |         Number(await page.getByRole("progressbar").getAttribute("aria-valuenow")),
  193 |       { timeout: 120_000 },
  194 |     )
  195 |     .toBeGreaterThanOrEqual(1)
  196 |   await page.getByRole("button", { name: "Stop charging" }).click()
  197 | 
  198 |   // Stopped summary with actual consumption from the device-side abort.
  199 |   await expect(page.getByText(/Charging stopped — \d+ s delivered/)).toBeVisible({
  200 |     timeout: 180_000,
  201 |   })
  202 |   const receipt = await page.locator("p.break-all.font-mono").textContent()
  203 |   expect(receipt).toMatch(new RegExp(`^EV-${DEVICE}-[1-5]s-[0-9A-F]{8}-STOPPED$`))
  204 |   const delivered = Number(receipt!.match(/-(\d+)s-/)![1])
  205 | 
  206 |   // THE deposit-pattern assertion: the un-spent euros came back as a
  207 |   // refund quote the daemon settled — balance is exact, not approximate.
  208 |   await expect
  209 |     .poll(async () => readBalance(page), { timeout: 200_000 })
  210 |     .toBeCloseTo(before - delivered, 2)
  211 |   await expect(page.getByText(new RegExp(`€${delivered}\\.00 spent`))).toBeVisible()
  212 |   await expect(
  213 |     page.getByText(new RegExp(`€${budget - delivered}\\.00 refunded to your wallet`)),
  214 |   ).toBeVisible()
  215 | })
  216 | 
  217 | test("ev rail: device button abort meters actual delivery and refunds", async ({ page }) => {
  218 |   test.setTimeout(300_000)
  219 |   test.skip(!MQTT.url, "MQTT fixtures unavailable (run via scripts/e2e.sh)")
  220 |   // The button sim reacts to the device's LIVE start ack — with the box
  221 |   // unplugged there is no ack and the session degrades to TIMEOUT.
  222 |   test.skip(!deviceOnline(), "charger offline (Atom unplugged/wedged)")
  223 |   const consoleBase = "/eur-console"
  224 | 
  225 |   const budget = 4
  226 |   await bootAndFund(page, consoleBase, budget + 1)
  227 |   btnReady = false
  228 |   await pressDeviceButton(2)
  229 | 
  230 |   const before = await readBalance(page)
  231 |   await page.getByRole("tab", { name: TAB, exact: true }).click()
  232 |   await page.getByPlaceholder("1.00").fill(String(budget))
  233 |   await page.getByRole("button", { name: "Start charging" }).click()
  234 | 
  235 |   // The simulated G39 press aborts with 2 s delivered; the daemon
  236 |   // settles the STOPPED receipt and the wallet claims the refund.
  237 |   await expect(page.getByText("Charging stopped — 2 s delivered")).toBeVisible({
  238 |     timeout: 180_000,
  239 |   })
  240 |   const receipt = await page.locator("p.break-all.font-mono").textContent()
  241 |   expect(receipt).toMatch(new RegExp(`^EV-${DEVICE}-2s-[0-9A-F]{8}-STOPPED$`))
  242 |   await expect(page.getByText("€2.00 refunded to your wallet")).toBeVisible({
  243 |     timeout: 120_000,
  244 |   })
  245 |   await expect
  246 |     .poll(async () => readBalance(page), { timeout: 120_000 })
  247 |     .toBeCloseTo(before - 2, 2)
  248 | })
  249 | 
  250 | test("ev rail: malformed charger envelope and over-budget are refused", async ({ page }) => {
  251 |   test.setTimeout(180_000)
  252 |   const consoleBase = "/eur-console"
  253 |   const password = process.env.PECAN_ADMIN_PASSWORD
  254 |   test.skip(!password, "admin password unavailable")
  255 |   test.skip(!deviceOnline(), "charger offline (Atom unplugged/wedged)")
  256 |   await bootAndFund(page, consoleBase, 5)
  257 | 
  258 |   // A syntactically invalid device slug never becomes a ticket: the
  259 |   // quote-time gate refuses it and the wallet names the likely cause.
  260 |   await page.getByPlaceholder("Phone or reference").fill("ev:bogus!")
  261 |   await page.getByPlaceholder("1.00").fill("1")
  262 |   await page.getByRole("button", { name: "Send", exact: true }).click()
  263 |   await expect(page.getByText("the rail may not be enabled here")).toBeVisible({
  264 |     timeout: 30_000,
  265 |   })
  266 |   await expect(page.locator("p.font-mono.text-3xl")).toHaveCount(0)
  267 |   await page.getByRole("button", { name: "Try again" }).click()
  268 | 
  269 |   // A budget beyond the balance is refused client-side: no quote, no
  270 |   // code, the error names the balance.
  271 |   await page.getByPlaceholder("Phone or reference").fill("ev:atomA")
  272 |   await page.getByPlaceholder("1.00").fill("9999")
  273 |   await page.getByRole("button", { name: "Send", exact: true }).click()
  274 |   await expect(page.getByText(/not supported \(mint limit\)/)).toBeVisible()
  275 |   await expect(page.locator("p.font-mono.text-3xl")).toHaveCount(0)
  276 | })
  277 | 
  278 | test("ev rail: a mid-session reload resumes charging and still refunds", async ({ page }) => {
  279 |   test.setTimeout(300_000)
  280 |   const consoleBase = "/eur-console"
  281 |   const password = process.env.PECAN_ADMIN_PASSWORD
  282 |   test.skip(!password, "admin password unavailable")
  283 |   test.skip(!deviceOnline(), "charger offline (Atom unplugged/wedged)")
  284 |   await bootAndFund(page, consoleBase, 7)
```