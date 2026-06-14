# Custom Unit Mint

Browser-managed [Cashu](https://cashu.space) mint for a custom unit. It runs
stock `cdk-mintd` and a separate `cdk-branch-processor` that settles mint/melt
quotes manually through an operator web UI.

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

Do not reset a production mint without backing up and draining operational
records.

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
└── config/mint.toml     # reference config; default deploy generates its own
```

## CDK Version

The image builds `cdk-mintd` and the processor against the same pinned CDK
commit:

```text
bc7e441ef2fc4cb0d57b84c4757ee023704c922f
```

Keep `Dockerfile` and `processor/Cargo.toml` in sync when updating CDK.
