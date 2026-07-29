# Custom Unit Mint

Browser-managed [Cashu](https://cashu.space) mint for custom units. It runs a
pinned `cdk-mintd` with the managed-unit compatibility patch in this repository
and a separate `cdk-branch-processor` that settles mint/melt quotes manually
through an operator web UI.

## Quick Start

```sh
docker compose up --build
```

Open:

| Surface | URL | Purpose |
|---|---|---|
| Operator UI | http://localhost:9090 | operator console and teller workflow |
| Mint API | http://localhost:8089 | wallet-facing Cashu API |

First build compiles CDK from source. There is no setup wizard: the first boot
bootstraps a complete configuration (generated recovery phrase, method
`branch`, no units) and the mint starts automatically — running, but offering
nothing to wallets yet. Sign in with the demo credentials **`admin` / `admin`**
and change the password from the console's **Access** tab before real use — the
UI warns until you do. Then add the first unit from the console's **Units** tab
to start issuing ecash. Everything chosen at bootstrap (identity, wallet-facing
URL, keyset policy, users) stays editable from the console; only the recovery
seed is immutable. Back up the recovery phrase from **Mint → Reveal recovery
phrase**.

To use different host ports:

```sh
MINT_PORT=18089 UI_PORT=19090 docker compose up --build
```

To update an existing deployment without deleting data:

```sh
git pull
docker compose up --build --force-recreate -d
```

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
  - **Mint**: wallet-facing identity, fixed endpoints, and recovery-phrase
    reveal (requires re-entering your password).

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

Normal rebuilds and recreates keep these volumes. **Upgrade note:** settle or
cancel open teller work before deploying this version — tickets written by the
removed quote-offer flow have no mint quote id, so any still-open ones are
voided on first load (settled history is preserved).

To reset everything for a fresh local demo:

```sh
docker compose down -v
```

Do not reset a production mint without a backup. Move managed units to
**Redemption only** first: issuance stops while holders can still melt existing
ecash. A unit can be retired only after every historical keyset has reached its
final expiry.

## Security Notes

- Change the demo `admin`/`admin` password immediately; the console banner
  clears once you do. New and changed passwords must be at least 12 characters
  with a letter, a number, and a symbol.
- Back up the recovery phrase (**Mint → Reveal recovery phrase**). It restores
  the mint signing keys and cannot be changed.
- All users have full operator access; there are no roles. Instances upgraded
  from the single-password era keep their old password as user `admin`.
- The mint-to-processor gRPC link is plaintext inside the Compose network.
  Add TLS before running it across an untrusted network.

## Development

Build the frontend:

```sh
npm --prefix web install
npm --prefix web run build
```

Build the processor:

```sh
cd processor
cargo build
```

Run both through Docker for the production-like path:

```sh
docker compose up --build
```

## Project Layout

```text
.
├── docker-compose.yml
├── Dockerfile
├── web/                 # React/Vite operator UI, built into the image
├── processor/           # branch payment processor and web/API server
├── patches/             # narrow patch applied to the pinned cdk-mintd source
├── scripts/             # container lifecycle helpers
└── config/mint.toml     # reference config; default deploy generates its own
```

## CDK Version

The image builds `cdk-mintd` and the processor against the same pinned CDK
commit:

```text
6132607495ae0741e412a63f2acc34e4ccddfc55
```

Keep `Dockerfile` and `processor/Cargo.toml` in sync when updating CDK.
Rebase and revalidate `patches/cdk-managed-units.patch` at the same time,
and confirm the mint's `keyset_amounts` table still matches the read in
`processor/src/supply.rs` (the supply audit's only schema coupling).
