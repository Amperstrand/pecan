# NUT-32 egg futures — deployed spike

Status: **in flight** (branch `spike/nut32-egg-futures`). This doc is the
runbook + design record for the physical-egg-futures spike on
`NUT-32.md` (private draft, committed at the repo root together with the
task file `OpenCode prompt — deployable Pecan NUT-32 egg-futures spike.md`).

- Hostname note: the task file says `giftcare.cashu.exchange`; the real
  deployment is **`giftcard.cashu.exchange`** (anticipated typo — the
  existing infrastructure is used, not a parallel one).
- Signet only. No mainnet anywhere. The farm pair is a NEW fourth pair
  (`farm`); EUR/USD/NOK pairs are untouched.

## Implementation boundary (what lands where)

The mints run the official `cashubtc/mintd` image. The FARM pair runs a
**forked mintd image** built from `~/src/cdk-nut32` (branch `pecan-nut32`,
tagged `v0.18.0` + spike commits) — see `scripts/build-mintd-nut32.sh`.
EUR/USD/NOK keep the stock image. Pecan itself learns the farm rail via
env (`CDK_BRANCH_PROCESSOR_FARM=true`), so one `pecan:deployment` image
still serves every pair.

### cdk / cdk-mintd fork (farm pair only)

1. **NUT-06 capability advert** — `Nuts` gains `nut32`
   (`"32": {"supported": true, "versions": [1]}`), gated on
   `CDK_MINTD_NUT32=true`.
2. **Unit grammar + secret-tag validation** (new `nut32` module in the
   `cashu` crate): `future:<base>-<quote>:<yyyymmdd>t<hhmmss>z` parser
   (whole-unit lowercase, offsets/fractions/impossible dates rejected)
   and the exactly-one `["future","1","<terms-uri>"]` tag check with a
   canonical content-addressed URI shape (https, last path segment a
   64-char sha256).
3. **Spend-time proof validation** — when a proof's keyset unit is a
   registered future series, `verify_inputs` (the shared swap/melt
   entry) requires the proof secret to carry the series' exact terms
   digest. Blinded outputs cannot be inspected at mint/swap time (that
   is the point of blind signatures), so the draft's "the mint MUST
   issue only outputs whose future unit and signed terms are valid" is
   enforced as: unit/quote/keyset authorization at issuance + full
   secret validation at every spend. A future proof with a wrong or
   missing tag is unspendable — and therefore worthless — by
   construction. (Documented interpretation; see Deviations.)
4. **Dynamic series registration** — mintd exposes token-guarded admin
   routes (merged into its router, `CDK_MINTD_NUT32_ADMIN_TOKEN`):
   `POST /nut32/admin/series {unit, terms_sha256}` validates the unit,
   creates the keyset, wires the payment processor for
   `(unit, "future")`, and adds NUT-04/05 method settings so quotes are
   accepted and advertised; idempotent. `GET /nut32/admin/series` lists.
   Series persist in the mint DB and re-register on boot.
5. **Terms signing** — `POST /nut32/admin/sign-terms {mint, terms}`
   BIP-340-signs the `Cashu_NUT32_Terms_v1:`-prefixed canonical payload
   with the mint's identity key (the same key behind the NUT-06
   `pubkey`). The key NEVER leaves mintd.
6. **Swap unit preservation** — already enforced upstream
   (`verify_transaction_balanced` rejects cross-unit swaps with
   `UnitMismatch`; cdk 0.18.0). The fork adds nothing here; the e2e
   pins it anyway.

### pecan processor (farm module)

- **Series oracle + ledger** (`processor/src/farm.rs`): daily series
  `Farm-YYYYMMDD` / unit `future:farm-egg:YYYYMMDDT160000Z`, capacity
  10, price 1000 sat/egg, maturity 16:00 UTC, actual-production state
  (shortfall simulation), signed immutable terms stored
  content-addressed at `/terms/<sha256>` (blob bytes determine the
  path; overwrites refused).
- **Purchase saga**: `POST /api/farm/futures/quote` (public) with
  `{production_date|"next-friday", quantity, pubkey}` → reservation
  (transactional against the single-writer state lock, same pattern as
  the ticket store), raw-sat bolt11 invoice on the shared signet CLN
  node (label = purchase id), states
  `OPEN → PAID → AUTHORIZED → MINTED` (+ `EXPIRED`/`FAILED`). Unpaid
  expiry releases the reservation (sweeper + lazy checks).
- **Issuance binding**: the future mint quote (NUT-04, method
  `future`, NUT-20 locked) must reference the purchase id in the
  flattened extra fields (`{"purchase": ...}` — same pass-through the
  ln/btc rails use for `{"rail": ...}`). The processor re-checks unit,
  amount, pubkey AND purchase state before marking the quote paid
  (immediate `PaymentReceived` — payment already settled on signet).
  One quote per purchase, ever; retries of the same quote are
  transport-level no-ops.
- **Redemption**: a NUT-05 melt quote with method `future` and unit
  `future:...` becomes a teller redemption ticket (the existing
  match-and-settle machinery, relabeled): wallet locks proofs, teller
  matches the code, hands over eggs, settles → proofs burned +
  `FARM-...` receipt. Before settle nothing is consumed; double
  redemption dies on spent proofs. Maturity is checked at melt-quote
  creation (real timestamps; a clearly-marked admin "mature now"
  override exists for tests/demo only).
- **One-way invariant**: futures never melt to sats; the only exit is
  physical redemption (test-enforced like the fiat pairs).

### wallet (coco fork + web)

- coco fork (`~/src/coco`, re-vendored via `scripts/vendor-coco.sh`)
  gains tagged-output support: deterministic outputs whose secret is
  NUT-10 JSON carrying the future tag, used for both minting and
  swaps. `amount` = egg count everywhere; splits are ordinary Cashu
  amount splits with the tag preserved in every replacement proof.
- `web/src/lib/coco/` gains `future-methods.ts` (method registries),
  `mint-future-handler.ts`, `melt-future-handler.ts`, a farm client
  (`farm.ts`), and the Sarah UI (`farm` tab in the wallet:
  buy → invoice → poll → mint; owned futures with unit/terms
  hash/maturity behind a debug expander; send-N-eggs token export +
  import; redeem → teller code).

## Deviations / extensions relative to the NUT-32 draft

0. **Unit casing (draft amended during the spike)**: the draft originally
   required uppercase `T`/`Z` separators. That cannot round-trip cdk —
   it lowercases every custom unit (`normalize_custom_unit` → lowercase
   NFC), and the wider ecosystem (NUT-02 registry, nutshell, cashu-ts)
   treats unit identifiers as lowercase. The spike first patched case
   preservation into both forks, then took the better path: the draft's
   Unit section now specifies an all-lowercase unit (lowercase `t`/`z`
   are still valid ISO-8601), implementations reject the uppercase form,
   and BOTH fork carve-outs were reverted. Recorded in NUT-32.md.

1. **Physical settlement** (`settlement_method: "physical"`): the draft
   describes settlement as "spend the future proof and issue the stated
   `settlement_unit` amount". Eggs are not ecash: successful physical
   handoff produces **spent future proofs + a mint/farm redemption
   receipt** (the teller-melt preimage), not a new Cashu unit. Labeled
   as this spike's experimental physical-settlement interpretation.
2. **Issuance-time secret validation**: impossible for blinded outputs;
   enforced at unit/quote/keyset level at issuance and at every spend
   (see boundary §3).
3. **Shortfall** (`shortfall_policy: "issuer-default"`): when actual
   production < issued claims, redemptions are capped at actual
   production and the remaining claims are explicitly
   unresolved/defaulted in series state. No insurance/liquidation.

## Non-goals (from the task file, honored)

No NFTs, no numbered eggs, no order book, no margin/leverage/
liquidation, no derivatives pricing, no marketplace, no ownership
registry, no KYC, no insurance, no generalized commodity platform.

## Privacy property

Pecan knows per-series aggregates only: capacity, reserved, issued,
redeemed, actual production. Ownership lives in bearer proofs —
Sarah→Bob is a plain Cashu split+transfer the farm never sees. Pinned
by an explicit architecture test (processor state contains no holder
table) + e2e.

## Charger ↔ farm: the shared resource-saga substrate

Two examples of the same lifecycle now exist (charger, egg futures). What
they genuinely share — and what the farm deliberately reuses instead of
re-inventing:

| Lifecycle stage | Charger | Egg futures | Shared substrate |
|---|---|---|---|
| Durable op id | melt quote id (session ref) | purchase id `FP-…` / mint quote id | mint quote ids are the correlation keys |
| Reservation | budget melted up front (overpay refunded later) | capacity held by OPEN..AUTHORIZED purchases, released on expiry/mint | same sweeper pattern (`BranchState::sweep_expired` / `FarmState::sweep_expired`) |
| Economic snapshot | `secs_per_eur` per ticket at trigger time | `price_per_egg_sats` + terms hash frozen per purchase/series | price changes never reprice in-flight ops |
| External transition | charger triggered / metered | signet invoice paid / eggs handed over | idempotent state transitions under a single-writer lock; at-most-once triggers |
| Receipt | `EV-<device>-<n>s-<ref>` | `FARM-yymmdd-<ref>` | `payout::receipt_for_rail` (the Lightning-preimage analogue) |
| Reconciliation | daemon ledger vs mint | farm counters vs teller ticket store (burn record) | recount-from-authority on boot + after settle |
| Crash ambiguity | delivery window vs burn | handover vs burn | validate-BEFORE-burn; the authoritative store (tickets) drives recovery |

Adapter-local (deliberately NOT abstracted): Wh, charger ids, meter
readings, device triggering stay in the EV adapter; eggs, production
dates, daily capacity, physical pickup stay in the farm adapter. Adding
a third resource means: a `FarmState`-shaped ledger, a `future`-style
quote gate in `backend.rs`, a receipt format in `payout.rs`, and the
teller settle hook — no framework.

## Deployed layout (live)

| Piece | Where |
|---|---|
| Farm mintd (NUT-32 fork image `cashubtc/mintd:nut32`) | inr2 `/opt/giftcard-mint-farm`, :8100 (pub `/farm/v1/*`), prometheus :9102 |
| Farm pecan | inr2 `/opt/pecan-farm` (compose `deploy/docker-compose.farm.yml`), gRPC :50058, HTTP :9101 (pub `/farm-console/*`) |
| Fork source | `~/src/cdk-nut32` branch `pecan-nut32` (v0.18.0 + spike commits), built by `scripts/build-mintd-nut32.sh` |
| coco fork | `~/src/coco` branch `nut32-futures`, vendored 1.0.12 via `scripts/vendor-coco.sh` |
| Admin token | `/opt/pecan-farm/.env` + `/opt/giftcard-mint-farm/.env` (`PECAN_FARM_MINTD_ADMIN_TOKEN`) |
| Wallet | https://giftcard.cashu.exchange/wallet → **FARM** tab |

## Runbook

```sh
# full redeploy of the farm pair (all pairs recreate; mints restart)
scripts/build-mintd-nut32.sh        # only when the cdk fork changed
scripts/deploy.sh                   # rebuilds pecan + web, recreates all pairs
scripts/api-smoke.sh                # incl. the NUT-32 section
cd web/e2e && npx playwright test farm.spec.ts -g sarah   # the Sarah story (~5000 sat)
scripts/e2e.sh --smoke              # the rest of the suite still green
```

Manual redemption demo: FARM tab → Redeem → teller matches the 6-char
code in the farm console → "Eggs handed over" → settle → FARM receipt.
Shortfall demo (admin): `POST /farm-console/api/farm/series/<date>/production
{"actual": 7}` — further redemptions beyond 7 fail with issuer-default.

## Verification evidence

- Processor: 100 tests green (`cargo test`), incl. 12 farm tests
  (grammar, capacity, race ≤ 10, expiry release, payment-before-issuance,
  one-quote-per-purchase, maturity + shortfall gating, privacy
  aggregate-only).
- cdk fork: NUT-32 unit tests (grammar edges incl. leap years, exactly-one
  tag, canonical JSON, payload stability).
- Wallet: 83 vitest tests incl. BIP-340 client-side verify pin.
- e2e: `farm.spec.ts` — sarah_buys_five_friday_eggs_with_signet (real
  5000-sat payment, proof/tag/terms-digest assertions, Sarah→Bob bearer
  transfer, redemption + double-spend refusal), capacity, maturity
  refusal.

## Final report (2026-09-17)

### Deployed URLs
- Wallet (Sarah UI): https://giftcard.cashu.exchange/wallet — **FARM** tab
- Farm mint: https://giftcard.cashu.exchange/farm/v1/* (NUT-32 fork image `cashubtc/mintd:nut32`, inr2 :8100, prometheus :9102)
- Farm console: https://giftcard.cashu.exchange/farm-console/*
- Terms blobs: https://giftcard.cashu.exchange/farm-console/terms/<sha256>
- Series oracle: https://giftcard.cashu.exchange/farm-console/api/farm/<date>

### Actual hostname used
`giftcard.cashu.exchange` (the task file's `giftcare` was the anticipated
typo; the existing infrastructure was used, none created in parallel).

### Branch/commits
- pecan: branch `spike/nut32-egg-futures` (off `deployment` @ f785505).
  Not pushed — the user pushes.
- cdk fork: `~/src/cdk-nut32`, branch `pecan-nut32` (v0.18.0 + 5 spike
  commits; image built by `scripts/build-mintd-nut32.sh`).
- coco fork: `~/src/coco`, branch `nut32-futures` (1.0.18, vendored).

### Pecan modifications
`processor/src/farm.rs` (series/purchase/redemption ledger), `backend.rs`
(future-rail routing — melt routes BY UNIT because the gRPC proto drops
method names), `web.rs` (farm API + terms store + redemption gate in
mark-paid), `payout.rs` (farm receipt), `main.rs`, `scripts/pairs.sh` +
`deploy/docker-compose.farm.yml` + `scripts/build-mintd-nut32.sh`,
api-smoke/reconcile/e2e wiring. Wallet: `web/src/lib/coco/farm.ts`,
future-methods/mint-future-handler/melt-future-handler, the FARM tab
(`farm-panel.tsx`), currency registry entry, coco fork 1.0.16–1.0.18.

### CDK/mintd modifications (fork)
NUT-06 `"32"` advert; `nut32` grammar/secret/canonical-JSON/signing module;
dynamic series registration (per-series keyset, processor wiring for
`(unit, future)`, NUT-04/05 settings, KV persistence); spend-time proof
validation in `verify_inputs`; runtime-processor resolution in
`check_mint_quote_paid`, `get_melt_custom_quote_impl`, the melt saga, and
the start-up melt check; token-guarded admin routes
(`/nut32/admin/{healthz,series,sign-terms}`) with BIP-340 terms signing
under the mint identity key. **Amendment**: the fork also STOPPED
lowercasing `future:` units — reconciled the other way in the end: the
draft now lowercases the whole unit (cdk's established normalization), and
NO cdk carve-out remains.

### NUT-32 subset implemented
Unit grammar (whole-unit lowercase), exactly-one `["future","1",uri]`
secret tag, canonical terms JSON + `Cashu_NUT32_Terms_v1:` BIP-340
signing, content-addressed blob, capability advert, per-series keysets,
spend-time validation (swap+melt), unit preservation (cdk's own
`UnitMismatch` on cross-unit swaps).

### Deviations/extensions
1. Physical settlement = spent proofs + FARM receipt (labeled
   experimental). 2. Issuance-time secret validation is impossible for
   blinded outputs — enforced at unit/quote level + every spend.
3. Shortfall = issuer-default with refused over-redemption. 4. The draft
   was AMENDED during the spike: unit grammar lowercases whole (aligning
   with cdk's custom-unit normalization as established practice).

### Key mechanisms
- Mint identity signing: `POST /nut32/admin/sign-terms` inside mintd;
  BIP-340 over SHA-256 of the domain-prefixed canonical payload; the key
  never leaves mintd; verifiable against the NUT-06 `pubkey`
  (`02aba29c5ad2705d…`).
- Content addressing: blob bytes → SHA-256 → served at `/terms/<sha256>`;
  double-writes of different bytes are refused; api-smoke pins
  byte-stability.
- Capacity ≤ 10/day: single-writer state lock — `issued + Σ(open|paid|
  authorized reservations) ≤ capacity` checked atomically at insert;
  unpaid quotes expire (TTL sweep), paid-but-unclaimed purchases release
  after a 24 h claim window. Concurrent race: 12 parallel purchases
  reserve exactly 10 (cargo test).
- Signet confirmation: raw-sat bolt11 on the shared signet CLN; CLN
  `listinvoices` polled → PAID; the e2e paid 5000 msat per run and CLN
  reports the settled invoices independently.

### The Sarah purchase tested (live)
`FP-b8f2c4835fb5`, series 2026-09-19 (`future:farm-egg:20260919t160000z`),
qty 5, 5000 sat (real lightning payment via cln-hub→cln-swap), mint quote
`01a0ad60…`, proofs hold the exactly-one future tag with the series'
terms URI; oracle: issued 5, redeemed 2, remaining 5. Sarah→Bob: bearer
token (2 of 5), Bob owns 2; farm knows aggregates only. Redemption:
mature-now (admin demo override) → Bob melts 2 → teller matches
`MELT-01a0ad61` → receipt `FARM-260917-90E2A022`; a replayed token/melt
dies on spent proofs. Evidence: `docker exec pecan-farm-pecan-1 cat
/var/lib/cdk-branch-processor/farm.json` + the CLN invoice list (83 paid
farm invoices, 295 000 sat across the whole debugging campaign).

### Physical-settlement ambiguity handling
The redemption gate (maturity + production cap) runs BEFORE the burn;
redeemed counts are RE-DERIVED from the teller ticket store (the
authoritative burn record) on boot and after every settle — a crash
between handover and accounting self-heals on the next pass.

### Charger refactor performed
`payout::receipt_for_rail("farm")` beside the other rails; the
lifecycle-mapping table above; the farm module deliberately reuses the
ticket store, event channel, sweeper cadence, and snapshot lessons
(price/terms frozen per purchase). Plus two ops repairs discovered by the
spike: the server's `ev-charge.py` had drifted to a 36 s/€ tariff
(charger-V smoke timeout) — deploy.sh now syncs it; and the ev-rail
slider-text regex had been stale since the currency-agnostic copy change.

### Automated tests and results
- processor: **101 passed** (12 farm: grammar, capacity, races, expiry
  release, payment-before-issuance, one-quote-per-purchase, maturity +
  shortfall gating, aggregate-only privacy).
- cdk fork: **7 nut32 tests** + 602 existing cashu tests compile/run.
- web vitest: **83 passed** (incl. BIP-340 client-side verify pin).
- e2e: **farm.spec.ts 3/3 green on prod** (sarah_buys_five_friday_eggs_
  with_signet — 5000 real sats; capacity invariant; immature-redemption
  refusal). Smoke suite **16/16**, ev-rail deposit pattern **green**,
  charger-V **green**.
- api-smoke: **PASS** (all four pairs + the NUT-32 section); reconcile
  clean on all four pairs.

### Remaining technical debt
1. The generic coco receive pipeline wedges fresh contexts (Bob's
   receive goes through our tagged-swap core instead).
2. addMint crawls super-linearly on dozens of dated keysets — the horizon
   is capped at 10 days; a keyset-pagination/lazy-fetch fix in coco is
   the real repair.
3. Terms-blob signing happens at bootstrap only; re-signing after a mintd
   identity change is manual (re-wipe).
4. The farm pair's mintd is a fork image — upstreaming NUT-32 (or a
   plugin API) is the long-term home; the melt-method name over gRPC
   (upstream PR #2275) still forces unit-based routing.
5. Paid-claim-window releases capacity after 24 h with the sats kept — a
   real deployment needs a refund rail.

### Smallest next experiment
Fix coco's addMint keyset handling (lazy per-unit fetch) and raise the
horizon back to a month; then run a REAL seven-day maturity (no
demo override) end-to-end with a daily faucet top-up, proving the
timestamp path — everything else in the story is already live.
