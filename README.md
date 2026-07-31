# Custom Unit Mint

Browser-managed [Cashu](https://cashu.space) mint for custom units. It runs a
pinned `cdk-mintd` with the managed-unit compatibility patch in this repository
and a separate `cdk-branch-processor` that settles mint/melt quotes manually
through an operator web UI.

## Install

On a Linux server (amd64 or arm64) with DNS prepared as below:

```sh
curl -fsSL https://raw.githubusercontent.com/zeugmaster/custom-unit-mint/main/install.sh | bash
```

The installer asks one question — your domain — and does the rest: it offers
to install Docker if missing, resolves the latest release, downloads that
release's deployment files into `/opt/custom-unit-mint`, generates a strong
admin password, pulls the prebuilt image from GHCR, starts the stack with
automatic HTTPS (bundled Caddy + Let's Encrypt), and prints your login. No
config file is ever edited by hand; everything else is managed from the
running console.

Prepare DNS first (both records pointing at the server), and open ports 80
and 443:

| Record | Name | Serves |
|---|---|---|
| A/AAAA | `mint.example.org` | wallet-facing Cashu API |
| A/AAAA | `console.mint.example.org` | operator console (default `console.<domain>`) |

Skipping the domain question installs in plain-HTTP mode on ports 9090
(console) and 8089 (mint) — fine for a trusted LAN or testing, not for the
public internet (wallets generally refuse plain-HTTP mints).

Non-interactive form and all flags (`--domain`, `--dir`, `--version`,
`--ui-port`, …): see the header of [`install.sh`](install.sh) or run
`mintctl help`.

First steps in the console (there is no setup wizard — the first boot
bootstraps a complete configuration with a generated recovery phrase, method
`branch`, and zero units):

1. **Units** tab — add the first unit. The mint stays in **Standby** until
   one exists (`cdk-mintd` needs at least one payment backend), then starts
   and begins issuing ecash.
2. **Mint** tab — reveal the 24-word recovery phrase and back it up. It is
   immutable and restores the mint's signing keys.
3. **Access** tab — change the password if you did not keep the printed one,
   and add teller accounts.

## Operations

The installer drops `mintctl` into the install directory (and symlinks it to
`/usr/local/bin/mintctl`):

| Command | What it does |
|---|---|
| `mintctl status` | containers, health, supervisor state, installed vs. latest version |
| `mintctl logs [service]` | follow logs (`processor`, `mint`, `caddy`) |
| `mintctl update [--version vX.Y.Z]` | upgrade to a release: fetches that release's deployment files and image together, restarts, verifies health |
| `mintctl backup [file]` | stop briefly, archive all three data volumes + `.env`, restart. **The archive contains the recovery seed — store it encrypted, off the server** |
| `mintctl restore <file>` | replace all state with an archive's contents |
| `mintctl start` / `stop` | bring the stack up / down (volumes kept) |
| `mintctl uninstall [--purge]` | remove containers; `--purge` also deletes volumes and the install dir (destroys the mint — typed confirmation required) |

Deeper procedures — restore drills, migrating servers, running a second
instance, bringing your own reverse proxy, switching HTTP → TLS — live in
[`docs/operations.md`](docs/operations.md).

## What The UI Does

Two pages, monochrome:

- **Teller** (`/teller`) — match-first till. Customers create quotes in their
  own wallet; the teller resolves the right one by entering the last 6+
  characters of the quote id from the customer's wallet screen (or scanning
  the full id with a handheld scanner), then settles it with at most two big
  buttons: interrupt (outline, left) or proceed (solid, right). The open-quote
  list shows truncated ids only, so a quote can never be settled without the
  customer's code.
- **Operator Console** (`/`) — everything else, in four tabs:
  - **Overview**: health, circulating ecash, unit balances, settled activity.
  - **Units**: add units, edit each unit's keyset policy, rotate keysets, and
    migrate lifecycles (**Active**, **Redemption only**, **Retired**) for the
    branch payment method. Units advertised by the mint but not managed here
    appear read-only.
  - **Access**: the user database — add or delete operators, reset passwords,
    change your own.
  - **Mint**: wallet-facing identity, deployment endpoints, running version,
    and recovery-phrase reveal (requires re-entering your password).

Config changes restart the stack automatically; the console waits for it to
come back and sessions survive the restart.

## Settlement Flow

Deposit (mint):

1. The customer's wallet creates a NUT-20-locked mint quote at the mint
   (`POST /v1/mint/quote/branch`) and shows its quote id.
2. The teller matches the quote — scans the id or types its last 6+
   characters — and checks the amount with the customer.
3. Customer hands over cash; teller presses **Cash received**. The mint marks
   the quote paid and the wallet mints the ecash (only that wallet can — the
   quote is locked to its key, so the quote id is not a bearer secret).

Withdrawal (melt):

1. The customer's wallet creates a melt quote (`POST /v1/melt/quote/branch`)
   declaring the payout amount, then pays its ecash into it — the mint locks
   the proofs before any cash moves.
2. The teller matches the melt quote id the same way. The card blocks payout
   until the wallet's funds are locked ("Awaiting wallet" → "Ready to pay
   out").
3. Teller hands over cash and presses **Cash paid out**; the mint finalizes
   the melt. **Void** at any earlier point releases the customer's proofs.

Abandoned quotes expire at the mint (30 min for deposits, 15 min for
withdrawals) and the processor deletes expired, never-funded tickets
automatically.

## Supply Figures

The console's circulation numbers are **audited from the mint's own
database**, not inferred from teller activity: the processor reads the mint's
per-keyset `keyset_amounts` table (issued / redeemed / fees, maintained by
cdk on every signature and spend) over a read-only connection and joins it
with each keyset's final expiry. Per unit it reports:

- **Live supply** — outstanding ecash under keysets that can still be
  redeemed. This is the real circulation figure.
- **Demonetized** — ecash issued under keysets that passed their final
  expiry without being swapped forward or melted. It is gone for good and is
  deliberately *not* counted as circulating.
- **Net settled** — the teller ledger (settled deposits minus payouts), kept
  for reconciliation. It stays above live supply by the demonetized amount,
  collected input fees, and any paid-but-never-minted quotes.

If the processor cannot reach the mint database (for example a dev rig
without the shared volume — unset or empty `CDK_BRANCH_PROCESSOR_MINT_DB_PATH`
disables the audit), the console falls back to the teller ledger and labels
it accordingly.

## Wallet Integration Contract

Wallets talking to a branch mint must:

- create **locked** mint quotes: `POST /v1/mint/quote/branch` with `amount`,
  `unit`, and a NUT-20 `pubkey` (unlocked quotes are rejected), then sign the
  mint request with that key;
- display the quote id for the teller: as text with the **last 6 characters
  emphasized**, and as a QR encoding the **bare quote id** (no URL scheme —
  handheld scanners type the payload verbatim into the match field);
- poll `GET /v1/mint/quote/branch/{quote_id}` (or subscribe via NUT-17) and
  mint once `amount_paid` covers the quote;
- for withdrawals: `POST /v1/melt/quote/branch` with `unit`, a free-form
  `request` memo, and the payout declared as a flattened `amount` field, then
  submit the melt with proofs. The melt may exceed the 60 s synchronous
  window — handle the pending-timeout response and keep polling the melt
  quote;
- expect rejections to surface as generic mint errors (cdk flattens payment
  processor errors); the specific reason — missing pubkey, unmanaged unit,
  amount limits, too many open quotes — is logged by the mint and processor.

## Persistence

Docker Compose uses named volumes:

| Volume | Data |
|---|---|
| `config-data` | generated config (`setup.json`), `mint.toml`, user accounts (`users.json`) |
| `mint-data` | `cdk-mintd` database (also mounted into the processor, which opens it read-only for the supply audit) |
| `processor-data` | branch ticket store, login sessions, config backup |
| `caddy-data`, `caddy-config` | TLS certificates and Caddy state (TLS mode only) |

Updates and recreates keep these volumes. `mintctl backup` / `restore` are
the supported way to snapshot and move them.

To reset everything for a fresh local demo:

```sh
docker compose down -v
```

Do not reset a production mint without a backup. Move managed units to
**Redemption only** first: issuance stops while holders can still melt existing
ecash. A unit can be retired only after every historical keyset has reached its
final expiry.

## Security Notes

- Installed via `install.sh`, the admin account starts with a generated
  password (printed once, kept in `<install-dir>/.env` as a fallback). A bare
  `docker compose up` dev deployment seeds demo **`admin`/`admin`** instead —
  change it immediately; the console banner clears once you do. Passwords
  must be at least 8 characters; there are no composition rules.
- Back up the recovery phrase (**Mint → Reveal recovery phrase**). It restores
  the mint signing keys and cannot be changed.
- All users have full operator access; there are no roles. Instances upgraded
  from the single-password era keep their old password as user `admin`.
- In TLS mode the bundled Caddy is the only public surface (the app ports
  bind to 127.0.0.1) and session cookies are marked `Secure` automatically.
- The mint-to-processor gRPC link is plaintext inside the Compose network.
  Add TLS before running it across an untrusted network.

## Development

From a checkout, `docker-compose.override.yml` adds a local build (tagged
`custom-unit-mint:dev`), so the classic flow keeps working:

```sh
docker compose up --build
```

Console on http://localhost:9090 (demo `admin`/`admin`), mint API on
http://localhost:8089 once the first unit exists. Different host ports:
`MINT_PORT=18089 UI_PORT=19090 docker compose up --build`. To exercise the
exact production shape (published image, no local build), use
`docker compose -f docker-compose.yml up` with a `.env` (see `.env.example`).

Frontend and processor on their own:

```sh
npm --prefix web install
npm --prefix web run build

cd processor
cargo build
cargo test
```

To update a pre-installer deployment created from this checkout: `git pull`
then `docker compose up --build --force-recreate -d` (volumes are kept).
**Upgrade note:** settle or cancel open teller work before deploying this
version — tickets written by the removed quote-offer flow have no mint quote
id, so any still-open ones are voided on first load (settled history is
preserved).

CI (`.github/workflows/`) builds and tests every PR, verifies the cdk patch
still applies to the pinned rev, and publishes multi-arch images to
`ghcr.io/zeugmaster/custom-unit-mint` — `edge` on every main commit,
`vX.Y.Z` + `latest` on release tags. The GitHub Release is created only
after the images exist and pass a boot smoke test, so the installer can
never resolve a broken version.

## Project Layout

```text
.
├── install.sh                 # curl-able installer; installed as mintctl
├── docker-compose.yml         # production deployment (published image)
├── docker-compose.override.yml# dev-only: adds the local build
├── Caddyfile                  # TLS termination template (profile "tls")
├── .env.example               # every deployment knob, documented
├── Dockerfile
├── .github/workflows/         # CI + multi-arch GHCR publishing
├── docs/operations.md         # restore drills, migrations, BYO proxy
├── web/                       # React/Vite operator UI, built into the image
├── processor/                 # branch payment processor and web/API server
├── patches/                   # narrow patch applied to the pinned cdk-mintd source
├── scripts/                   # container lifecycle helpers (supervisor, healthcheck)
└── config/mint.toml           # reference config; default deploy generates its own
```

## CDK Version

The image builds `cdk-mintd` and the processor against the same pinned CDK
commit:

```text
6132607495ae0741e412a63f2acc34e4ccddfc55
```

Keep `Dockerfile` and `processor/Cargo.toml` in sync when updating CDK (CI's
`patch-check` job asserts this). Rebase and revalidate
`patches/cdk-managed-units.patch` at the same time, and confirm the mint's
`keyset_amounts` table still matches the read in `processor/src/supply.rs`
(the supply audit's only schema coupling).
