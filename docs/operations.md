# Operations Guide

Procedures beyond the README's quick reference. Everything here assumes an
installation created by the installer (deployment files + `.env` + the
`mintctl` binary in one directory, default `/opt/custom-unit-mint`).

## The .env file

`mintctl` and Docker Compose read all deployment configuration from
`<install-dir>/.env`. Every key is documented in `.env.example` next to it.
The important ones:

| Key | Meaning |
|---|---|
| `VERSION` | image tag to run (`vX.Y.Z`); changed by `mintctl update` |
| `COMPOSE_PROJECT_NAME` | prefixes container and volume names; never change it on an existing install (the volumes would be orphaned) |
| `UI_PORT` / `MINT_PORT` | host ports for console and mint API |
| `BIND_ADDR` | host interface for those ports: `127.0.0.1` in TLS and behind-proxy modes, `0.0.0.0` in plain-HTTP mode |
| `COMPOSE_PROFILES` | `tls` enables the bundled Caddy |
| `DOMAIN` / `CONSOLE_DOMAIN` | hostnames Caddy serves and gets certificates for |
| `MINT_PUBLIC_URL` | first-boot default for the wallet-facing URL; afterwards edited from the console's Mint tab |
| `INITIAL_ADMIN_PASSWORD` | first boot only — seeds the admin account (change forced at first sign-in); inert once `users.json` exists |
| `ACME_EMAIL` | optional; `mintctl update` re-applies it to the Caddyfile |
| `MINT_MODE` | first bootstrap only: `bundled` or `external-pending` (processor-only installs); the console owns the connection afterwards |
| `GRPC_BIND_ADDR` / `GRPC_PORT` | where the payment gRPC is published for an external mint (loopback:50051 by default; the link has no auth — firewall it) |

Prefer `mintctl domain` over hand-editing the access keys; for anything else,
apply `.env` edits with `mintctl stop && mintctl start`.

## Backup and restore drill

```sh
mintctl backup /root/mint-$(date +%F).tar.gz     # brief downtime (consistent sqlite snapshot)
```

The archive contains the three data volumes **including the mint's recovery
seed and password hashes** — treat it like the keys to the mint: encrypt it
(e.g. `age`/`gpg`) and store it off the server.

Restore onto the same install:

```sh
mintctl restore /root/mint-2026-07-30.tar.gz     # replaces ALL current state
mintctl status
```

Verify after any restore: console reachable, sign-in works, **Mint → Reveal
recovery phrase** shows the expected 24 words, Overview shows the expected
circulation.

## Migrating to a new server

1. Old server: `mintctl backup`, copy the archive off.
2. New server: run the installer with the **same domain** (DNS can move
   afterwards; certificates re-issue automatically).
3. New server: `mintctl restore <archive>` — this replaces the freshly
   bootstrapped seed/config with the real ones.
4. Point DNS at the new server; verify; decommission the old install
   (`mintctl uninstall --purge` only after the new one is verified).

The seed fingerprint check refuses to start a mint whose database does not
match the configured seed, so a mixed-up restore fails loudly rather than
forging keys.

## Running a second instance on one host

```sh
curl -fsSL .../install.sh | bash -s -- --dir /opt/second-mint \
    --ui-port 19090 --mint-port 18089 --grpc-port 51051 \
    --domain mint2.example.org
```

Each install directory is fully self-contained (own project name, volumes,
ports — including the published gRPC port). TLS mode note: ports 80/443 can
only be bound by one instance — for several TLS instances, run one shared
reverse proxy instead (next section).

## Bringing your own reverse proxy

If the host already runs nginx/Traefik/Caddy, the installer detects the
occupied ports 80/443 and suggests behind-proxy mode; `mintctl domain`
switches an existing install the same way. In that mode the stack binds
loopback only and writes ready-to-paste server blocks for both hostnames to
`<install-dir>/proxy-snippets/` (Caddy and nginx flavors, with the details
that matter baked in):

- targets `127.0.0.1:$MINT_PORT` / `127.0.0.1:$UI_PORT`,
- forwards `X-Forwarded-Proto` — the processor uses it to mark session
  cookies `Secure`,
- streams the console's SSE endpoint (`GET /events`) unbuffered.

## Changing how the mint is reached

`mintctl domain` re-runs the access step on a running install — plain HTTP →
domain with automatic HTTPS, a new domain, or behind-your-own-proxy — with
the same DNS live-check and certificate wait as the installer
(non-interactive: `mintctl domain --domain new.example.org --yes`). It
updates `.env`, re-renders the proxy snippets when applicable, and recreates
the affected containers.

Afterwards update the wallet-facing URL in the console (Mint tab) to match —
`MINT_PUBLIC_URL` in `.env` only sets the first-boot default; the running
config owns it from then on (the command reminds you).

## Connecting an external cdk-mintd

A processor-only install (`--processor-only`, or the wizard's "Processor
only" choice) leaves the mint attachment open; the console's **Mint tab**
then offers the choice:

- **Use the bundled mint** — flips to the compose-internal cdk-mintd; the
  supervisor starts it as soon as the first unit exists. No further setup.
- **Connect an external cdk-mintd** — you provide the mint's HTTP URL, an
  optional management-RPC URL, and the address your mintd should dial this
  processor's payment gRPC on. The console renders a `mint.toml` snippet to
  merge into your mintd's config; after a mintd restart the Overview's
  payment-backend tile turns **Connected**.

Constraints, stated honestly in the UI as well:

- Your mintd must be **built from the same pinned cdk revision** as this
  processor with `patches/cdk-managed-units.patch` applied — the published
  `custom-unit-mint` image is exactly that build. The payment-processor
  protocol check is strict equality; mismatched builds refuse to attach.
- The gRPC and management-RPC links carry **no authentication**: same host
  or private network only, firewalled to the mint's machine
  (`GRPC_BIND_ADDR=0.0.0.0` publishes the processor's gRPC beyond loopback).
- The **supply audit is unavailable** (it reads the bundled mint's sqlite
  directly), and without a management-RPC URL keyset rotation and the
  quote-TTL sync are disabled.
- Switching an install between mints requires **retiring all units first** —
  ecash issued under one mint's keysets cannot follow to another. If an
  external mint is gone for good, retirement offers an explicit
  "retire without the expiry check" escape hatch.

## Updates and rollback

`mintctl update` moves the deployment files, the `mintctl` binary, and the
image **together** to a release tag, then waits for `/healthz` and compares
the reported version. Roll back the same way: `mintctl update --version
vX.Y.Z` with the previous tag. Data volumes are untouched in both
directions; take a backup before major updates anyway.

Rollback caveats across the bash-installer boundary: rolling back to a
release whose mintctl was still a shell script restores that script; the
next `mintctl update` forward bootstraps the binary again. A
console-configured external-mint connection is dropped by releases that
predate it (their processor strips unknown config fields on save) — re-enter
it in the console after rolling forward.

## Health and monitoring

- `GET http://127.0.0.1:$UI_PORT/healthz` (or `https://<console-domain>/healthz`)
  — unauthenticated liveness + running version; wire it into uptime checks.
- `docker ps` shows both containers' healthchecks. The mint container reports
  healthy while in **Standby** (zero units) by design; the supervisor's state
  is readable at `mintctl status` ("mint supervisor: waiting|running|restarting").
- Subsystem detail (mint HTTP, management RPC, payment backend attachment)
  is on the console's Overview tab.
