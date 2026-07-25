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
| Operator UI | http://localhost:9090 | setup, teller workflow, dashboard, keysets |
| Mint API | http://localhost:8089 | wallet-facing Cashu API after setup |

First build compiles CDK from source. On first launch, open the operator UI and
complete browser setup. The mint container waits until setup writes
`mint.toml`, then starts automatically.

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

- First-run mint provisioning: name, unit, method, wallet-facing URL, recovery
  phrase, operator password, and keyset expiry policy.
- Teller workflow for one active branch quote at a time.
- Manual cash settlement for mints and melts.
- Keyset inventory and rotation through `cdk-mintd` management RPC.
- Multi-unit branch configuration with explicit **Active**, **Redemption only**,
  and **Retired** lifecycle migrations.
- Read-only discovery of every method/unit pair advertised by the mint.
- Dashboard health, settled activity, and circulating ecash over time.

## Settlement Flow

Minting:

1. Teller creates a **Cash deposit** quote.
2. Wallet scans the quote QR code.
3. Customer pays cash.
4. Teller clicks **Cash received**.
5. Wallet receives ecash from the mint.

Melting:

1. Teller creates a **Cash dispense** quote.
2. Wallet scans the quote QR code and submits proofs.
3. Proofs go pending.
4. Teller hands over cash and clicks **Cash handed over**.
5. The mint finalizes the melt.

## Persistence

Docker Compose uses named volumes:

| Volume | Data |
|---|---|
| `config-data` | generated setup config and `mint.toml` |
| `mint-data` | `cdk-mintd` database |
| `processor-data` | branch ticket JSON store |

Normal rebuilds and recreates keep these volumes. To reset everything for a
fresh local demo:

```sh
docker compose down -v
```

Do not reset a production mint without a backup. Move managed units to
**Redemption only** first: issuance stops while holders can still melt existing
ecash. A unit can be retired only after every historical keyset has reached its
final expiry.

## Security Notes

- Back up the recovery phrase from setup. It restores the mint signing keys.
- Use a strong operator password. Sessions are single-operator and expire, but
  this is not a multi-user admin system.
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
Rebase and revalidate `patches/cdk-managed-units.patch` at the same time.
