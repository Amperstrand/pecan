# Two-rail minting: teller + lightning

giftcard.nok mints NOK ecash over two payment rails, both served by ONE
pecan processor over the single gRPC connection cdk-mintd allows
(`[grpc_processor]` is a single top-level section — a second processor
would need a second mint; a second *method* needs none).

```
wallet ──POST /v1/mint/quote/{branch|ln}──▶ cdk-mintd ──gRPC CreatePayment(method)──▶ pecan
                                                                                        │
                                              ┌─────────────────────────────────────────┤
                                              ▼                                         ▼
                                        branch rail                                 ln rail
                                     (teller tickets)                    (signet CLN @ inr2, socket)
                                                                                      │
                                                          nok → sat (public rate + 10%)│
                                                          invoice → wallet ────────────┘
                                                          listinvoices poll → PaymentReceived
```

## Rails

| | `branch` | `ln` |
|---|---|---|
| Mint in | Teller code (quote-id tail) at the counter | Real bolt11 invoice (signet) |
| Melt out | Teller payout (`mark-paid` after cash) | **Refused** — one-way mint |
| Conversion | none (nok = nok) | NOK/BTC public rate + markup, in pecan |
| Settlement | Operator marks paid in the console | CLN invoice paid → poller emits `PaymentReceived` |

**One-way by construction**: `get_payment_quote`/`make_payment` reject
method `ln` (`Error::UnsupportedPaymentOption`), so NUT-05 never completes
an ln melt. The only exit from NOK ecash is cash at the counter.

## Why the conversion lives in pecan

cdk 0.18 has no price service (the `cdk` crate contains none), and
cdk-mintd's native CLN backend speaks sat-denominated bolt11 only. The
gRPC payment-processor layer is the designated home for exactly this:
method-specific settlement logic. pecan converts NOK→sat at quote time
(`processor/src/ln.rs::nok_ore_to_sat`):

- rate from a public source (default `api.yadio.io/rate/BTC/NOK`),
  cached 5 min, **fallback to last known** when the source is down
  (a stale rate beats a rail that cannot quote; the markup absorbs drift)
- markup (default 10%) applied before conversion, rounded UP in the
  mint's favor (f64-noise-safe ceiling)
- invoice label = the mint's quote id; the rail keys state by it

## Security model

- **CLN access is the unix socket** (`lightning-rpc`), bind-mounted into
  the pecan container. Socket RPC has no auth — whoever holds the socket
  owns the node. Runes would only apply to a gRPC interface, which cdk's
  socket client does not use. Containment: nothing else exposes the
  socket; the pecan container is loopback-bound with caddy in front.
- **NUT-20 locks required** on ln quotes, same policy as branch: without
  the lock, anyone who learns a quote id could front-run the mint after
  the invoice is paid.
- The mint's node is a **signet CLN** on the same host
  (`cln-clboss-signet`, socket at
  `/opt/inr2-swapnet/cln-clboss-data/signet/lightning-rpc`). No real
  money moves anywhere in this deployment.

## Known limitations

- **In-memory invoice records**: a pecan restart orphans open unpaid
  invoices (they expire; the wallet retries with a fresh quote). A paid
  invoice whose record died settles nowhere — acceptable for a simulated
  mint; persistence would mirror tickets.json if this ever carries value.
- The `get_settings` custom map advertises `ln` for melting too (cdk
  derives both NUT-04 and NUT-05 settings from the same map); wallets
  that attempt an ln melt get an error at quote time. Our wallet only
  offers teller withdrawals.
- Rate-source trust: a manipulated rate source over/under-prices sats
  per NOK; the 10% markup is the buffer. Fail-closed only before the
  first successful fetch.

## Configuration (deploy/docker-compose.prod.yml)

```
CDK_BRANCH_PROCESSOR_LN=true
CDK_BRANCH_PROCESSOR_CLN_SOCKET=/run/pecan-cln/signet/lightning-rpc
CDK_BRANCH_PROCESSOR_LN_MARKUP_PERCENT=10
CDK_BRANCH_PROCESSOR_LN_RATE_URL=https://api.yadio.io/rate/BTC/NOK
volumes:
  - /opt/inr2-swapnet/cln-clboss-data:/run/pecan-cln:ro?  # see note
```

The socket itself needs write access for `invoice` calls; mount the
node's lightning dir (the socket re-appears in it on node restart —
mounting the socket FILE would break across restarts).

The mint needs one restart after enabling the rail — it reads the
processor's `get_settings` (which now advertises both methods) at boot.
`mint.toml` does not change.
