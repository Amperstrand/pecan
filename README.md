# Pecan

**P**rocessor and **E**cash **C**onsole for **A**lternative **N**umeraires.

Pecan is a cash counter for a [Cashu](https://cashu.space) mint. It lets a
mint issue ecash for a unit of your choice — a local currency, a voucher, a
community token — settled in person: the customer's wallet creates a quote,
the teller matches it by the short code on the customer's screen, cash
changes hands, done.

It comes as two pieces working together:

- a **processor** that plugs into a [cdk](https://github.com/cashubtc/cdk)
  mint over the stock payment-processor interface, and
- a web **console** for the people running the counter: a match-first teller
  page, plus an operator view with a live attachment checklist, an end-to-end
  self-test, and account management.

The mint can be one you already run — Pecan then never touches its seed,
database, or keysets; it verifies the attachment and tells you exactly what
to change when something is off. Or you can let the installer run one for you
from the official `cashubtc/mintd` image, configured and connected before the
install finishes.

## Install

One command on a Linux server (amd64 or arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/zeugmaster/pecan/main/install.sh | bash
```

A guided installer checks the host (Docker, ports, public IP) and asks what
this server should run:

- **Processor + a new mint** — pick your currency unit and the mint's
  hostname; the installer generates the mint's seed (shown once — write it
  down), wires the mint to the processor, and finishes with the attachment
  checklist already green and the unit locked in.
- **Processor only** — attach a mint you already operate afterwards, in the
  console's Mint tab.

Then it asks how operators (and wallets) reach this server — a domain with
automatic HTTPS, behind your own reverse proxy, or plain HTTP on a trusted
LAN. It finishes with your `admin` sign-in; the console has you set your own
password before anything else.

Every question has a flag twin for automation — see `mintctl install --help`:

```sh
# processor + a new mint
mintctl install --yes --with-mint --unit ora \
  --console-domain console.example.org --mint-domain mint.example.org
# processor only (attach later in the console, or now via --unit/--mint-url)
mintctl install --yes --console-domain console.example.org
```

## First steps

With a bundled mint there is nothing left to connect — write down the seed,
watch the checklist confirm itself, and add teller accounts in the **Access**
tab. Attaching your own mint instead:

1. **Mint** tab — set your unit and your mint's URL, copy the generated
   config snippet, apply it to your mintd (`cdk-mintd config apply`),
   restart your mintd.
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

Pecan attaches to an unmodified `cdk-mintd`, v0.18.0-rc.0 or later — the
first release containing
[cashubtc/cdk#2295](https://github.com/cashubtc/cdk/pull/2295) (docker image
`cashubtc/mintd:0.18.0-rc.0`, the one the bundled mode runs). The
payment-processor protocol version is checked strictly at connect time and
the console names the required release. Wallet developers: see
[`docs/wallet-integration.md`](docs/wallet-integration.md).

## Good to know

- Deposits are only accepted on quotes locked to the customer's wallet
  (NUT-20), so a quote id is never a bearer secret.
- Before any settlement the processor cross-checks the quote with the mint
  and refuses on any disagreement.
- With a domain, TLS is handled for you (bundled Caddy + Let's Encrypt) for
  the console — and for the mint's hostname too when the mint is bundled.
- `mintctl backup` archives are small but contain password hashes and the
  ticket ledger — and, with a bundled mint, the mint's database and SEED,
  which can issue your ecash. Store them encrypted.

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
