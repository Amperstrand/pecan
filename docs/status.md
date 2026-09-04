# Pecan + EV rail — status, limitations, and where to go next

Snapshot: 2026-09-05 (updated after the hardware-return round — Rust
firmware live on the M5Stick, greatspectations Layer-1 expansion, two
AI spec audits with fixes, full suite 43 green incl. atomB + sat
reload-resume). Live at https://giftcard.cashu.exchange. This is
the honest map of what works, what is known-broken or limited, and the
ranked backlog. Keep it current when the picture changes.

## Architecture snapshot

| Piece | Version / state | Notes |
|---|---|---|
| cdk-mintd (both pairs) | **0.18.0 final** (upgraded from rc.3 2026-09-03) | DB-backed config; pre-upgrade DBs in `/root/backups/*-pre-0.18.0.sqlite` |
| pecan processor | deployment branch | EUR + USD pairs, 8 payout rails on EUR (7 sim + ev), 7 on USD (no ev yet); CSP whitelists signut (https+wss) |
| Wallet (coco 2) | same deploy | rail picker, deposit-pattern chargers, mint-call timeouts, reload-resume, **sat mode (bolt11, signut)** |
| SAT mint | external: signut.cashu.exchange (Nutshell-CF) | bolt11+sat only, NUT-17 off (ws 410 → blackhole factory), CORS open; no console, no pecan rails |
| ev-charge daemon | inr2 systemd `ev-charge.service` | watch mode: settle, expiry guards, at-most-once trigger, refund ledger |
| atom-gateway | inr2 systemd `atom-bridge.service` | public session endpoints (ref = capability), remote stop, delivered metering |
| Charger firmware | **charger-stick-slint (Rust+Slint) LIVE 2026-09-05** — evmap `af24ed0` | M5StickC Plus; MQTT byte-parity; see FLASHING.md (USB-only at 92-95% flash: no OTA slots on 4MB; ESPHome sibling keeps wifi-OTA) |
| Deploy lane | `scripts/deploy.sh` → build on ai-legion-small → inr2 | builder disk pruned 2026-09-02 (was 99% full) |

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

- **Tariff snapshot**: the daemon records `secs_per_eur` per ticket at
  trigger time — a restart with a changed flag can no longer reprice
  delivered energy.
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
2. **Charger fleet**: `scripts/ev-device-sim.sh status`. While the
   physical Atom is away, `start` the MQTT simulator (it impersonates
   the firmware on the shared HiveMQ topics: retained box status,
   start-acked, countdown-finished; the gateway meters remote stops
   itself, and the G39 button path is driven by the e2e's own
   button-sim). **When the real box returns: `stop` the sim FIRST** —
   it refuses to start against an already-online fleet, but nothing
   stops it from running alongside, so the stop is a human duty. The
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
2. **Unresponsive-page suite flake (undiagnosed).** Mid-chain full-suite
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
   recurs and read the trace.
3. **Deposit expiry burn.** A deposit melt that expires while the daemon
   is down burns (reconcile DRIFT; manual write-off). Hardening: the
   daemon can distinguish never-triggered windows from delivered
   partials and auto-refund expired-but-untriggered deposits.
4. **ev rail is EUR-only.** The USD pair's on-server compose predates
   the rail; enabling is a one-line env change plus a second daemon
   instance pointed at the USD console (tariff/gateway shared).
5. **Gateway session state is memory-only.** An atom-bridge restart
   mid-session loses the ref↔session map: the slider stops updating and
   the browser Stop falls back to the physical button (the charger's
   own end anchor still finishes the window; the daemon still settles).
   Persistence (sqlite) if sessions outlive demo length.
6. **Refund rounding.** Sub-euro remainders are unclaimed (mint-quote
   minimum). At the 1 s/€ demo tariff the exposure is < €1 per session;
   at finer tariffs, batch or accumulate refunds.
7. **Tariff is daemon-global and read at settle time.** A mid-session
   daemon restart with a changed `--secs-per-eur` would misbill the
   in-flight session. Snapshot the tariff into the state record at
   trigger time (a tollgate-rs pricing-doc lesson).
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

Short (days):
- Enable ev on USD (env + second daemon) or document EUR-only as demo
  scope.
- Expiry auto-refund for never-triggered deposits (daemon ledger
  already knows the difference).
- Tariff snapshot at trigger time.
- `soak.sh`-style repetition over the deposit flow (the single-green-run
  lesson).

Medium:
- The flake hunt (trace capture campaign) — highest-value quality work
  in the repo right now.
- Gateway session persistence + caddy rate-limit on the public stop
  endpoint (the unguessable ref is the real gate; a limiter is belt and
  braces).
- Live slider over NUT-17 websockets instead of 1 s polling.
- Physical-button e2e: the G39 path is manually verified; a spec can
  simulate it (MQTT aborted publish) the way the deposit spec drives the
  remote stop — worth adding so both stop paths stay covered.

Long / strategic:
- Upstream: file the partial-settle use case with cashubtc/cdk (the
  amount-floor discovery + our deposit-pattern workaround is a strong
  issue write-up; design C would become possible).
- Upstream PRs from our generic work (per branch-ownership rules):
  wallet mint-call timeouts, smoke-tier test structure, the fee-lesson
  input-consolidation note, `/api/tickets/open` as a daemon surface.
- Real metering: when a metered socket exists, `delivered` becomes Wh
  unchanged through the whole stack (device → gateway → daemon →
  receipt); tariff becomes €/kWh.
- Commercial CSMS integration: the gateway's HTTP contract is the seam;
  an OCPP adapter maps RemoteStart/MeterValues/StopTransaction onto it.

## tollgate-rs: adopted vs pending

Adopted: refunds as separately-authorized operations (never implicit
balance remainders); idempotent issuance (one refund per melt, ever,
in the state ledger); server-side validation against delivery truth;
reload-safe wallet claims (refund = ordinary pending deposit card);
at-least-once mark-paid (Paid-settle is a no-op).

Pending: tariff snapshotting per session; a crash-recovery test suite
in the tollgate style (SIGKILL the daemon at each refund stage and
assert convergence — their `tests/crash_recovery.py` is the template);
an explicit meter-trust policy doc for telemetry gaps (freeze vs
conservative bound vs operator review — our operator-needed path is
the loose version of this).

## Test quick-reference

`cd web && npm test` (72) → `cd processor && cargo test` (75) →
`scripts/api-smoke.sh` (incl. signut liveness) →
`scripts/e2e.sh --smoke` (~25 s) → `scripts/e2e.sh -g "SAT wallet"`
(~30 s, ~47 sat) → `scripts/e2e.sh -g "deposit pattern"` (~30 s) →
`scripts/e2e.sh` (full, 43) → `scripts/e2e.sh -g @stress`. Full ladder
in AGENTS.md; rig pre-flight in the runbook above; spec-quote drift
via `scripts/spec-quote-check.sh`.
