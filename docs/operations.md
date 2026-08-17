# Operations Guide

Procedures beyond the README's quick reference. Everything here assumes an
installation created by the installer (deployment files + `.env` + the
`mintctl` binary in one directory, default `/opt/pecan`).

Scope note: this stack is the **branch processor** — the payment backend and
teller console that attaches to one cdk-mintd you operate. The mint itself
(its seed, database, backups, keysets, TLS for the wallet-facing URL) is
yours to run with cdk's own tooling; nothing here manages it.

## The .env file

`mintctl` and Docker Compose read all deployment configuration from
`<install-dir>/.env`. Every key is documented in `.env.example` next to it.
The important ones:

| Key | Meaning |
|---|---|
| `VERSION` | image tag to run (`vX.Y.Z`); changed by `mintctl update` |
| `COMPOSE_PROJECT_NAME` | prefixes container and volume names; never change it on an existing install (the volumes would be orphaned) |
| `UI_PORT` | host port for the operator console |
| `BIND_ADDR` | host interface for the console port: `127.0.0.1` in TLS and behind-proxy modes, `0.0.0.0` in plain-HTTP mode |
| `COMPOSE_PROFILES` | `tls` enables the bundled Caddy for the console |
| `CONSOLE_DOMAIN` | hostname Caddy serves and gets certificates for |
| `INITIAL_ADMIN_PASSWORD` | first boot only — seeds the admin account (change forced at first sign-in); inert once `users.json` exists |
| `ACME_EMAIL` | optional; `mintctl update` re-applies it to the Caddyfile |
| `GRPC_BIND_ADDR` / `GRPC_PORT` | where the payment gRPC is published for your mintd (loopback:50051 by default; plaintext gRPC has no auth — firewall it or use TLS) |
| `GRPC_TLS_DIR` | optional mutual TLS for the payment gRPC (see `.env.example`) |

Prefer `mintctl domain` over hand-editing the access keys; for anything else,
apply `.env` edits with `mintctl stop && mintctl start`.

## Attaching your mint

Everything happens in the console's **Mint tab**:

1. Set the **unit** (e.g. `ora`) and the mint's public **URL** — the same URL
   wallets use. Setup applies live; no restart.
2. Copy the generated **config snippet** into your mintd's `mint.toml`
   (a complete example lives at `docs/examples/mint.toml`) and restart your
   mintd.
3. Watch the **attachment checklist** settle: reachable → advertised →
   linked → keys → end-to-end. Every failing check comes with the exact
   remedy.
4. The **self-test** (runs automatically on first attach; button to re-run)
   creates one deposit and one payout quote at the mint, verifies both arrive
   at this processor, then voids them. It also measures the mint's quote
   lifetimes and warns when they are too short for a counter visit.

Compatibility: your mintd must be built from the cdk revision shown in the
Mint tab (PR cashubtc/cdk#2295 — payment-processor protocol 4.0.0, strict
equality at connect time). Until an upstream release contains the PR,
`docker/mintd/Dockerfile` in the repo builds a compatible mintd.

The **unit locks** after the first successful self-test: issued ecash and
quotes reference it. Changing a locked unit means starting over deliberately —
stop the processor, edit `unit` and `unit_locked` in `setup.json` on the
config volume, and accept that existing tickets for the old unit remain
history-only.

Advertisement pinning heads-up (a cdk behavior the checklist detects): while
`[mint_management_rpc]` is enabled, cdk-mintd pins its advertised capabilities
to the database at first boot — adding the `[[ln]]` entry to an existing mint
later will not show up in `/v1/info`. Either restart the mint with the RPC
disabled once, or update the stored advertisement over the RPC
(`cdk-mint-cli update-nut04` / `update-nut05`).

## Persistence

Docker Compose uses named volumes:

| Volume | Data |
|---|---|
| `config-data` | processor config (`setup.json`), user accounts (`users.json`) |
| `processor-data` | branch ticket store (`tickets.json`), login sessions |
| `caddy-data`, `caddy-config` | TLS certificates and Caddy state (TLS mode only) |

Updates and recreates keep these volumes. `mintctl backup` / `restore` are
the supported way to snapshot and move them. The mint's data lives wherever
you run the mint — it is not part of this stack. To reset the processor for
a fresh local demo: `docker compose down -v`.

## Backup and restore drill

```sh
mintctl backup /root/branch-$(date +%F).tar.gz     # brief downtime
```

The archive contains the processor's two data volumes and `.env`: operator
accounts (password hashes), the attachment configuration, and the ticket
ledger. Encrypt it (e.g. `age`/`gpg`) and store it off the server. **It does
not contain any mint data** — the mint's seed and database are backed up by
whoever operates the mint.

Restore onto the same install:

```sh
mintctl restore /root/branch-2026-08-04.tar.gz     # replaces the processor's state
mintctl status
```

Verify after any restore: console reachable, sign-in works, the Mint tab
checklist settles green against your mint, the teller's recent activity shows
the expected history.

## Migrating to a new server

1. Old server: `mintctl backup`, copy the archive off.
2. New server: run the installer (same console domain if you use one; DNS can
   move afterwards — certificates re-issue automatically).
3. New server: `mintctl restore <archive>`.
4. Update your mintd's `[grpc_processor].address` if the processor's address
   changed, restart the mintd, and watch the checklist settle.
5. Point DNS at the new server; verify; decommission the old install
   (`mintctl uninstall --purge` only after the new one is verified).

## Migrating from the bundled mint (pre-0.2 installs)

Installs created before 0.2 bundled a managed cdk-mintd in the same compose
project. `mintctl update` refuses to update them in place, because the new
compose file has no mint service and the update would remove the mint
container. To migrate:

1. Take a `mintctl backup` with the OLD version (it still includes the
   `mint-data` volume).
2. Move the mint out: run cdk-mintd yourself — reuse the old `mint-data`
   volume (or copy it) and the last generated `mint.toml` from the config
   volume. The mint's recovery mnemonic is inside that `mint.toml`; it is
   yours now — back it up.
3. Update the install. On first start the processor migrates its
   configuration automatically: the old `setup.json` (which also contains the
   mnemonic) is preserved as `setup.json.v3-managed.bak` on the config volume
   and is never deleted; the console shows a one-time notice.
4. In the Mint tab, confirm the attachment (URL of your now-self-run mint)
   and run the self-test. Note: the mint must be rebuilt from the compatible
   cdk revision (the old bundled build predates the required protocol).
5. The old `mint-data` volume is no longer referenced by compose; remove it
   only after the mint runs elsewhere and is verified.

## Running a second instance on one host

```sh
curl -fsSL .../install.sh | bash -s -- --dir /opt/second-branch \
    --ui-port 19090 --grpc-port 51051 --console-domain console2.example.org
```

Each install directory is fully self-contained (own project name, volumes,
ports — including the published gRPC port). TLS mode note: ports 80/443 can
only be bound by one instance — for several TLS instances, run one shared
reverse proxy instead (next section).

## Bringing your own reverse proxy

If the host already runs nginx/Traefik/Caddy, the installer detects the
occupied ports 80/443 and suggests behind-proxy mode; `mintctl domain`
switches an existing install the same way. In that mode the console binds
loopback only and a ready-to-paste server block lands in
`<install-dir>/proxy-snippets/` (Caddy and nginx flavors, with the details
that matter baked in):

- targets `127.0.0.1:$UI_PORT`,
- forwards `X-Forwarded-Proto` — the processor uses it to mark session
  cookies `Secure`,
- streams the console's SSE endpoint (`GET /events`) unbuffered.

The payment gRPC is **not** proxied — your mintd connects to it directly.

## Changing how the console is reached

`mintctl domain` re-runs the access step on a running install — plain HTTP →
domain with automatic HTTPS, a new domain, or behind-your-own-proxy — with
the same DNS live-check and certificate wait as the installer
(non-interactive: `mintctl domain --console-domain new.example.org --yes`).
It updates `.env`, re-renders the proxy snippet when applicable, and
recreates the affected containers.

## Updates and rollback

`mintctl update` moves the deployment files, the `mintctl` binary, and the
image **together** to a release tag, then waits for `/healthz` and compares
the reported version. Roll back the same way: `mintctl update --version
vX.Y.Z` with the previous tag. Data volumes are untouched in both
directions; take a backup before major updates anyway.

## Health and monitoring

- `GET http://127.0.0.1:$UI_PORT/healthz` (or `https://<console-domain>/healthz`)
  — unauthenticated liveness + running version; wire it into uptime checks.
  An unattached processor is healthy by design — attachment truth lives in
  the authenticated checklist.
- `docker ps` shows the container healthcheck; `mintctl status` summarizes.
- Subsystem detail (mint reachable, advertisement, gRPC link, keys,
  end-to-end) is the Mint tab's checklist; the Overview tiles mirror it.
