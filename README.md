# Custom Unit Mint

A [Cashu](https://cashu.space) mint for a **custom unit** where every mint and
melt is settled by hand — a branch operator exchanges physical cash for ecash
and confirms it in a web UI. It ships configured for an example unit, `ora`,
but works for any custom unit you choose (one env var + one config line).

It runs **stock, unmodified [`cdk-mintd`](https://github.com/cashubtc/cdk)**.
All the custom behaviour lives in a separate process, `cdk-branch-processor`,
which the mint talks to over cdk's gRPC payment-processor interface. The mint
itself is configured, not patched.

```
   Cashu wallet
        │  NUT-04 mint / NUT-05 melt  (unit = ora, method = branch)
        ▼
┌──────────────────┐        gRPC         ┌──────────────────────────────┐
│   cdk-mintd      │  ◄───────────────►  │      cdk-branch-processor     │
│  (stock cdk)     │  payment processor  │  • "branch" payment backend   │
│   :8089 public   │   protocol v3.0.0   │  • operator web UI  :9090     │
│   :8091 mgmt RPC │ ◄─── keyset rotate  │  • ticket store (JSON)        │
└──────────────────┘                     └──────────────────────────────┘
                                                     ▲
                                          branch operator marks
                                          quotes paid after the
                                          cash changes hands
```

## Why it works this way

cdk-mintd already knows how to delegate a currency unit to an external payment
processor (`ln_backend = "grpcprocessor"`). We use that hook to plug in a
backend that has nothing to do with Lightning: minting and melting the unit is
a manual cash transaction, and the processor just records intent and waits for
a human to confirm settlement.

That keeps the trust model simple and one-directional. On melt, the customer's
ecash is locked (the proofs go pending) the moment they submit the melt
request — *before* any cash is handed over. The operator confirms the cash
handover in the UI, which finalises the melt and spends the proofs. The
customer can't take the cash and then refuse to pay.

## Quick start

```sh
docker compose up --build
```

First build takes a while — it compiles cdk from source. Then:

| What | URL | Notes |
|------|-----|-------|
| Mint (wallet-facing) | http://localhost:8089 | NUT endpoints; `/v1/info`, `/v1/keys` |
| Operator web UI | http://localhost:9090 | log in with the operator password |

Default operator password is `branch-admin` (override with
`OPERATOR_PASSWORD`). Point a Cashu wallet that supports custom units at
`http://localhost:8089` and you'll see a mint that issues `ora`.

To reach it from other devices on your LAN, set `info.url` in
`config/mint.toml` to this host's LAN address and set
`CDK_BRANCH_PROCESSOR_MINT_PUBLIC_URL` to the same wallet-facing base URL.
The teller QR codes use that public URL; Docker Compose defaults it to
`http://localhost:8089`.

If ports 8089/9090 are taken, override the host ports without editing anything:
`MINT_PORT=18089 UI_PORT=19090 docker compose up`.

## How settlement works

**Minting (customer buys ecash with cash).**
1. Teller selects **Cash deposit**, enters the amount, and creates the quote.
2. The UI shows the mint quote id and a QR code for
   `/v1/mint/quote/branch/{quote_id}`.
3. Wallet scans the QR code, fetches the quote, and waits for payment.
4. Customer hands cash to the teller, who clicks **Cash received**.
5. The mint sees the payment and the wallet issues the ecash.

**Melting (customer redeems ecash for cash).**
1. Teller selects **Cash dispense**, enters the amount, and creates the quote.
2. The UI shows the melt quote id and a QR code for
   `/v1/melt/quote/branch/{quote_id}`.
3. Wallet scans the QR code, fetches the quote, and submits the melt with its
   proofs. The proofs go **pending**, and the UI changes from waiting for the
   wallet to ready for cash dispense.
4. Teller hands over the cash and clicks **Cash handed over** (or **Cancel**
   to fail the melt and release the proofs).
5. The mint finalises the melt; the proofs are spent.

The operator UI only allows one active quote at a time. The processor also
rejects direct wallet-created branch quotes unless they carry the teller
metadata created by the UI, so the amount comes from the teller workflow rather
than from a wallet-controlled `request` string. Melt settlement is still
correlated using the mint's `quote_id` (the field added in cdk PR
[#1973](https://github.com/cashubtc/cdk/pull/1973)).

## Keyset management & expiry

The operator UI lists the mint's keysets and can **rotate** to a fresh one,
optionally stamping the new keyset with a `final_expiry`. Expiry is enforced
**natively by the mint**: once a keyset's `final_expiry` is in the past, the
mint rejects any swap/mint/melt touching it with `ExpiredKeyset` (error
`12003`). `final_expiry` is immutable once a keyset is created — to retire a
keyset, rotate to a new one; ecash on the old keyset stops verifying when its
baked-in expiry passes.

## Configuration

**Mint** — `config/mint.toml`, all stock cdk-mintd options. The parts that tie
it to the custom unit are `[ln] ln_backend = "grpcprocessor"` and the
`[grpc_processor]` block pointing at the processor. To issue a unit other than
`ora`, change it in both `config/mint.toml` and `CDK_BRANCH_PROCESSOR_UNIT`.

**Processor** — environment variables (see `docker-compose.yml`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `CDK_BRANCH_PROCESSOR_UNIT` | `ora` | currency unit served |
| `CDK_BRANCH_PROCESSOR_METHOD` | `branch` | custom payment method name |
| `CDK_BRANCH_PROCESSOR_OPERATOR_PASSWORD` | — | web UI login password |
| `CDK_BRANCH_PROCESSOR_GRPC_PORT` | `50051` | gRPC the mint connects to |
| `CDK_BRANCH_PROCESSOR_HTTP_PORT` | `9090` | operator web UI |
| `CDK_BRANCH_PROCESSOR_MINT_RPC_URL` | — | mint management RPC (keyset rotate) |
| `CDK_BRANCH_PROCESSOR_MINT_HTTP_URL` | — | mint HTTP API (read keysets) |
| `CDK_BRANCH_PROCESSOR_MINT_PUBLIC_URL` | `CDK_BRANCH_PROCESSOR_MINT_HTTP_URL` | wallet-facing mint URL encoded in quote QR codes |
| `CDK_BRANCH_PROCESSOR_WORK_DIR` | `/var/lib/cdk-branch-processor` | ticket store location |

State persists across restarts: the mint in a SQLite DB (named volume
`mint-data`), the processor's tickets in a JSON file (`processor-data`).

## Security notes

This is a reference deployment. Before exposing it anywhere real:

- **Change the operator password** (`OPERATOR_PASSWORD`). The UI auth is a
  single static password with an in-memory session cookie — no user accounts,
  no rate limiting.
- **Change the mint seed** (`mnemonic` in `config/mint.toml`). The default is a
  well-known test seed; anyone who has it can forge the mint's keys.
- The mint↔processor gRPC is **plaintext**, fine on the compose-internal
  network but not across an untrusted one (cdk supports TLS for it).

## Pinned cdk version

Both the mint and the processor are built from the same cdk commit,
`bc7e441ef2fc4cb0d57b84c4757ee023704c922f` (the merge of PR #1973). They must
match: that merge bumped the payment-processor wire protocol to **3.0.0**, and
the mint↔processor version check is strict-equality. crates.io `0.16.0`
predates it and speaks protocol 2.0.0, so it can't be used here.

To move to a newer cdk: bump the `rev` in **both** `Dockerfile` (`CDK_REV`) and
`processor/Cargo.toml`, then `rm processor/Cargo.lock && docker compose build`.

## Layout

```
.
├── docker-compose.yml      # two services (mint, processor) from one image
├── Dockerfile              # builds stock cdk-mintd + the processor
├── config/mint.toml        # stock cdk-mintd config for the mint
└── processor/              # the custom payment processor (Rust)
    ├── Cargo.toml          # git-deps stock cdk at the pinned rev
    └── src/
        ├── backend.rs      # MintPayment impl for the "branch" method
        ├── clients.rs      # mint management-RPC + HTTP clients
        ├── state.rs        # persistent ticket store + event channels
        ├── web.rs          # operator UI (server-rendered, SSE live updates)
        └── main.rs         # wires the gRPC server and web UI together
```
