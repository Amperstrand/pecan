# Pecan

**P**rocessor and **E**cash **C**onsole for **A**lternative **N**umeraires.

Pecan is a cash counter for a [Cashu](https://cashu.space) mint you operate.
It lets your mint issue ecash for a unit of your choice — a local currency, a
voucher, a community token — settled in person: the customer's wallet creates
a quote, the teller matches it by the short code on the customer's screen,
cash changes hands, done.

It comes as two pieces working together:

- a **processor** that plugs into an existing [cdk](https://github.com/cashubtc/cdk)
  mint over the stock payment-processor interface, and
- a web **console** for the people running the counter: a match-first teller
  page, plus an operator view with a live attachment checklist, an end-to-end
  self-test, and account management.

Your mint stays yours. Pecan never touches its seed, database, or keysets —
it verifies the attachment and tells you exactly what to change when
something is off.

## Install

One command on a Linux server (amd64 or arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/zeugmaster/pecan/main/install.sh | bash
```

A guided installer checks the host (Docker, ports, public IP) and asks two
things: where your mint runs, and how operators reach the console — a domain
with automatic HTTPS, behind your own reverse proxy, or plain HTTP on a
trusted LAN. It finishes with your `admin` sign-in; the console has you set
your own password before anything else.

Every question has a flag twin for automation — see `mintctl install --help`.

## First steps

1. **Mint** tab — set your unit and your mint's URL, copy the generated
   config snippet into your mintd, restart your mintd.
2. Watch the attachment checklist settle green; the self-test confirms the
   link end to end.
3. **Access** tab — add teller accounts.

## Day to day

The installer leaves a `mintctl` command on the server:

```text
mintctl status | logs | update | domain | backup | restore | start | stop | uninstall
```

Deeper procedures — attaching your mint, backups and restore drills,
migrating servers, running behind your own proxy — live in
[`docs/operations.md`](docs/operations.md).

## Compatibility

Pecan attaches to an unmodified `cdk-mintd` built from
[cashubtc/cdk#2295](https://github.com/cashubtc/cdk/pull/2295); the protocol
version is checked at connect time and the console shows the exact revision.
Until that PR ships in a cdk release, `docker/mintd/Dockerfile` builds a
compatible mintd. Wallet developers: see
[`docs/wallet-integration.md`](docs/wallet-integration.md).

## Good to know

- Deposits are only accepted on quotes locked to the customer's wallet
  (NUT-20), so a quote id is never a bearer secret.
- Before any settlement the processor cross-checks the quote with the mint
  and refuses on any disagreement.
- With a domain, TLS is handled for you (bundled Caddy + Let's Encrypt) and
  the console is the only public surface.
- `mintctl backup` archives are small but contain password hashes and the
  ticket ledger — store them encrypted.

## Development

From a checkout:

```sh
docker compose up --build
```

Console on http://localhost:9090 (demo `admin`/`admin`). The frontend lives
in `web/`, the processor and API server in `processor/`, the installer CLI in
`mintctl/`. CI builds and tests every PR and publishes multi-arch images to
`ghcr.io/zeugmaster/pecan`. Why stock cdk needed one upstream change — and
the agenda for future ones — is in `docs/upstream-research/`.
