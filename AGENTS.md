# Pecan — EUR Cashu giftcard mint (pecan processor + coco 2 web wallet)

## Branch ownership

`main` belongs to **upstream** (zeugmaster/pecan). We do NOT merge our
deployment branch into it — that would overwrite upstream's direction.
Our work lives on `deployment` (or topic branches that upstream could
cherry-pick from). If we want to contribute back, we create clean
topic branches against upstream and submit PRs — we never force our
deployment state into main.

Cashu mint at https://giftcard.cashu.exchange (inr2, 46.224.104.12).
Multi-currency (issue #4): one (mintd + pecan) pair per currency, all
behind one domain with the path convention `{currency}/v1/*` for the mint
and `{currency}-console/*` for its pecan console:

| Pair | Mintd | Pecan | Paths |
|---|---|---|---|
| EUR | `giftcard-mint-mintd-1` :8089 | `pecan-pecan-1` :50054/:9091 | `/eur/v1/*`, `/eur-console/*` |
| USD | `giftcard-mint-usd-mintd-1` :8097 | `pecan-usd-pecan-1` :50055/:9093 | `/usd/v1/*`, `/usd-console/*` |

The ROOT `/v1` and `/console` are RESERVED for a future sats pair
(`/v1/*` answers 404 until then). Amounts are cents internally; one unit
per pair (cdk rc.0 allows a single gRPC processor per mintd). Adding a
currency = mintd (own mnemonic, `config init --work-dir`) + pecan
(INITIAL_UNIT env) + two caddy handles + one `CURRENCIES` entry in
`web/src/lib/coco/currency.ts`. NOTE: inr2 ports 8090/8094/8095 are
squatted by an unrelated service — pick fresh ports for new pairs.

THREE minting rails, ONE processor (cdk-mintd allows a single gRPC
processor; methods come from its get_settings): `branch` (teller code at
the counter), `ln` (real bolt11 invoice on the signet CLN node, EUR→sat
converted in pecan from a public rate + 10% markup), and `btc` (per-quote
bech32 address, esplora-watched, settles at
`CDK_BRANCH_PROCESSOR_ONCHAIN_CONFIRMATIONS` — **0 = mempool settlement on
this signet deployment**; use ≥1, realistically ≥6, on any value-carrying
network). Melting is teller-only — the mint is one-way by construction.
The payment-processor proto cannot carry the method name yet (upstream PR
#2275), so the wallet tags the rail in the flattened extra fields
(`{"rail":"ln"}`) and the processor routes on it. See
docs/lightning-mint.md — including the melt-saga design and its change-loss
postmortem. NOTE: the mint must be restarted after any pecan recreate
(deploy.sh does this) or quotes fail with "Invalid payment method".

## Rule: persist verification as automated tests and tooling

**Never leave verification manual.** Any flow checked by hand in a browser
MUST end up as a Playwright test under `web/e2e/` (helpers in
`web/e2e/helpers/`), and any multi-command procedure used more than once
MUST end up as a script under `scripts/`. Future sessions (and CI) re-run
these without spending LLM tokens on browser driving.

**Test ladder — always answer at the cheapest tier that can.** A full
e2e cycle costs 2-3 wall minutes, ~57k sat of payer liquidity, and
agent tokens to interpret; the tiers below answer most questions in
seconds with zero side effects:

1. `cd web && npm test` — pure wallet logic (parse, serialize, expiry).
2. `cd processor && cargo test` — pure processor logic + settle
   predicates.
3. `scripts/api-smoke.sh` — read-only HTTP invariants against prod:
   mint keys/info, one-way melt refusal (ln/btc, both pairs), console
   health, manifest, metrics auth, reconcile drift. The "is the
   deployment healthy" check — run after every deploy, before every
   e2e cycle.
4. Targeted e2e: `scripts/e2e.sh -g "cross-currency"` runs one test,
   not 25. Iterate on failures here.
5. Full suite: `scripts/e2e.sh` (verdict line at the end is greppable).
6. `scripts/soak.sh N` — repetition under liquidity/reconcile guards.

Coverage matrix (rail × currency, which file owns each cell, and which
rows are deliberately EUR-only shared machinery) lives as a comment
block atop `web/e2e/helpers/wallet-suite.ts` — keep it current when
adding tests.

- Browser wallet tests: `scripts/e2e.sh` (fetches BOTH generated admin
  passwords — EUR and USD — from the server and runs Playwright against
  prod; teller match-and-settle happen through the real HTTP API, waiting
  for the wallet's fund lock before paying out). The per-currency core
  (teller/lightning deposits, zero-change withdraw) lives in
  `web/e2e/helpers/wallet-suite.ts` and runs once per currency via
  `defineWalletSuite`; deep saga tests (onchain, reload, swap-kill) are
  EUR extras in `wallet.spec.ts`; USD adds the switcher check. With signet 0-conf the full suite
  runs in ~1 min; the onchain test adapts its timeout to block cadence if
  confirmations are ever required again. The suite also gates on the
  wallet's debug ring buffer (`web/src/lib/coco/wallet-log.ts`): no
  warn-level entries per test, zero change on finalized teller melts, and
  fund-lock release entries — failures attach the buffer as a Playwright
  artifact; enable the console mirror with `?debug=1` or localStorage
  `pecan-debug`. The processor generates a RANDOM
  admin password on first boot and persists it to
  /opt/pecan-config/initial-admin-password.txt (0600; delete after first
  login). /api/login is throttled: 10 failures per (IP, username) per 60s.
- Unit tests: `cd web && npm test` (vitest). Fast inner loop — handler
  payload shapes, error mappings, and pure utils are pinned here; run these
  BEFORE deploying to iterate on logic without the e2e cycle.
- Processor tests: `cd processor && cargo test` (66 tests, includes the
  onchain settle predicate for both 0- and ≥1-conf modes). CI runs them,
  but ONLY on `main` pushes and PRs — run locally before pushing
  `deployment`.
- Deploy: `scripts/deploy.sh` — rsync source to **ai-legion-small**,
  Docker build THERE (32GB RAM; inr2 OOMs on Rust builds), ship the image
  tar to inr2, compose up, restart the mint, verify the bundle. Fresh-Deploy
  behavior: empty /opt/pecan-config → random admin password + headless
  re-attachment via INITIAL_* env vars. The mint (own compose at
  /opt/giftcard-mint) needs `cdk-mintd config init --file mint.toml` after
  its sqlite is wiped, and crash-loops until the processor is listening —
  start pecan first.
- Re-vendor the coco fork: `scripts/vendor-coco.sh [version]` (typecheck +
  build + test the fork, pack, vendor). Then regenerate the LINUX lockfile
  (no local docker? rsync `web/` to ai-legion-small and run the
  `node:22-bookworm-slim` npm install from gen-web-lockfile.sh there).
- Spec-quote drift: `scripts/spec-quote-check.sh` (greatspectations). Where a
  NUT requirement is implemented, embed the verbatim spec line as a
  `// NUT #<id>: ...` comment — the check fails when the NUTs change under
  us. Prereqs + marker syntax: see the script header.
- Before shipping wallet changes: run the spec green, then deploy.

## Layout

- `web/src/lib/coco/` — coco 2 wallet integration: `branch-methods.ts`
  (method registries via declaration merging), `mint-branch-handler.ts`,
  `melt-branch-handler.ts` (eager teller melts + exact-amount pre-swap —
  see the gotchas), `coco-wallet.ts` (UI-facing API, seed in localStorage
  `giftcard-coco-seed-v1`, IDB `giftcard-coco-wallet`, reload-resume for
  pending AND prepared ops).
- `web/vendor/` — pinned tarballs of the `Amperstrand/coco` fork
  (github.com/Amperstrand/coco, branch `main`, dist committed; see the
  fork README's branch table for the upstream-PR pipeline).
- `web/src/lib/coco/currency.ts` — the currency registry: mint URL,
  console path, and symbol derive from the active currency (localStorage
  `pecan-currency`, default eur). Both mints are registered on one seed
  (keyset-scoped derivation — no cross-mint secret reuse).
- `web/src/pages/wallet.tsx` — coco wallet UI (`/eur-console/wallet`),
  EUR/USD switcher in the header.
- `processor/` — Rust cdk payment processor for `branch` (gRPC to mintd) +
  teller/operator web UI. SPA routes served from `processor/src/web.rs`.
  `processor/src/onchain.rs` — btc rail (esplora poller; pure
  `received_and_confirmations`/`settles` are unit-tested).
- `mintctl/` — mint install/wizard tooling.

## Gotchas

- `scripts/check-sensitive.sh` blocks phone-number-like data from being
  committed. Run it before pushing; wire as a pre-commit hook:
  `ln -s ../../scripts/check-sensitive.sh .git/hooks/pre-commit`.
  Test data uses dummies like `44000001` or `e2e-recipient` — never real
  phone numbers, emails, or names.

- `web/package-lock.json` is LINUX-generated (`scripts/gen-web-lockfile.sh`,
  run it whenever web/package.json or web/vendor changes): macOS npm drops
  the linux rolldown bindings (npm/cli#4828) and `npm ci` in the Docker
  build would fail. After local `npm install`, restore the committed
  lockfile (`git checkout web/package-lock.json`) before committing.

- Console roles: `admin` sees the Mint/Access tabs; plain tellers only
  match/settle. New users are tellers; the seeded account is admin.

- Custom NUT-05 melt requests to cdk-axum MUST include `method` and
  `request` fields in the body or the mint answers 400 "Invalid payment
  method" (see `melt-branch-handler.ts`).

- Custom NUT-04 mint quote requests need `unit` and (for locked giftcard
  deposits) `pubkey`; NUT-20 signatures are seed-derived per quote by coco's
  keyring.

- inr2 disk is tight (~38G): `docker builder prune -af` before big builds
  (deploy.sh does this).

- Wallet polls must treat `ops.*.refresh` errors as benign (lock contention
  with coco's background watchers, which own state progression).

- **Melt change is one-time knowledge.** The teller rail must melt EAGERLY
  (mark-paid refuses until the wallet locks funds: "waiting for the wallet
  to lock funds"), the mint burns inputs at that POST, and the overpay
  comes back as change signatures that state checks cannot re-fetch on
  cdk-mintd 0.18.0-rc.0. Therefore `MeltBranchHandler.needsSwapFor` swaps
  to EXACT amounts on any overshoot — exact melts return no change, and
  lost swap responses are recoverable via restore. Full story:
  docs/lightning-mint.md § Melt saga.

- **e2e onchain payer liquidity.** Every run burns ~7.4k sat (€50 is the
  mint's onchain minimum). The helper fails over across
  cln-hub/vls/nostr-signet. CLN reserves a wallet's inputs for ~144 blocks
  after a FAILED withdraw construction — a killed/stalled RPC bricks that
  node's wallet for a day, so the helper uses a 300s timeout and reports
  all three nodes' errors. Refill payers from cln-swap-signet (it receives
  every onchain deposit) or a signet faucet when they run dry.

- Wallet IndexedDB survives page reloads; force-clear button is the
  escape hatch (signet only). The EUR switch means old NOK operations in
  user browsers are inert (unit filter in getPendingDeposit skips them).

- Lessons that shaped the tooling (first soak session): single green
  runs hide ordering races — the two soak-found wallet bugs (backups
  exported in the boot window carrying `seed: null` because coco's
  seedGetter is lazy, and force-clear's deleteDatabase resolving on
  blocked, leaving the deletion racing the next page's open into a
  blank boot) were invisible to five consecutive passing runs. A config
  surface in a binary is not wiring (cdk-mintd rc.0 compiled
  cdk-prometheus but never started it; rc.3 needs DB-backed
  `config apply`, and ignores the CDK_MINTD_* listen env). Money in
  flight is invisible to confirmed-only balance reads: refill top-ups
  sit unconfirmed for one signet block, so liquidity guards must count
  pending outputs or freshly-refilled payers read as dry.
