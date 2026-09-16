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
   `cashu` crate): `future:<base>-<quote>:<YYYYMMDD>T<hhmmss>Z` parser
   (rejects lowercase `t`/`z`, offsets, fractional seconds, impossible
   dates) and the exactly-one `["future","1","<terms-uri>"]` tag check
   with a canonical content-addressed URI shape (https, last path
   segment a 64-char sha256).
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
