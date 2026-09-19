# Pecan + EV rail — status, limitations, and where to go next

Snapshot: 2026-09-17 (NUT-32 egg-futures spike landed — a fourth `farm`
pair with dated `future:farm-egg:<maturity>` series, wallet-bound
issuance against real signet payments, bearer transfer, teller
redemption; see docs/egg-futures-spike.md). Live at
https://giftcard.cashu.exchange. This is the honest map of what works,
what is known-broken or limited, and the ranked backlog. Keep it current
when the picture changes.

Update 2026-09-18 (farm-ux round): the farm pair is now an **egg
vending machine** — the day's eggs sell for the whole production day
(same-day purchase at any hour; sales close at UTC midnight), and
redemption is **claim-it-or-lose-it**: claims are collectable 24/7
on, and only on, their production date. Delivery is best-effort
(imaginary eggs); what actually happened at handover is recorded on
the settle (delivered + free-form condition — the exploration hook
for broken/out-of-stock studies). The /redeem **claims portal** shares
the wallet's redemption flow (one module, two faces: self-service and
teller console) with a paste-code path and date-aware verdict; the
wallet links to it. Purchase resume: a page closed between payment
and mint no longer orphans the purchase. Supply hygiene: autopay pays
only demo-sized purchases (a paid capacity-test grab once locked a
whole day for 24h), the capacity e2e grabs the horizon's last day,
future series capacity is 100k. `make farm-demo` runs the whole story
in a visible browser. e2e 4 green + 1 skip pending coco's addMint
keyset debt (fresh-context main-thread wedge). Known noise: farm
reconcile writes off two stale classes as notes (09-17 campaign
debris) — verdict PASS.

Update 2026-09-19 (virtual delivery round): **/redeem serves at the
domain root** (it used to answer with the parked marketing page —
also the real cause of the early "kiosk e2e ghosts") and redemption
there is fully self-service: a `virtual:screen` melt envelope routes
the ticket to the virtual rail, the processor re-runs the redemption
gate when the wallet locks proofs, auto-setttes with receipt
`FARM-VIRTUAL-…` and the delivery line recording "delivered on
screen" — no teller code, no operator — and the kiosk pops the eggs
in animated. Counter handover remains (wallet panel + kiosk secondary
button). The Caddyfile is repo-tracked (`deploy/Caddyfile.giftcard`)
and api-smoke now FAILS if the live wallet bundle loses the farm
panel — a concurrent deployer on the network reverted it twice
(09-17, 09-19 14:12 UTC); finding/stopping that pipeline is an open
ops item. Also fixed: `next-friday` u32 underflow on weekends, and
farm unit tests re-dated to relative days. Verification: 102
processor tests, vitest 83, farm e2e 5/5 (sarah incl. counter
delivery-line settle, capacity, same-day window, purchase resume,
autopay-fast projection self-heal); the portal e2e
(farm-portal.spec.ts) passed end-to-end once (20s) and is skip-pinned
on coco's fresh-context boot wedge — **fixing coco's addMint keyset
crawl is the top-ranked next work**: demo first-load, kiosk import,
and e2e stability all collapse onto it.

## Architecture snapshot

| Piece | Version / state | Notes |
|---|---|---|
| cdk-mintd (all pairs) | **0.18.0 final** (upgraded from rc.3 2026-09-03) | DB-backed config; pre-upgrade DBs in `/root/backups/*-pre-0.18.0.sqlite` |
| pecan processor | deployment branch | EUR + USD + NOK pairs, ev rail on every fiat pair (8 payout rails each); CSP whitelists signut (https+wss) |
| Wallet (coco 2) | same deploy | rail picker, deposit-pattern chargers, mint-call timeouts, reload-resume, **sat mode (bolt11, signut)** |
| SAT mint | external: signut.cashu.exchange (Nutshell-CF) | bolt11+sat only, NUT-17 off (ws 410 → blackhole factory), CORS open; no console, no pecan rails |
| ev-charge daemon | inr2 systemd, one per fiat pair (`ev-charge`, `-usd`, `-nok`) | watch mode: settle, expiry guards, at-most-once trigger, refund ledger |
| atom-gateway | inr2 systemd `atom-bridge.service` | public session endpoints (ref = capability), remote stop, delivered metering |
| Charger firmware | **charger-stick-slint (Rust+Slint)** — M5Stick Plus LIVE 2026-09-05 (evmap `af24ed0`); `tdisplay-s3` profile (charger C, LILYGO T-Display S3) compile-verified, awaiting board bring-up | MQTT byte-parity family; see FLASHING.md (USB-only at 92-95% flash: no OTA slots on 4MB; ESPHome sibling keeps wifi-OTA) |
| Charger C rail | **LIVE on REAL hardware** 2026-09-07 (pecan `720d8a8`, evmap `5a446bf`): LILYGO T-Display S3 flashed, contract + charger C e2e green; atomC needs zero backend wiring (slug passthrough) | Display+backlight-blink is the indicator (no relay/buzzer on that board); sim serves atomA/B only while the M5Stick is away |
| Deploy lane | `scripts/deploy.sh` → build on ai-legion-small → inr2 | one `pecan:deployment` tag for all pairs; also syncs /opt/pecan-tools (reconcile + pairs.sh) |

## Verified working (evidence in the repo)

- **Teller rails**: deposits, withdrawals, human settle — the full suite
  has run green for months; smoke tier passes in ~25 s after every deploy.
- **Simulated fiat rails**: sim/sepa/sepa-instant/swish/mobilepay/ideal/
  bizum autosim settlements with scheme receipts (e2e-covered).
- **The deposit pattern (the commercial charger shape)**: melt a budget
  → live slider (delivered ↑, remaining € ↓) → Stop from the browser OR
  the device button → STOPPED receipt with actual delivered → refund as
  a locked mint quote validated against the daemon's delivery ledger →
  balance exact. E2e green repeatedly (~30 s, zero sat). OCPP mapping:
  trigger = RemoteStart, delivered = meterStop−meterStart, refund =
  settlement reversal.
- **Overshoot-as-change recovery**: proven by a live €11 melt
  (inputs 2048 → spent 1100 + change 948 re-served on quote check).
- **Fee control**: the exact-amount pre-swap is input consolidation —
  measured €4.24 per-proof fee cost without it; restored and unit-pinned.
- **Ops**: reconcile clean; caddy reload fixed (systemd PrivateTmp
  recreation after the disk-full /tmp wipe); password/fixture fetching
  automated in `scripts/e2e.sh`.

## Hygiene round 2026-09-15

A duplication audit (pair list hand-enumerated in six scripts; compose
image tags scrambled) found gaps that were live risks, all closed and
verified in one deploy:

- **Canonical pair manifest** — `scripts/pairs.sh` (POSIX, bash-3.2
  safe) is the one table of per-pair facts (compose paths, server dirs,
  password files/env names, containers, mint dirs). deploy.sh,
  api-smoke.sh, e2e.sh, rails-audit.sh, mint-backup.sh, and
  reconcile-server.sh all consume it; deploy.sh rsyncs it to
  /opt/pecan-tools with the reconcile scripts (the server copy can no
  longer lag the repo).
- **NOK was outside every operational net** (the audit's top finding):
  not in the encrypted mint backup, not in api-smoke, not in
  reconcile, not in rails-audit — all fixed from the manifest. First
  post-fix backup decrypt-verified with all three pairs' seeds
  (compose + mint.toml + sqlite + .env each); reconcile-status.json
  now gates nok; api-smoke prints the nok section.
- **One image tag** (#22 closed): the three composes referenced a
  scrambled mix (`prod.yml` said `pecan:nok`, `nok.yml` said
  `pecan:eur`) that only worked because deploy.sh retagged one build
  into every name. Now a single `pecan:deployment` tag; deploy.sh
  drops the legacy tags (inr2 disk hygiene).
- **ev rail on USD** (#10 closed): env + fleet card on the USD compose,
  `ev-charge-usd.service` watching the usd-console, and a USD charger
  e2e (self-funding via teller so a standalone grep needs no payer
  liquidity) — green against the physical atomD.
- **Console-error gate learned the slider's warmup polls**: the charge
  slider polls the gateway session endpoint from melt submission; the
  daemon triggers asynchronously, so 1–3 pre-trigger 404s are inherent
  (wallet already treats !ok as null). trackWalletErrors filters
  exactly that shape — first gated charger test surfaced it.
- Rig note: **payer reservoir nearly dry** (26k sat vs 150k reserve) —
  onchain e2e legs will fail until a signet faucet refill; teller and
  lightning legs unaffected.
- Stale-entry cleanup: tariff snapshot (#12) was already done
  (2026-09-03 hardening, `payout/ev-charge.py` `_tariffs` +
  test-pinned) — removed from backlog/limitations. #13's true scope
  recorded: an expiry refund needs a wallet-side claim flow (the
  daemon cannot mint to a pubkey it never saw) — medium, not short.
  [Superseded 2026-09-17: the refund turned out to need NO fresh
  issuance — mintd 0.18.0's mark-failed rollback restores the proofs
  and coco's UNPAID→op-rollback reclaims them; the wallet-side work
  was surfacing, not claiming. See limitations #3.]

## Multi-pair console + live-demo round 2026-09-14

The NOK pair went live (charger-D demo) and three gaps surfaced and
closed same-day:

- **Pair-prefixed console SPA (the blank-console bug).** One bundle
  serves every pair under `{currency}-console/*` with the prefix
  stripped at the proxy, but the console app called root-relative
  `/api/*` + `/events` and matched routes on raw pathnames — under any
  prefix those calls landed on the origin-root static site (HTML instead
  of JSON) and the page died with a `must_change_password` TypeError.
  Broken on EUR and USD consoles too, not just NOK. Fix:
  `web/src/lib/console-base.ts` derives the base from the URL at load
  time (`withBase` for API/SSE, `stripBase` for the router) — URLs stay
  reload-safe under the prefix. Unit-pinned + `console.spec.ts` boots
  and admin-logs-in on all three pairs (@smoke).
- **Teller camera scan.** The teller page now has "Scan with camera"
  (platform `BarcodeDetector`; Chromium-only, graceful message
  elsewhere). The wallet already renders the deposit's teller code as a
  QR encoding the quote id, and the server's match input accepts
  scanned full ids — phone → webcam → match is one hold-up. Camera
  permission pre-granted in the demo profile. NOT yet hand-verified
  with a physical phone (needs a human holding one up).
- **`make demo`** (`scripts/demo.sh` + `web/e2e/demo/live-demo.mjs`):
  one command, two visible windows (wallet left, admin teller right),
  funds via a teller-approved deposit in the admin UI, melts to charger
  D, streams `delivered/requested` kW·s from the gateway's public
  session endpoint until the receipt, and asserts balance = before −
  delivered. Proven live 2026-09-14: NOK 25 top-up → 12 kW·s session,
  receipt `EV-atomD-12s-4A034F58`, balance 13.00 exact, ~27 s.
- **atomD liveness mapping.** The t-relay box publishes its LWT on the
  ORIGINAL `charger/atom/status` topic — "both chargers go dark with
  the box" (bridge.mjs) — not on `charger/atomD/status`. demo.sh's
  fleet gate knows this; so should any future fleet dashboard.
- **deploy.sh owns all three pairs** (recreate eur+usd+nok + restart
  all mints + per-pair bundle verification); e2e.sh fetches the NOK
  admin password too.

Known-new: the `branch_session` cookie was shared across pairs on the
one origin (`Path=/`, one name — last login evicted the others); FIXED
same day — cookie names now carry the unit (`branch_session_nok`), all
pairs' sessions coexist in one browser (regression-pinned by
console.spec.ts). The dial (angle sensor) on atomD sets the delivery
RATE; only delivered kW·s is metered/reported — the angle itself never
leaves the box (needs the charger-firmware repo; a fleet-dashboard
candidate).

## Virtual charger round 2026-09-15 (evening)

The physical fleet went dark mid-evening (atomC retained status
offline; the atom/t-relay box MQTT-connected but unresponsive — the
daemons correctly device-timeout-settle with -TIMEOUT receipts). The
answer to demo-blocking hardware: **atomV**, an API-only virtual
charger with no physical twin.

- `scripts/ev-virtual-charger.mjs` + `virtual-charger.sh` — speaks the
  exact firmware MQTT contract (retained online, ack, countdown-finished
  at window end, wall-clock 1 s per kW·s) as the always-on
  `ev-virtual-charger.service` on inr2. No TTL, no start-refusal —
  nothing physical to collide with.
- Wallet gains **Charger V** (`ev:atomV`); the demo lane runs
  hardware-free (`PECAN_DEMO_DEVICE=atomV make demo` — proven 2026-09-15
  with the whole fleet down: NOK 8 melt → 8 kW·s → receipt
  EV-atomV-8s-452335AE, balance exact). The fleet-gate failure message
  points at the virtual variant.
- @smoke gains the charger-V end-to-end spec (zero sat, ~15 s) — the
  hardware-free critical path is now part of every post-deploy check.
- Fleet-card env (EUR+NOK composes) lists atomV, so the Mint-tab card
  shows it online while the boxes are dark.
- Bonus flake fix (found under load-average ~470):
  expiry-countdown.test.ts read Date.now() twice — 10 s of suite-load
  drift turned 54:5x into 54:49 (#19 data point; single clock read
  now).

## Realistic-tariff round 2026-09-17 (afternoon)

€0.50/kWh with a staged car ramp (3 kW ×30s → 7 kW ×30s → 22 kW,
deterministic — a real negotiation curve, not a walk). Enablers: the
gateway and daemon treat the session budget as metered kW·s (the
legacy 3600 wall-cap rejected every realistic budget — found twice,
in the gateway AND the daemon's own mirror); wallet humanizes kWh at
realistic scales; strip/pole graphs rescale to 25 kW with stage
bands; specs stop mid-session (natural caps take minutes at the unit
minimum — selftest covers the cap; sub-2-unit budgets strand
refunds below the mint minimum, so charger specs budget 2). Film:
250s narrated cut — ramp visible stage by stage, euros descending in
cents, 0.23 kWh for €0.11 of a €50 authorization. Two incident
classes hit during the round, both cross-session: the other session's
deploys repeatedly clobbered the live bundle AND /opt/pecan-tools/
ev-charge.py (stale wallet price constant → daemon refund mismatch →
balance 0); and a sed that matched [A-Za-z0-9]* left a $EV_PASSWORD
suffix glued to a unit password → 401 loop → login-throttle storm
(throttle is per-processor per-IP-username; a crash-looping daemon
self-sustains it). ev-charge-deploy.sh now refreshes unit passwords
on every rewrite.



## Narrated-movie round 2026-09-17 (evening)

The full cut now ships as alice-final.mp4 WITH VOICEOVER: the spec
emits a per-card timeline (movie-timeline.json — every card's window +
spoken line), and scripts/movie-voice.sh synthesizes each line with
macOS say (Samantha), rate-fits it to its card, adelay-aligns, and
amixes over the silent webm (VP8→H.264 for the mp4; amix needs
duration=longest — first truncates at the opening line). The recording
gained a phone frame + status bar (it reads as a device film now) and
a cold-open title; 20 narrated lines. The public pole page got the
film's typography and a scan-to-charge deep link.

## Movie pacing + firmware-display round 2026-09-17

Review feedback: transitions too fast to read; the charger's firmware
display should be visible above the wallet UX without occluding it.
Research pass (PiP best practice + screenshot study): corner overlays
need >=20% frame width, live where the point-of-interest is NOT,
ARRIVE at the narrated moment, and persist as a compact record. Shipped:
card holds computed from reading speed (~3 words/s, floor 3.2s — 14
cards); the POLE PANEL — a firmware-styled corner bubble (25% width,
black glass, segment kW + RELAY LED, scanlines) on the real meter feed
that boots when the session starts and fades when it ends, while the
strip persists; and a gentle-biased load walk (3-5.5 kW base, spikes
to 10) for longer cinematic burns — selftest bounds unchanged [3,10].
Two parse/TDZ bugs in the panel mount burned two takes before the
green 152s cut (verdict lines now checked explicitly, not artifact
timestamps).

## Demo-rail hardening round 2026-09-16 (night)

The movie's Lightning leg no longer depends on channel health: Alice's
invoice settles by SELF-PAY on the mint's own node (the rail's issuer,
which we control) — no routing, no balance choreography. This after the
evening's outage: repeated demo payments drained the hub→swap channel
to ~5k sat and CLN's pay failed 205 while NAMING A DEAD CHANNEL
instead of the real blocker (spendable balance) — filed as
lightning-playground#243 with full repro. New tooling:
scripts/ln-rebalance.sh (amountless-invoice push over the direct
channel — BOLT12 blinded paths route AROUND the channel and are useless
for rebalancing, measured; keysend is deprecated in v26). Movie lanes:
the 30-second short cut (scripts/movie.sh --remote --short) and the
full cut both ride the self-pay rail; companion strip resets its graph
per session; the public pole page appears live in the film.

## Energy-pricing round 2026-09-17

#30 layer B shipped: the tariff is now CURRENCY PER kWh end to end —
daemon flag `--eur-per-kwh` (100 on every pair; 1 unit = 36 kW·s),
wallet copy "€100.00/kWh, billed by the car's meter", cents-accurate
spent/refund accounting (`charge-session.ts` mirrors the daemon's
arithmetic), and every charger spec recomputed via the shared
`kwsToCents` helper. Deployed by `scripts/ev-charge-deploy.sh` (new:
ships /opt/pecan-tools + rewrites the three units' ExecStart — the
procedure used to be untracked). WHY 100 AND NOT REAL-WORLD 0.50: the
mint's 1-unit minimum melt and the gateway's 3600 kW·s session cap
make 0.50/kWh unservable (the cheapest legal melt = 2 kWh exceeds the
cap; visible 5-15 s sessions cost fractions of a cent) — sub-unit
melts/mints are the blocker, tracked on #30. charger-v's @smoke
elapsed assertion now pins the ENERGY contract: a €1 budget (36 kW·s)
completes in 3.6-12 wall seconds at the car's 3-10 kW draw. Also
fixed here: reconcile no longer flags the #13 daemon's terminal
failed-and-rolled-back melts as drift (the class that had api-smoke
red on the morning of 2026-09-17).



## Metered-truth round 2026-09-16 (evening)

#30 layer A + #31 shipped: the gateway is repo-tracked
(gateway/atom-gateway.mjs via scripts/atom-gateway.sh) and the device
meter is the session authority — delivered, remaining, auto-cap at
budget, and remote-stop billing all follow charger/{id}/meter while
fresh (<6s); meterless devices keep wall-clock (no firmware changes).
Proven live: 30 kW·s capped in 10 wall seconds; selftest asserts a
remote stop bills metered kW·s (12 for ~3.5s wall — the wall-clock
path it replaced once billed 3 for a metered 18: caught in movie
frame review). charger-v @smoke pins elapsed-vs-budget (a constant-
rate contract cannot pass it). Public live pole:
https://giftcard.cashu.exchange/chargepoint.html (CORS-open
/atom-gateway/public/{id}).

/atom-gateway/public/{id}). Remaining for #30: €/kWh pricing (layer
B — wallet copy, e2e budgets, daemon tariff). Wallet copy now reads
"1 € = 1 kW·s, billed by the car's meter".

## Alice movie round 2026-09-16

`scripts/movie.sh [--headed|--remote]` records the "Alice at the
charge point" story (web/e2e/alice-video.spec.ts): €50 Lightning
deposit → ecash minted → the charge point's QR deep link
(`?charger=atomV`, a 20-line wallet feature) → Sim Charger session
with the charger's own display as a live wasm PiP → remote stop at
~30 kW·s → receipt + refund. Headless by default; `--remote` records
on ai-legion (npm ci + chromium there once, artifacts rsynced back).
Shipped cut v3 (2026-09-16 visual round): the charger's display
  is a landscape companion strip pinned to the bottom (single SIM
  CHARGER, live kW·s + remaining €, read from the wallet's own DOM) —
  the wasm mirror showed the atom box's A+B and could never see atomV,
  which is why the first cut's "charger" never came alive; the
  firmware's landscape/single-charger profiles are tracked as #29.
  Settle waits bridge with animated cards, the charge stays on screen
  past 30 kW·s, and the film ends on a fade. Stills:
  web/e2e/.results-video/alice-stills/.
- The car is no longer a constant load: ev-virtual-charger walks the
  draw 3-10 kW and publishes live meter telemetry
  (charger/atomV/meter — asserted by virtual-charger.sh selftest);
  the companion strip graphs the kW curve + cumulative Wh from the
  broker while the € column tracks the wallet. Settlement still uses
  the gateway's wall-clock tariff — metered-truth end to end is #30
  (with €/kWh pricing); public charger view #31; slint energy graph
  folded into #29; movie polish #32.

Fixes the round surfaced and shipped: the sim-https helper died under
web's `"type": "module"` (renamed .cjs — the whole video lane was
broken); the PiP iframe ate pointer events over half the phone
viewport (now pointer-events:none — the "jumping" recording); and the
mint's LN rail was silently dead — the hub↔cln-swap channels had
closed ONCHAIN, leaving lightning deposits unroutable (opened a fresh
100k sat hub→swap channel; probe-paid 1400 sat clean).

## SAT currency round 2026-09-04

Third native currency: **sat** on the external signut mint (user's
explicit single-mint choice, no multimint). Registry (scale 1, step "1",
no console, `hasRails:false`, `nut17:false`) + wallet UI (Lightning-only
deposit card, invoice-textarea withdraw, scale-aware amounts everywhere)
+ `createSatMeltWithdraw` (bolt11 methodData wrapper — the flat shape
throws) + e2e `sat.spec.ts` (boot/deposit/melt/switch-isolation, all
green). Lessons banked:

- **CSP**: the wallet page's `connect-src` must whitelist the external
  mint — and `https:` does NOT imply `wss:` (coco opens NUT-17 sockets);
  both schemes needed.
- **NUT-17-off mint**: signut answers `/v1/ws` with 410 and the browser
  console-logs every failed handshake — a `webSocketFactory` that
  blackholes non-NUT-17 mints (synthetic error/close so the hybrid
  transport switches to fast polling) keeps the console clean while
  polling carries the data.
- **Concurrent melt drivers**: coco's MeltSettlementProcessor reacts to
  `melt-op:pending` and can finalize the op concurrently with an
  explicit `execute` — the loser sees the mint's "inputs may already be
  spent" (exact text: *may already be spent*). The wallet now treats
  that as benign only after polling the op row to a terminal state.
- **Boot resilience**: `addMint` failures (external mint down) no
  longer brick wallet boot for the same-origin pairs.
- Melt fee reserves exist on signut (1 sat observed) — the sat e2e
  asserts balance against the finalized op's effective fee, not a bare
  subtraction.

## Hardening round 2026-09-03 (late)

Audited the charger surface and fixed, all verified by tests:

- **Tariff snapshot**: the daemon records `tariff_eur_per_kwh` per
  ticket at trigger time — a restart with a changed flag can no longer
  reprice delivered energy.
- **Expired-untriggered deposits** now auto-`mark-failed` with a
  refund-due note (full deposit owed back, operator payback) instead of
  lingering as reconcile DRIFT.
- **Metering-loss policy changed**: a window whose completion is never
  confirmed settles the GRANTED window with a `…-TIMEOUT` receipt —
  strictly better than the old leave-open policy, which burned the whole
  deposit with no accounting.
- **Gateway session pruning**: sessions and ref indexes are dropped an
  hour after their window ends (unbounded maps on a long-lived host).
- **Payer health probe**: `sendOnchainFromExternal` probes each payer
  with a 15 s `getinfo` before its 300 s withdraw — the vls signer
  outage (still down; failover covers it) used to eat the entire budget
  before a healthy payer was tried. `refill-payers.sh` gained the same
  timeouts and reads hung RPCs as zero.
- **e2e.sh `-g` fix**: an explicit grep no longer combines with the
  default `--grep-invert @stress` into a contradiction.
- **Device-button e2e** added (simulated G39 press over MQTT): the
  debugging trail is a lesson — the generated Python subscribed to the
  literal topic `charger/${DEVICE}/#` because the line sat in a
  single-quoted TS string (no interpolation). Symptoms: subscription
  granted, zero messages. Fix: template literal. Also: paho v2
  `on_subscribe` takes five args.
- **Refund honesty**: the wallet proves the refund with a balance delta
  before the summary claims it (pollAndMint reports FAILED as terminal).

## Spec-compliance round 2026-09-05 (greatspectations + AI audits)

Layer 1 (mechanical, CI): spec-quote coverage doubled to 9 verbatim
NUT quotes (NUT-04/05/20) across the handlers — `spectate check` green
in `scripts/spec-quote-check.sh`.

Layer 2 (semantic): two AI audits (docs/audits/results/) — NUT-04+20
(mint/locked quotes) and NUT-05+08 (melt/change) — 35 ✅ / 6 ⚠️ / 0 ❌.
The NUT-20 posture is strong: locks enforced at quote creation AND
re-verified at settle (the processor cannot mint at all — no gRPC
path exists). Fixes applied from findings:

- **F1 (P1, fixed)**: out-of-spec `FAILED` melt states (a teller voids
  the ticket) were coerced to UNPAID — coco restored proofs the mint
  may have burned (phantom balance). The handler now fails loudly on
  any state it cannot positively interpret; regression tests pin it.
  Residual (open): a void AFTER the fund lock still leaves the op
  pending (coco's checkPending throws on FAILED, polls swallow) —
  needs an op-level failed mapping or an operator refund flow.
- **F3 (P2, fixed)**: the sat-melt losing-driver race accepted
  `rolled_back` as benign alongside `finalized` — rolled-back +
  burned-inputs resurrects dead proofs. Only `finalized` is benign now.
- **F2 (P1, documented)**: change re-serve on quote state checks is
  an UNSPECIFIED mint extension and unverified for nonempty change
  (every suite melt is exact). Comments aligned in handler +
  lightning-mint.md; needs a forced-overpay e2e to close.
- **NUT-04/20 F2/F3 (P2, open)**: the btc €50 minimum is enforced but
  not advertised via method settings; unlocked-quote refusal may not
  surface as spec error code 20009.

## Test rig runbook — e2e readiness

The full ladder (`scripts/e2e.sh`) is only as ready as the rig around
it. Pre-flight, in order:

1. **Deployment health**: `scripts/api-smoke.sh` — keys/info, one-way
   melt refusal, consoles, reconcile. ~30 s, read-only.
2. **Charger fleet**: `systemctl status ev-device-sim` on inr2 (it is
   a systemd unit since 2026-09-08: `Restart=on-success` refreshes the
   12 h TTL after host reboots, while the sim's own refusal guard —
   exit 3 when the fleet is already online — keeps it down while the
   real Atom is back). It impersonates the firmware on the shared
   HiveMQ topics: retained box status, start-acked,
   countdown-finished; the gateway meters remote stops itself, and the
   G39 button path is driven by the e2e's own button-sim. **When the
   real box returns: `systemctl stop ev-device-sim` FIRST** — the
   refusal guard only blocks STARTS, nothing stops it from running
   alongside, so the stop is a human duty. The
   sim self-exits after 12 h (retained offline) as a backstop.
3. **Onchain payer liquidity**: `scripts/payer-status.sh` on inr2 (or
   read /opt/pecan-tools/payer-status.json, 10-min cron). Each full
   run moves ~57 k sat; the 6-h refill cron tops payers up from the
   cln-swap reservoir (80 k target) but top-ups need one signet block
   to become spendable — run `refill-payers.sh` ahead of a planned
   e2e session, not after the payers run dry mid-suite.
4. **A wedged gateway session** (state `running`, device never acked —
   immortal in the pruning sweep): `systemctl restart atom-bridge` —
   session state is memory-only, the restart is the reset.

Verified 2026-09-04 with the sim: full suite **41 passed / 0 skipped /
0 failed** — the ev rail (slider, remote stop, device-button abort,
reload resume, double-stop idempotence) is fully exercisable without
the physical box.

## Known limitations and open issues (ranked)

1. **Spec-audit residuals (2026-09-05)** — see the spec-compliance
   round above: voided-after-fund-lock leaves the op pending; the
   forced-overpay change re-serve e2e (F2); btc minimum not advertised
   in method settings; unlocked-quote error code mapping. The
   device-sim remains available (`scripts/ev-device-sim.sh`) for
   hardwareless runs, but the physical stick is back and LIVE.
   Device-side future work (field config, web installer on our fork of
   lnbits/hardware-installer, an LNbits LNURLdevice mode) is planned in
   evmap's `firmware/ESP32-ROADMAP.md`.
2. **Unresponsive-page suite flake (undiagnosed; data point 2026-09-15).**
   Mid-chain full-suite
   failures where Playwright's page-snapshot capture times out — the
   page's own JS keeps running (heartbeat-verified), so it is
   driver/page contention, not a frozen app. Rate: ~2/4 historically,
   3 consecutive failures then a clean 32/32 on 2026-09-03 — possibly
   aggravated by today's added background traffic (daemon refund scan,
   gateway polls). A sibling symptom (2026-09-04, heavy evening of
   suites+deploys): fund-lock latency pushing the teller-code card past
   `readTellerCode`'s budget — the helper now budgets 70 s (the
   wallet's own worst-case chain: 20 s quote + 15 s prepare + 30 s
   lock); a standalone 17-iteration rail soak (@stress, 5.4 m) showed
   zero stalls, pointing at suite-load contention, not the wallet. If
   flakes persist, run the trace campaign: loop `--trace on` until it
   recurs and read the trace. 2026-09-15 hunt (#19): a full-suite
   baseline on a machine at load-average ~470 (five concurrent agent
   browser drivers) failed 7 — but decomposed into the physical charger
   fleet dying that evening (5 charger tests, daemons correctly
   device-timeout-settling; atomC offline, the atom box
   MQTT-connected-but-unresponsive) plus chain skips, not the
   page-snapshot signature; the deposit lane then ran 8×16 tests GREEN
   under the same load (3-6× wall inflation, zero flakes). Contention
   costs latency, not correctness, in the deposit lane; the historical
   signature remains unreproduced — keep the trace campaign armed.
 3. **Deposit expiry burn** — RESOLVED 2026-09-17 (#13): the burn itself
    was already gone on mintd 0.18.0 — mark-failed pushes PaymentFailed
    and cdk's melt-saga compensation ROLLS the melt back (proofs
    spendable again; live-verified against the 2026-09-03 drift quotes,
    now UNPAID with zero burned proofs). What was missing is now built:
    the daemon's expiry predicate (`expired_action`, unit-pinned)
    distinguishes never-triggered funded melts (mark-fail = auto-refund
    via the rollback; ledger records `refund_via: mint-rollback`,
    `refunded: true` so no later refund quote can double-pay) from
    waiting tickets (close, nothing due) and triggered sessions
    (untouchable); refused-before-trigger records — previously skipped
    past the expiry guard and left drifting forever — now resolve too;
    the stale "operator payback" note (which instructed a double-pay)
    is gone. Wallet side: `pollWithdraw` reports rolled_back as
    REFUNDED (≠ FAILED, unit-pinned), the charge card surfaces an
    explicit "Refunded" summary on resume and reload
    (`getRecentRefundedDeposit`), and coco's own UNPAID→rollback
    reclaims the proofs. E2E: charger-expired-refund.spec.ts (@expiry
    lane, ~35 min — kill daemon → melt → full 30-min TTL → restart →
    refund card + exact balance). A settled refund quote for an expired
    melt would double-pay (restored proofs + fresh ecash) and the
    processor refuses mark-paid on expired quotes anyway — the rollback
    IS the refund.
4. **ev rail is EUR-only** — RESOLVED 2026-09-15: env + second daemon
   (`ev-charge-usd.service`) + USD charger e2e green on the physical
   atomD.
5. **Gateway session state is memory-only.** An atom-bridge restart
   mid-session loses the ref↔session map: the slider stops updating and
   the browser Stop falls back to the physical button (the charger's
   own end anchor still finishes the window; the daemon still settles).
   Persistence (sqlite) if sessions outlive demo length.
6. **Refund rounding.** Sub-euro remainders are unclaimed (mint-quote
   minimum). At the 1 s/€ demo tariff the exposure is < €1 per session;
   at finer tariffs, batch or accumulate refunds.
7. **Tariff is daemon-global and read at settle time** — RESOLVED
   2026-09-03 (stale entry, removed from the backlog 2026-09-15): the
   daemon snapshots the per-kWh tariff per ticket at trigger time
   (`payout/ev-charge.py`, unit-pinned) and settles from the snapshot.
8. **Ambient gRPC churn.** `Error adding payment event to stream:
   channel closed` appears 1–6/min under load, present in passing runs
   too; sagas always complete. Never root-caused; worth one look at
   mintd's reconnect cadence if it ever correlates with a failure.
9. **Deposit-melt change-carrying + the amount floor.** cdk 0.18.0
   rejects `total_spent < quote.amount` (`IncorrectQuoteAmount`) —
   partial settle is an upstream feature, not wiring. Documented with a
   live postmortem in `partial-delivery.md`; the refund quote is the
   working equivalent.
10. **SAT pending-deposit expiry display** — RESOLVED 2026-09-04: the
   pending card now counts down to the MINT's own quote expiry
   (carried on DepositQuote.expiresAt; signut invoices live 55 min vs
   the fiat pairs' 30) instead of a hardcoded 30-min fallback.

## Improvement backlog

All remaining work is tracked as GitHub issues
(github.com/Amperstrand/pecan — open issues #8–#27). The ranked intent
lives here; the issues carry acceptance criteria and code pointers.

Short (days):
- Enable ev on USD — DONE 2026-09-15 (#10): ev-charge-usd daemon active,
  rail in the USD compose, USD charger lane in the suite (usd.spec).
- Expiry auto-refund for never-triggered deposits — DONE 2026-09-17
  (#13): mint-rollback refund (see known-limitations #3 for why the
  refund is the rollback, not a fresh mint quote) + wallet refund
  surfacing + @expiry e2e lane.
- Refund rounding: batch/accumulate sub-unit remainders — #26.

Medium:
- The flake hunt (trace capture campaign) + deposit-flow soak — #19,
  the highest-value quality work in the repo right now.
- Gateway session persistence + rate-limit on the public stop
  endpoint — #11.
- Live slider via websocket push instead of 1 s polling — #20.
- Physical-button e2e (MQTT aborted publish) — #14.
- Charger fleet status card — DONE 2026-09-15 (#8): /api/fleet proxies
  the atom-gateway per device (X-API-key stays server-side; env-wired
  on the EUR + NOK pairs), Mint-tab card with 10 s refresh, degrades to
  "unreachable". Caught in review: device ids must keep their case —
  the gateway keys sessions by the id as triggered (atomD).
- NOK lane in defineWalletSuite — #16; camera scanner verification +
  decode-path test — #17.

Long / strategic:
- Upstream: file the partial-settle use case with cashubtc/cdk — #23
  (design C would become possible).
- Upstream PRs from our generic work — #24 (mint-call timeouts,
  smoke-tier structure, fee-lesson note, /api/tickets/open).
- Real metering: `delivered` becomes Wh
  unchanged through the whole stack (device → gateway → daemon →
  receipt); tariff becomes €/kWh — #15 (CSMS/OCPP seam included).
- Crash-recovery suite in the tollgate style + meter-trust policy —
  #25.
- Ambient gRPC churn investigation — #27.
- Ops polish: root-domain landing branding — #21; deploy.sh
  image-tag hygiene — DONE 2026-09-15 (single `pecan:deployment` tag,
  see the hygiene round); scanner fallback decoder for non-Chromium —
  #18.

## tollgate-rs: adopted vs pending

Adopted: refunds as separately-authorized operations (never implicit
balance remainders); idempotent issuance (one refund per melt, ever,
in the state ledger); server-side validation against delivery truth;
reload-safe wallet claims (refund = ordinary pending deposit card);
at-least-once mark-paid (Paid-settle is a no-op).

Pending: a crash-recovery test suite
in the tollgate style (SIGKILL the daemon at each refund stage and
assert convergence — their `tests/crash_recovery.py` is the template);
an explicit meter-trust policy doc for telemetry gaps (freeze vs
conservative bound vs operator review — our operator-needed path is
the loose version of this).

## Test quick-reference

`cd web && npm test` (76) → `cd processor && cargo test` (88) →
`scripts/api-smoke.sh` (incl. signut liveness) →
`scripts/e2e.sh --smoke` (14 tests, ~30 s) →
`scripts/e2e.sh -g "SAT wallet"` (~30 s, ~47 sat) →
`scripts/e2e.sh -g "deposit pattern"` (~30 s) →
`scripts/e2e.sh` (full suite) → `scripts/e2e.sh -g @stress` →
`make demo` (visible live demo, not a test). Full ladder
in AGENTS.md; rig pre-flight in the runbook above; spec-quote drift
via `scripts/spec-quote-check.sh`.
