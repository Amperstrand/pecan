# Pecan — NOK Cashu giftcard mint (pecan processor + coco 2 web wallet)

Cashu mint at https://giftcard.cashu.exchange (inr2, 46.224.104.12) running:
`giftcard-mint-mintd-1` (cdk-mintd 0.18.0-rc.0, :8089), `pecan-pecan-1`
(Rust teller/processor + embedded web dist, :50054/:9091), `pecan-sandbox-1`,
caddy :443. Payment method is the custom `branch` method (manual teller
settlement); unit `nok`; amounts in øre internally.

## Rule: persist verification as automated tests and tooling

**Never leave verification manual.** Any flow checked by hand in a browser
MUST end up as a Playwright test under `web/e2e/` (helpers in
`web/e2e/helpers/`), and any multi-command procedure used more than once
MUST end up as a script under `scripts/`. Future sessions (and CI) re-run
these without spending LLM tokens on browser driving.

- Browser wallet tests: `cd web && npx playwright test` (targets prod; admin
  login + teller match-and-settle happen through the real HTTP API).
- Deploy: `scripts/deploy.sh` (rsync → docker build → compose up → verify).
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

- `Dockerfile` runs `rm -f package-lock.json && npm install` on purpose:
  the macOS lockfile lacks the linux rolldown native binding (npm/cli#4828).
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
