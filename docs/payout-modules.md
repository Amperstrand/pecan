# Payout modules

The mint is one-way by construction: no trustless Lightning/on-chain melts.
Payouts always route through a teller who takes the custody risk — the only
question is *who or what* the teller is. That is pluggable, and the existing
ticket saga already defines the interface.

## Payout rails (explicit routing)

There are hundreds of real-world payout rails — bank transfer, mobile
payment, wire — and a deployment may operate one or many. The wallet names
the rail in the melt destination text:

```
sim:ALIAS-1            → the "sim" rail's adapter
sepa:DE89 3704 0044 …  → a SEPA adapter (when enabled)
plain text             → no rail; a human teller ticket (unchanged)
```

Processing:

1. **Envelope** — `rail:destination`, rail ids lowercase
   `[a-z][a-z0-9-]{1,23}` so free-text memos containing colons never
   misroute (`processor/src/payout.rs`).
2. **Gate** — the processor refuses enveloped melts naming a rail the
   deployment does not enable (`CDK_BRANCH_PROCESSOR_PAYOUT_RAILS`,
   comma-separated; empty = teller-only, the default). Refusal happens at
   quote time, so no unsettleable ticket can exist.
3. **Stamp** — the ticket carries `payout_rail` + the clean destination
   (visible on the matched ticket JSON); `payout_rail: null` means a
   human-teller ticket.

Adapter contract, in addition to the module loop below:

* **Claim only your rail** — after matching, verify the ticket's
  `payout_rail` is yours; anything else is `wrong-rail`, no action taken.
  Acting on another rail's ticket is exactly the routing bug the envelope
  exists to prevent.
* A real backend (bank API, mobile payment provider) slots into the
  transfer step; everything else in the loop is rail-agnostic.

## Module interface (unchanged)

Every payout module drives the same console API loop:

1. **code** — the wallet displays a 6-char code (the quote tail). The code is
   the bearer credential for the payout: no module can act without it.
2. **match** — `POST /api/quotes/match {code}` → ticket
   `{id, kind, status, amount, unit, payout_rail, description}`.
3. **fund lock** — poll match until `status` leaves `waiting`; the wallet has
   burned its inputs at the mint. `mark-paid` refuses before this — that
   invariant is the mint's protection against paying unbacked withdrawals.
4. **fulfill** — the module's payout action. This is the ONLY step that
   differs between modules.
5. **settle** — `POST /api/tickets/{id}/mark-paid {notes}` (or
   `mark-failed` to void).

## Modules

| Module | Rail | Fulfillment | Status |
|---|---|---|---|
| cash-teller | — (human) | human counts out cash | live |
| sim-teller | — (claim sim) | simulates the human teller for plain branch melts | reference impl |
| payout-sim | `sim` | simulated transfer to the enveloped destination | generic sample adapter |
| bank-sim | `sepa`, `sepa-instant`, `swish`, `mobilepay`, `ideal`, `bizum` | simulated fiat transfers per scheme, receipt reference on settlement | simulated fiat rails |
| real-rail adapter | own id | real transfer via that rail's backend | future — plug in as a new rail id |

- **sim-teller** simulates the *human teller* on plain branch melts
  (pattern-matched destinations, amount cap, abstains above it) — it predates
  explicit rails and claims nothing.
- **payout-sim** (`payout/payout-sim.py`) is the generic sample adapter:
  claims only `payout_rail == "sim"`, amount cap, simulated transfer, notes
  carrying the rail name. Copy it, change the rail id and the transfer step,
  enable the id in `PAYOUT_RAILS` — that is the whole integration.
- **bank-sim** (`payout/bank-sim.py`) is the simulated fiat-rail registry.
  The SEPA pair lifts its semantics from the pleBank bill-payment system
  (creditor IBAN + remittance info, ISO 20022-style receipts); the mobile
  and retail rails (`swish`, `mobilepay`, `ideal`, `bizum`) follow the
  public schemes' own addressing and receipt formats. Every destination is
  validated per scheme before any action — SEPA IBANs are mod-97 checked
  (stricter than pleBank's length-only check, which carried an invalid ES
  fixture), phone rails require E.164 within their country prefixes,
  `ideal` requires an NL IBAN.

## Receipts are the payment proof

Adapters settle with `{notes, receipt}`; the receipt is Lightning's
preimage in miniature — revealed only at settlement, unique, verifiable
against the rail's own records (a bank reference). The processor returns
it as the melt's `payment_proof`, the mint surfaces it as the quote's
`payment_preimage`, and the wallet displays it in the withdraw's
"✓ Paid — …" card exactly where Lightning shows a preimage. Teller
settles without a receipt fall back to the settle notes as the proof.
Notes remain the human audit trail on the ticket; the receipt stays a
short, copyable token.
- **A real adapter** (e.g. a mobile-payment or bank rail) is payout-sim with
  a real transfer call and its own rail id; the deployment adds the id to
  `CDK_BRANCH_PROCESSOR_PAYOUT_RAILS` and the wallet needs no changes — the
  destination text already carries the envelope.

## Policy guards for automated modules

- Amount caps per module (`--max-amount`); abstain, don't void.
- Dedicated teller user per module (least privilege — plain teller role,
  not admin) once user management allows it.
- Notes/audit trail on every settle (`mark-paid {notes}` carries the module
  and rail).
- Automated modules never bypass the fund-lock gate; `mark-paid` enforces
  it server-side.

## Roadmap

1. ~~sim-teller + wallet QR~~ — shipped; proves the loop end to end.
2. ~~explicit payout rails + `payout-sim` sample adapter~~ — shipped
   (envelope, quote-time gate, rail-stamped tickets).
3. First real adapter against a test merchant, plugged in as its own rail
   id beside `sim`.
4. Daemonized adapters (poll for open tickets on their rail instead of
   being invoked with a code) once one runs in production.

## The EV rail (`ev`) — charging sessions as melts (prototype)

`ev:<device-slug>` buys a charge window on a charger: the wallet melts
ecash, the mint holds the burned inputs (fund lock), the charger delivers
the window, and the settle receipt is the session record —
`EV-<device>-<seconds>s-<8hex>` — shown where Lightning shows preimages.
The OCPP analogue is deliberate: Authorize = the quote-time slug gate,
StartTransaction's window = the tariff-derived seconds, StopTransaction =
the gateway's `done`, the receipt = transactionId + meter delta.

Pieces:

- **Processor** (`payout.rs`): `ev` validates device slugs
  (`^[a-z0-9][a-z0-9-]{2,23}$`). It is a REAL rail — deliberately absent
  from `SIMULATED_RAILS`, `receipt_for_rail` and `settle_delay_ms`, so
  autosim can never fake-settle energy.
- **Adapter** (`payout/ev-charge.py`): payout-sim's loop (login → match →
  fund-lock wait) with the energy step in the middle: tariff
  `--secs-per-eur` converts melted cents into a window, the device
  gateway is triggered, `done` is awaited, then `mark-paid` with the
  session receipt. Device refusals exit 2 (human may settle); a window
  that ran but never confirmed exits 6 with the ticket left open — never
  auto-settle on doubt.
- **Device gateway contract** (any backend may implement it):

  ```
  POST /device/{id}/trigger  {"seconds": N}   X-API-Key: …
        -> 200 {"triggered": true, "session": "<id>"}
  GET  /device/{id}/status
        -> 200 {"state": "idle"|"running"|"done", "session": …, "seconds": N}
  ```

- **`payout/ev-device-fake.py`** implements the contract for testing
  (binds `--port 0`, prints the bound port on its startup line). The real
  backend maps the same contract onto the evmap stack: the M5Stack Atom
  firmware already anchors to `{"end": epochSec}` payloads on
  `charger/<device>/start` (MQTT via HiveMQ) or the atom-bridge webhook —
  a thin bridge from this HTTP contract to hermes/MQTT replaces the fake
  with zero pecan changes.
- **Wallet**: no picker tab yet — the raw envelope in the teller field
  (`ev:atom1`) works today; the tab ships with the hardware.

End-to-end test: `scripts/e2e.sh -g "ev rail"` (zero sat — the fake
gateway and a shrunk tariff keep it under a minute). Deployment: the rail
is already in `CDK_BRANCH_PROCESSOR_PAYOUT_RAILS` on both pairs.
