# Pecan + EV rail — status, limitations, and where to go next

Snapshot: 2026-09-03. Live at https://giftcard.cashu.exchange. This is
the honest map of what works, what is known-broken or limited, and the
ranked backlog. Keep it current when the picture changes.

## Architecture snapshot

| Piece | Version / state | Notes |
|---|---|---|
| cdk-mintd (both pairs) | **0.18.0 final** (upgraded from rc.3 2026-09-03) | DB-backed config; pre-upgrade DBs in `/root/backups/*-pre-0.18.0.sqlite` |
| pecan processor | deployment `af21ffa` | EUR + USD pairs, 8 payout rails on EUR (7 sim + ev), 7 on USD (no ev yet) |
| Wallet (coco 2) | same deploy | rail picker, deposit-pattern chargers, mint-call timeouts, reload-resume |
| ev-charge daemon | inr2 systemd `ev-charge.service` | watch mode: settle, expiry guards, at-most-once trigger, refund ledger |
| atom-gateway | inr2 systemd `atom-bridge.service` | public session endpoints (ref = capability), remote stop, delivered metering |
| Atom firmware | ESPHome dual-charger (atomA G26 / atomB G32) | G39 abort reports actual `{"delivered": s}`; LED matrix countdowns |
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

## Known limitations and open issues (ranked)

1. **Unresponsive-page suite flake (undiagnosed).** Mid-chain full-suite
   failures where Playwright's page-snapshot capture times out — the
   page's own JS keeps running (heartbeat-verified), so it is
   driver/page contention, not a frozen app. Rate: ~2/4 historically,
   3 consecutive failures then a clean 32/32 on 2026-09-03 — possibly
   aggravated by today's added background traffic (daemon refund scan,
   gateway polls). Next step: loop the suite with `--trace on` until it
   recurs and read the trace; `scripts/e2e.sh -g @stress` carries the
   instrumentation.
2. **Deposit expiry burn.** A deposit melt that expires while the daemon
   is down burns (reconcile DRIFT; manual write-off). Hardening: the
   daemon can distinguish never-triggered windows from delivered
   partials and auto-refund expired-but-untriggered deposits.
3. **ev rail is EUR-only.** The USD pair's on-server compose predates
   the rail; enabling is a one-line env change plus a second daemon
   instance pointed at the USD console (tariff/gateway shared).
4. **Gateway session state is memory-only.** An atom-bridge restart
   mid-session loses the ref↔session map: the slider stops updating and
   the browser Stop falls back to the physical button (the charger's
   own end anchor still finishes the window; the daemon still settles).
   Persistence (sqlite) if sessions outlive demo length.
5. **Refund rounding.** Sub-euro remainders are unclaimed (mint-quote
   minimum). At the 1 s/€ demo tariff the exposure is < €1 per session;
   at finer tariffs, batch or accumulate refunds.
6. **Tariff is daemon-global and read at settle time.** A mid-session
   daemon restart with a changed `--secs-per-eur` would misbill the
   in-flight session. Snapshot the tariff into the state record at
   trigger time (a tollgate-rs pricing-doc lesson).
7. **Ambient gRPC churn.** `Error adding payment event to stream:
   channel closed` appears 1–6/min under load, present in passing runs
   too; sagas always complete. Never root-caused; worth one look at
   mintd's reconnect cadence if it ever correlates with a failure.
8. **Deposit-melt change-carrying + the amount floor.** cdk 0.18.0
   rejects `total_spent < quote.amount` (`IncorrectQuoteAmount`) —
   partial settle is an upstream feature, not wiring. Documented with a
   live postmortem in `partial-delivery.md`; the refund quote is the
   working equivalent.

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

`cd web && npm test` (56) → `cd processor && cargo test` (75) →
`scripts/api-smoke.sh` → `scripts/e2e.sh --smoke` (~25 s) →
`scripts/e2e.sh -g "deposit pattern"` (~30 s) → `scripts/e2e.sh` (full)
→ `scripts/e2e.sh -g @stress`. Full ladder in AGENTS.md.
