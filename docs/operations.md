# Operations Guide

Procedures beyond the README's quick reference. Everything here assumes an
installation created by `install.sh` (deployment files + `.env` + `mintctl`
in one directory, default `/opt/custom-unit-mint`).

## The .env file

`mintctl` and Docker Compose read all deployment configuration from
`<install-dir>/.env`. Every key is documented in `.env.example` next to it.
The important ones:

| Key | Meaning |
|---|---|
| `VERSION` | image tag to run (`vX.Y.Z`); changed by `mintctl update` |
| `COMPOSE_PROJECT_NAME` | prefixes container and volume names; never change it on an existing install (the volumes would be orphaned) |
| `UI_PORT` / `MINT_PORT` | host ports for console and mint API |
| `BIND_ADDR` | host interface for those ports: `127.0.0.1` in TLS mode (Caddy is the public surface), `0.0.0.0` in HTTP mode |
| `COMPOSE_PROFILES` | `tls` enables the bundled Caddy |
| `DOMAIN` / `CONSOLE_DOMAIN` | hostnames Caddy serves and gets certificates for |
| `MINT_PUBLIC_URL` | first-boot default for the wallet-facing URL; afterwards edited from the console's Mint tab |
| `INITIAL_ADMIN_PASSWORD` | first boot only — seeds the admin account; inert once `users.json` exists |
| `ACME_EMAIL` | optional; `mintctl update` re-applies it to the Caddyfile |

After editing `.env`, apply with `mintctl stop && mintctl start`.

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
    --ui-port 19090 --mint-port 18089 --domain mint2.example.org
```

Each install directory is fully self-contained (own project name, volumes,
ports). TLS mode note: ports 80/443 can only be bound by one instance — for
several TLS instances, run one shared reverse proxy instead (next section).

## Bringing your own reverse proxy

If the host already runs nginx/Traefik/Caddy, skip the bundled Caddy:

1. In `.env`: leave `COMPOSE_PROFILES` empty, set `BIND_ADDR=127.0.0.1`.
2. Proxy `https://<domain>` → `127.0.0.1:$MINT_PORT` and
   `https://<console-domain>` → `127.0.0.1:$UI_PORT`.
3. Forward `X-Forwarded-Proto` (standard in every proxy) — the processor
   uses it to mark session cookies `Secure`.
4. The console live-updates over SSE (`GET /events`): disable response
   buffering for that route (nginx: `proxy_buffering off;`).

## Switching HTTP mode → TLS mode later

```sh
cd /opt/custom-unit-mint
# .env: set DOMAIN, CONSOLE_DOMAIN, COMPOSE_PROFILES=tls, BIND_ADDR=127.0.0.1,
#       MINT_PUBLIC_URL=https://<domain>
mintctl stop && mintctl start
```

Then update the wallet-facing URL in the console (Mint tab) to the new
`https://` form — `MINT_PUBLIC_URL` in `.env` only sets the first-boot
default.

## Updates and rollback

`mintctl update` moves the deployment files and the image **together** to a
release tag, then waits for `/healthz` and compares the reported version.
Roll back the same way: `mintctl update --version vX.Y.Z` with the previous
tag. Data volumes are untouched in both directions; take a backup before
major updates anyway.

## Health and monitoring

- `GET http://127.0.0.1:$UI_PORT/healthz` (or `https://<console-domain>/healthz`)
  — unauthenticated liveness + running version; wire it into uptime checks.
- `docker ps` shows both containers' healthchecks. The mint container reports
  healthy while in **Standby** (zero units) by design; the supervisor's state
  is readable at `mintctl status` ("mint supervisor: waiting|running|restarting").
- Subsystem detail (mint HTTP, management RPC, payment backend attachment)
  is on the console's Overview tab.
