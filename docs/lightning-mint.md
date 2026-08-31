# Three-rail minting: teller + lightning + onchain

giftcard.cashu.exchange mints EUR ecash over three payment rails, all
served by ONE pecan processor over the single gRPC connection cdk-mintd
allows (`[grpc_processor]` is a single top-level section — a second
processor would need a second mint; a second *method* needs none).

```
wallet ─POST /v1/mint/quote/{branch|ln|btc}─▶ cdk-mintd ─gRPC CreatePayment(method)─▶ pecan
                                                                                    │
                                            ┌───────────────────────────────────────┤
                                            ▼                   ▼                   ▼
                                      branch rail           ln rail             btc rail
                                   (teller tickets)    (signet CLN @ inr2)   (per-quote bech32,
                                                        │                     esplora-watched)
                                                        │ eur→sat (rate+10%)
                                                        invoice → wallet
                                                        listinvoices poll → PaymentReceived
```

## Rails

| | `branch` | `ln` | `btc` |
|---|---|---|---|
| Mint in | Teller code (quote-id tail) at the counter | Real bolt11 invoice (signet) | Per-quote bech32 address |
| Melt out | Teller payout (`mark-paid` after cash) | **Refused** — one-way mint | **Refused** — one-way mint |
| Conversion | none (eur = eur) | EUR/BTC public rate + markup, in pecan | same rate+markup; `expected_sat` in the quote extras |
| Settlement | Operator marks paid in the console | invoice poller → `PaymentReceived` | esplora utxo poller → `PaymentReceived` |
| Minimum | mint settings floor | mint settings floor | €50 — dust + chain fees (`MIN_ONCHAIN_ORE`) |

**One-way by construction**: `get_payment_quote`/`make_payment` reject
methods `ln` and `btc` (`Error::UnsupportedPaymentOption`), so NUT-05 never
completes a non-teller melt. The only exit from EUR ecash is cash at the
counter.

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
CDK_BRANCH_PROCESSOR_ONCHAIN=true
CDK_BRANCH_PROCESSOR_ONCHAIN_CONFIRMATIONS=0   # signet: mempool settlement.
CDK_BRANCH_PROCESSOR_ONCHAIN_ESPLORA_URL=https://mempool.space/signet/api
```

The rate source defaults to `https://api.yadio.io/rate/BTC/{unit}`
(unit-parameterized; eur today). The socket itself needs write access for
`invoice` calls; mount the node's lightning dir (the socket re-appears in
it on node restart — mounting the socket FILE would break across
restarts).

The mint needs one restart after enabling the rails — it reads the
processor's `get_settings` (which advertises every enabled method) at boot.
`mint.toml` does not change.

## Onchain detection notes

The lab nodes run CLN in esplora chain mode, which does NOT surface mempool
outputs through `listfunds` — so the btc rail detects payments through a
public esplora directly (`mempool.space/signet/api` by default,
`CDK_BRANCH_PROCESSOR_ONCHAIN_ESPLORA_URL` to override). Addresses still
belong to the node's wallet; only detection is explorer-based. With
`ONCHAIN_CONFIRMATIONS=0` the deposit settles as soon as esplora's mempool
shows the utxo (the current signet deployment — the e2e suite runs in ~1
min instead of waiting 5–23+ min per block); `≥1` waits for that many
blocks — mandatory on any value-carrying network, where doublespend
acceptance means the mint pays out ecash for a transaction that may never
confirm. Underpayments never settle (quote expires); overpayments settle
the quoted amount and tip the mint. The settle predicate
(`received_and_confirmations` / `settles` in `processor/src/onchain.rs`) is
unit-tested for both modes because the fast e2e only exercises 0-conf.

The CLN socket client holds ONE persistent connection (a connect-per-call
pattern aggravated an RPC-read crash on a lab node) and skips the blank
lines CLN frames responses with.

## On-chain deposit addressing: alternatives considered

The btc rail uses the classic **exchange deposit pattern in miniature**: per
quote, `newaddr` on the swap node (node-custodial), a small JSON store
mapping quote → (address, expected_sat), and an esplora watcher. The
address is dual-persisted (the mint's `mint_quote.request` is the address),
so the store is a watcher cache, not the system of record.

**Deterministic derivation from the quote id** (`addr = P2TR(tweak(K_static,
H(quote_id)))`, or xpub-path derivation) would eliminate the address field
from the store — both sides derive the same address, correlation is free.
It is the right shape *if* pecan ever manages its own on-chain keys. Today
it is a bad trade: deposits land in the CLN wallet, and CLN has no
watch-only key import — self-derived addresses would move key custody into
pecan (hot keys, PSBT sweeps), a service that currently holds zero bitcoin
keys. Deterministic ≠ stateless, too: the quote-time `expected_sat` (rate
pin against the free-option problem) must be frozen per quote regardless,
and exchange practice keeps allocation records even with pure derivation —
determinism makes state *recoverable*, not unnecessary.

**Silent Payments (BIP-352)** are the wrong tool here despite being the
closest match to "client derives from a static server pubkey":

- *Correlation*: BIP-352 carries no memo/label — payments to one `sp1`
  address are distinguishable only by amount. Two concurrent quotes with
  the same sat expectation become ambiguous. Per-quote derived addresses
  (what we have) keep exact correlation.
- *Payer compatibility*: payers are arbitrary external wallets; SP
  **sending** support (Sparrow, Cake, BlueWallet, BitBox02, as of mid-2026)
  is still a minority, and our lab's CLN payers have none.
- *Detection*: receiving requires scanning every eligible taproot output
  per block — Bitcoin Core ships nothing; Sparrow-style receiving needs an
  SP-capable Electrum (Frigate) or BlindBit oracle; and server-side
  scanning designs give up **mempool visibility**, which our 0-conf
  settlement depends on.
- *Privacy*: the one thing SP buys (no address reuse) we already have —
  every quote gets a fresh address.

The Lightning analogue of the static-pubkey idea — **BOLT-12 offers**
(static offer string, payer derives the payment, receiver correlates by
offer id) — is the right place to use this pattern if the ln rail adopts
bolt12 (cdk already implements it).

## Multi-currency architecture (issue #4)

One (cdk-mintd + pecan) pair per currency behind a single domain. cdk rc.0
binds one gRPC processor per mintd and one unit per processor, so EUR and
USD are separate stacks; coco 2 is multi-mint natively (one seed safely
serves every mint — output secrets derive per (seed, counter, keysetId)
and keyset IDs are mint-specific).

Path convention — uniform for every currency, root reserved for sats:

| | EUR pair | USD pair | (future) sats |
|---|---|---|---|
| Mint API | `/eur/v1/*` → :8089 | `/usd/v1/*` → :8097 | `/v1/*` (404 until it exists) |
| Pecan console | `/eur-console/*` → :9091 | `/usd-console/*` → :9093 | `/console/*` |

caddy strips the currency prefix before proxying, so each stack sees root
paths and stays prefix-agnostic. The wallet SPA is served by whichever
console you load (vite base `./` keeps assets prefix-relative); the wallet
registry (`web/src/lib/coco/currency.ts`) maps currency → mint URL +
console path + symbol, registers every mint on boot, and drives all
unit-scoped calls (quotes, balances, history-by-mint, onchain-status).

Unit itself stays spec-native throughout — NUT-02 keysets are unit-scoped,
NUT-04/05 quotes carry `unit`, token v4 embeds it. The mint-URL-per-
currency mapping is purely the cdk rc.0 constraint; a cdk upgrade allowing
per-method units would collapse the pairs into one multi-keyset mint with
no wallet-visible change (the switcher already thinks in currencies).

Adding a currency: new mintd (own mnemonic; `config init --work-dir /data
--file /data/mint.toml` on fresh data), new pecan compose (INITIAL_UNIT,
own ports/dirs; the CLN socket and esplora are shared — invoices and
addresses are currency-agnostic sats), two caddy handles, one CURRENCIES
entry. Pick ports carefully: 8090/8094/8095 on inr2 are squatted by an
unrelated service.

Breaking-change note: moving a live pair to a new path orphans wallets
that baked the old mint URL into their proofs (signet test money — the
force-clear escape hatch exists, and re-adding the new URL sees the same
balance via the unchanged keysets).

**One wallet, not per-currency pages** (deliberate): a single origin means
a single localStorage/IndexedDB and therefore a single seed backing every
currency — "separate pages" would be cosmetic separation over shared
state. The in-page switcher keeps one backup covering all balances, gives
instant currency swaps, and the landing flow preserves the last-used
currency (localStorage), so a USD user landing on `/` arrives in the
wallet with USD already active. Cross-currency balance glanceability beats
per-currency navigation; the cost (history/pending-cards filtered to the
active currency) is documented above.

## Melt saga (teller withdraws)

Withdraws are a durable saga across wallet reloads. Four hard constraints
shape the design; each was learned the hard way:

1. **The melt must happen EAGERLY.** `mark-paid` refuses while the ticket
   is `waiting` — the operator may only hand out cash after the wallet has
   locked (burned) its proofs at the mint (make_payment flips the ticket to
   `pending`). Deferring the melt until the teller settles deadlocks the
   counter flow.
2. **The melt must be ASYNC (NUT-05 `prefer_async`).** A synchronous melt
   POST blocks until a human settles — minutes — leaving the operation in
   `executing` limbo the whole time (coco's saga model assumes the bolt11
   shape: setup returns promptly, settlement is observed by polling). cdk's
   make_payment comment says it plainly: "the mint keeps the melt pending
   (and polls check_outgoing_payment) until the operator confirms". With
   `prefer_async: true` the mint returns immediately after setup — inputs
   burned, quote PENDING — which is both the teller's fund-lock and the
   signal to release the code (execute resolves in ~100ms).
3. **Change signatures are one-time knowledge.** The mint burns inputs at
   melt setup and defers change on async melts; quote state checks cannot
   re-fetch them: cdk-mintd 0.18.0-rc.0's custom-method check response type
   has no `change` field at all (verified in custom_handlers.rs; master
   re-serves it from the `blind_signature` table — re-check when upgrading).
   Hence `MeltBranchHandler.needsSwapFor` swaps to EXACT amounts on any
   overshoot: exact melts carry no change, so there is nothing to lose when
   a response dies. A lost SWAP response is recoverable because swap outputs
   are deterministic and re-fetchable from the mint (restore path in coco's
   executing-recovery).
4. **Reloads land anywhere in prepare → swap → melt.** Prepared melt ops
   are NOT auto-driven by coco (upstream leaves them for manual rollback),
   so the wallet's `resumePendingOperations` executes them once after a
   reload; pending/executing ops are driven by the settlement watcher.

**Postmortem (2026-08-30)**: every reload-saga e2e run lost €0.12 of a
€5.12 melt. Mint DB showed 512-in/500-melted with the change never claimed.
Fixed by the exact-amount swap + prepared-op resume + (the real alignment)
async melts. The e2e helper polls the ticket out of `waiting` before
settling, `readBalance` waits out the `… €` placeholder, and the suite
asserts on the wallet's debug ring buffer: no warn entries per test, zero
change on finalized teller melts (IDB), fund-lock entry with state
`pending`. Suite 9/9 repeatedly in ~55s.

**Residual window**: a page death during the finalize-time melt of an
exact amount loses nothing (no change), but a death during the SWAP
itself relies on the restore path, which the suite does not deliberately
exercise — that is sandbox-processor work (issue #1).

## The free-option problem (exchange-rate risk during the deposit window)

When a wallet creates a quote, the NOK→sat rate is locked. The user then
takes time to pay (copy invoice, open wallet, confirm). During this window
the exchange rate may move:

- **BTC appreciates** → the user pays fewer sats than current-market NOK
  equivalent → windfall for the user, loss for the mint
- **BTC depreciates** → the user simply doesn't pay and retries at the new
  rate → no loss, free option

### Current mitigations

| Mitigation | Effect |
|---|---|
| 10% markup | Absorbs rate moves up to ~10% during the window |
| 5-min lightning invoice expiry | Short window limits exposure |
| 30-min mint quote TTL | Hard ceiling on how long a rate is honored |
| Cancel button | User can abandon a stale quote immediately |

### Future options (ordered by correctness × complexity)

1. **Rate-at-settlement for on-chain**: compute NOK based on the rate when
   the payment is detected, not at quote time. Requires variable-amount
   mint quotes (NUT-04 protocol change or a processor-side second quote).
2. **HODL invoices for lightning**: create an invoice that doesn't settle
   until we accept it. Refuse if the rate moved > threshold. Requires CLN
   `holdinvoice` support in our rail.
3. **Dynamic fee**: adjust the markup percentage in real-time based on
   rate volatility. Simple but blunt.

The 10% markup + 5-minute window handles all but extreme volatility
scenarios and is the pragmatic choice for a simulated mint.
