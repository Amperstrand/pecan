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
| real-rail adapter | own id | real transfer via that rail's backend | future — plug in as a new rail id |

- **sim-teller** simulates the *human teller* on plain branch melts
  (pattern-matched destinations, amount cap, abstains above it) — it predates
  explicit rails and claims nothing.
- **payout-sim** (`payout/payout-sim.py`) is the generic sample adapter:
  claims only `payout_rail == "sim"`, amount cap, simulated transfer, notes
  carrying the rail name. Copy it, change the rail id and the transfer step,
  enable the id in `PAYOUT_RAILS` — that is the whole integration.
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
