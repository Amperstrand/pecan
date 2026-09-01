# Payout modules

The mint is one-way by construction: no trustless Lightning/on-chain melts.
Payouts always route through a teller who takes the custody risk — the only
question is *who or what* the teller is. That is pluggable, and the existing
ticket saga already defines the interface.

## Module interface (exists today, unchanged)

Every payout module drives the same console API loop:

1. **code** — the wallet displays a 6-char code (the quote tail). The code is
   the bearer credential for the payout: no module can act without it.
2. **match** — `POST /api/quotes/match {code}` → ticket
   `{id, kind, status, amount, unit}`.
3. **fund lock** — poll match until `status` leaves `waiting`; the wallet has
   burned its inputs at the mint. `mark-paid` refuses before this — that
   invariant is the mint's protection against paying unbacked withdrawals.
4. **fulfill** — the module's payout action. This is the ONLY step that
   differs between modules.
5. **settle** — `POST /api/tickets/{id}/mark-paid {notes}` (or
   `mark-failed` to void).

## Modules

| Module | Surface | Fulfillment | Status |
|---|---|---|---|
| cash-teller | console (laptop at the counter) | human counts out cash | live |
| sim-teller | headless (`payout/sim-teller.py`) | simulated transfer to the ticket's phone recipient | reference impl |
| phone-teller | phone browser / PWA, scans the wallet's QR | any module above | QR shipped; app TBD |
| phone-payout | headless service | real transfer to the recipient's phone (mobile payment rail) | future |

- **sim-teller** is the reference automation: match → wait lock → simulated
  payout → mark-paid. `--max-amount` makes it abstain (never act) above a
  cap so a human still settles large withdrawals. Refusal takes no action —
  the ticket stays open for the console.
- **phone-teller**: the wallet now renders the teller code as a QR (same
  page as the big mono text), so a phone camera is the entry point. The app
  is a thin scan → confirm → module-call wrapper; a PWA shell around the
  existing console or a standalone page both work.
- **phone-payout**: the wallet's "Phone or reference" field already flows
  into the quote description (`methodData.description` in
  `createWithdraw`), so the recipient is on the matched ticket. The module
  reads it, initiates a real transfer on a mobile payment rail, and marks
  paid on confirmation. Needs: merchant credentials + a webhook/
  confirmation step; run behind the same fund-lock invariant.

## Policy guards for automated modules

- Amount caps per module (`--max-amount`); abstain, don't void.
- Dedicated teller user per module (least privilege — plain teller role,
  not admin) once user management allows it.
- Notes/audit trail on every settle (`mark-paid {notes}` carries the module
  name).
- Automated modules never bypass the fund-lock gate; `mark-paid` enforces
  it server-side.

## Roadmap

1. sim-teller + wallet QR (this change) — proves the loop end to end.
2. phone-teller page (scan QR → confirm → settle), initially calling
   sim-teller semantics.
3. phone-payout module with real transfers against a test merchant.
4. Optional: per-module config in the processor (`[payout]` sections) once
   more than one real module exists.
