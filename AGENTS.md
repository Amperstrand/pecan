# Pecan — NOK Cashu giftcard mint (pecan processor + coco 2 web wallet)

Cashu mint at https://giftcard.cashu.exchange (inr2, 46.224.104.12) running:
`giftcard-mint-mintd-1` (cdk-mintd 0.18.0-rc.0, :8089), `pecan-pecan-1`
(Rust teller/processor + embedded web dist, :50054/:9091), `pecan-sandbox-1`,
caddy :443. Unit `nok`; amounts in øre internally.

Two minting rails, ONE processor (cdk-mintd allows a single gRPC processor;
methods come from its get_settings): `branch` (teller code at the counter)
and `ln` (real bolt11 invoice on the signet CLN node `cln-clboss-signet`,
NOK→sat converted in pecan from a public rate + 10% markup). Melting is
teller-only — the mint is one-way by construction. The payment-processor
proto cannot carry the method name yet (upstream PR #2275), so the wallet
tags the rail in the flattened extra fields (`{"rail":"ln"}`) and the
processor routes on it. See docs/lightning-mint.md. NOTE: the mint must be
restarted after any pecan recreate (deploy.sh does this) or quotes fail
with "Invalid payment method".

## Rule: persist verification as automated tests and tooling

**Never leave verification manual.** Any flow checked by hand in a browser
MUST end up as a Playwright test under `web/e2e/` (helpers in
`web/e2e/helpers/`), and any multi-command procedure used more than once
MUST end up as a script under `scripts/`. Future sessions (and CI) re-run
these without spending LLM tokens on browser driving.

- Browser wallet tests: `scripts/e2e.sh` (fetches the generated admin
  password from the server and runs Playwright against prod; teller
  match-and-settle happen through the real HTTP API). The processor
  generates a RANDOM admin password on first boot and persists it to
  /opt/pecan-config/initial-admin-password.txt (0600; delete after first
  login). /api/login is throttled: 10 failures per (IP, username) per 60s.
- Unit tests: `cd web && npm test` (vitest). Fast inner loop — handler
  payload shapes, error mappings, and pure utils are pinned here; run these
  BEFORE deploying to iterate on logic without the e2e cycle.
- Deploy: `scripts/deploy.sh` (rsync source + deploy/docker-compose.prod.yml
  → docker build → compose up → verify). Fresh-Deploy behavior: empty
  /opt/pecan-config → random admin password (see above) + headless
  re-attachment to the mint via the INITIAL_* env vars in the compose. The
  mint (own compose at /opt/giftcard-mint) needs `cdk-mintd config init
  --file mint.toml` after its sqlite is wiped, and crash-loops until the
  processor is listening — start pecan first.
- Re-vendor the coco fork: `scripts/vendor-coco.sh [version]`.
- Spec-quote drift: `scripts/spec-quote-check.sh` (greatspectations). Where a
  NUT requirement is implemented, embed the verbatim spec line as a
  `// NUT #<id>: ...` comment — the check fails when the NUTs change under
  us. Prereqs + marker syntax: see the script header.
- Before shipping wallet changes: run the spec green, then deploy.

## Layout

- `web/src/lib/coco/` — coco 2 wallet integration: `branch-methods.ts`
  (method registries via declaration merging), `mint-branch-handler.ts`,
  `melt-branch-handler.ts`, `coco-wallet.ts` (UI-facing API, seed in
  localStorage `giftcard-coco-seed-v1`, IDB `giftcard-coco-wallet`).
- `web/vendor/` — pinned tarballs of the `Amperstrand/coco` fork
  (github.com/Amperstrand/coco, branch `main`, dist committed; fork carries
  the custom-method extensibility fixes — see its git log).
- `web/src/pages/wallet.tsx` — coco wallet UI (`/console/wallet`);
  `wallet-classic.tsx` — legacy cashu-ts wallet (`/console/wallet-classic`).
- `processor/` — Rust cdk payment processor for `branch` (gRPC to mintd) +
  teller/operator web UI. SPA routes served from `processor/src/web.rs`.
- `mintctl/` — mint install/wizard tooling.

## Gotchas

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
