# Pecan live deployment — architecture

The operator-facing map of what runs at https://giftcard.cashu.exchange
(inr2, 46.224.104.12). Agent/ops detail lives in [AGENTS.md](../AGENTS.md);
status and backlog in [status.md](status.md). Upstream install story
(single pair, installer) is the [README](../README.md).

## The shape

One domain, one edge proxy, three currency pairs. Each pair is one
`cdk-mintd` + one pecan processor (a single gRPC processor per mintd is
all cdk allows); everything else is shared.

```mermaid
flowchart LR
  subgraph browsers [Operator / customer browsers]
    W[Wallet SPA\n/{pair}-console/wallet]
    C[Console SPA\n/{pair}-console — teller + admin]
  end

  subgraph edge [Caddy — TLS, path routing]
    direction TB
    E1[/{pair}/v1/* → that pair's mintd]
    E2[/{pair}-console/* → that pair's pecan\n(prefix stripped)]
    E3[/wallet, /assets → EUR pecan]
    E4[/atom-gateway/* → :8099]
    E5[root /* → static site]
  end

  subgraph pairE [EUR pair]
    M1[mintd :8089]
    P1[pecan :50054 gRPC / :9091 http]
  end
  subgraph pairU [USD pair]
    M2[mintd :8097]
    P2[pecan :50055 / :9093]
  end
  subgraph pairN [NOK pair]
    M3[mintd :8098]
    P3[pecan :50057 / :9097]
  end

  W --> edge
  C --> edge
  edge --> M1 & M2 & M3
  edge --> P1 & P2 & P3

  subgraph money [Signet side]
    CLN[CLN nodes\ncln-hub / vls / nostr]
    BTC[owned bitcoind :38332\nwatch-only per-quote descriptors]
  end
  P1 & P2 & P3 -->|ln quotes| CLN
  P1 & P2 & P3 -->|btc rail watch| BTC

  subgraph ev [EV charging rail]
    DA[ev-charge-{eur,nok}.service\nwatches consoles for ev:* melts]
    GW[atom-gateway :8099\nsession refs = melt quote ids]
    MQ[HiveMQ fleet topics\ncharger/{device}/#]
    F[Charger fleet — atom box\n(t-relay, atomD), T-Display S3 (atomC)]
  end
  P1 & P3 -.->|ev payout melts| DA
  DA --> GW
  GW <--> MQ <--> F
  W -->|public session status/stop\nby ref| GW
```

## Conventions that hold the system together

- **Path convention**: `{currency}/v1/*` mint API, `{currency}-console/*`
  its pecan. Root `/v1` + `/console` are reserved for a future sats pair;
  the fiat wallet itself is served at `/wallet` (currency lives in
  localStorage, never in the URL).
- **One bundle, runtime base**: all pairs serve the SAME web build; the
  console SPA derives its API/SSE/router prefix from the URL
  (`web/src/lib/console-base.ts`). Root-relative `/api/*` calls in
  console code are a bug — they escape to the static site.
- **Per-pair sessions**: console cookies are unit-scoped
  (`branch_session_nok`), so an operator can be signed into several
  pairs in one browser.
- **The one-way invariant**: fiat in at the counter (or over ln/btc
  deposits); melting exits through the teller or configured payout
  rails. ln/btc melts are refused, test-enforced per pair.

## Money rails (per pair)

| Rail | Deposit | Melt |
|---|---|---|
| `branch` (teller) | wallet shows code+QR, teller matches & settles | teller pays out cash |
| `ln` | real bolt11 on signet CLN, FX + 10% markup in pecan | refused |
| `btc` | per-quote bech32, watched on the OWN bitcoind, 0-conf (signet) | refused |
| payout rails (`sim,sepa,swish,…,ev`) | — | `rail:destination` melts route to adapters |

The `ev` rail is the charger story: ONE melt is the deposit, the charger
meters delivery (1 unit = 1 kW·s), the daemon settles at full and the
wallet claims the unspent remainder as a refund — final balance =
before − delivered, exactly. Session refs are the melt quote ids; the
gateway's status/stop endpoints are public-by-capability.

## Machines

- **inr2** (46.224.104.12) — everything above, Docker for the pairs,
  systemd for caddy/daemons/gateway. 3.8 GB RAM: never build Rust here
  (`scripts/deploy.sh` builds on ai-legion-small and ships the image).
- **ai-legion-small** — build host only.
- **Charger fleet** — MQTT over HiveMQ; the atom box's LWT
  (`charger/atom/status`) is the liveness signal for its chargers
  (including atomD — NOT a per-device topic).

## Where things fail safely

Deposits need wallet-locked quotes (NUT-20); settlements cross-check
with the mint first; melt change is one-time knowledge so the wallet
pre-swaps to exact amounts (lost swap responses recover via restore);
the daemon's ledger makes refunds idempotent (one refund per melt,
ever). Reconcile drift pages surface anything that slipped.
