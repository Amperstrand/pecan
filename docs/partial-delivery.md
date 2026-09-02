# Partial delivery: paying for energy (or anything) you didn't fully consume

The problem: a melt pre-pays a fixed amount, but a session can end early
(the charger's stop button, the wallet's Stop, an unplugged car). What
happens to the un-delivered part? This document explains the mechanics
from the ground up, the three designs, and what each costs.

## Cashu sending, from the ground up (ELI5)

**Notes.** Ecash is digital banknotes. Each note (a *proof*) has a face
value from a power-of-two set (1, 2, 4, … cents; 1, 2, 4, … sats) and a
secret. Owning a note = knowing the secret and holding the mint's
signature over it. A "single 1024-sat note" is one big banknote.

**Blanks.** When you want NEW notes from the mint, you prepare *blinded
outputs* — think sealed envelopes. The mint stamps each envelope without
seeing inside. Back home, only you can open them (unblind), revealing
notes only you can spend. The mint never learns your secrets; that is
the whole privacy model (NUT-00/02/12).

**Swap = the change machine.** You hold one 1024 note and need to pay 1?
You swap: hand the mint the 1024, hand it sealed envelopes for
512 + 256 + 256, it stamps them, you open them at home. **This — not the
melt — is how "change" normally happens in Cashu.** Our wallet already
does an exact-amount pre-swap before every melt (`needsSwapFor`) so the
melt itself burns exactly what the quote asks.

**Melt.** You hand notes to the mint to be DESTROYED, in exchange for
something outside the ecash world (paying a Lightning invoice; in our
case, firing a charger). Nothing flows "to the charger" — the charger
cannot hold notes; the notes are burned and the mint owes the outside
world the service.

**Melt change (NUT-08-style).** A separate mechanism: if your inputs are
worth MORE than the melt (Lightning fee reserve is the classic case),
you attach blanks in the melt request. The mint, when it settles,
returns signatures for the un-spent part. Two subtleties everyone gets
wrong (see the Amethyst postmortem below): the mint **imprints its own
denominations** onto your blanks (declared amounts are ignored — send
`ceil(log2(overpay)) + 1` blanks), and the wallet must match signatures
to blanks **by index**, taking amounts from the signature.

**So: one 1024 note and a streaming session?** The wallet swaps the big
note into small ones (once), then melts one €1 note per second. No melt
change is ever needed — each melt is exact, and "change" from stopping
early is simply the small notes that were never melted.

## Why async change seemed impossible (and what is actually true)

Lightning melts deliver change inside the melt HTTP response because
payment + fee knowledge + signing all happen in one request. Our
branch/ev settles minutes later (daemon → device → mark-paid), so the
original response is long gone when the delivered amount becomes known.

That made us document "change is one-time knowledge" — true for the
cdk-mintd 0.18.0-rc.0 build we run (state checks cannot re-fetch it;
that postmortem shaped the exact-amount pre-swap), **but not true of the
protocol or the wider ecosystem**:

- NUT-05's async flow (`prefer_async` or method-required async) returns
  `PENDING` immediately and the wallet polls the quote state — the PAID
  quote response carries the change (method NUTs define the fields).
- cashu-ts documents the full pattern:
  `prepareMelt(..., {preferAsync: true})` → persist output data → poll
  until paid → `wallet.createMeltChangeProofs(restored, paidQuote.change)`
  (docs-src/usage/melt_token.md § "Async melt with later change
  recovery").
- cdk mintd returns change on paid melt quote checks — its bug history
  proves the path exists: cashubtc/cdk#1933 (signatures returned in
  non-deterministic order from the blind_signature table) fixed by #1961
  ("preserve change promises order in paid melt quotes").
- nutshell persists change promises for delayed/asynchronous melt
  settlements (cashubtc/nutshell#991 — ORDER BY order_index migration).
- The wallet-side trap is real and documented: Amethyst issue #3847 —
  matching change by amount instead of index breaks DLEQ when the mint's
  decomposition differs from the wallet's declared split; users saw
  "funds lost" until NUT-09 restore. Match by index, amounts from the
  signature.

**Corrected verdict:** "return a blank output later" is not a fantasy —
it is the ecosystem's standard async-melt pattern. It is unwired in OUR
stack (our cdk-mintd build / the branch custom method / coco's wallet
layer), which is why the designs below exist.

## Design A — streaming melts (SHIPPED)

The wallet melts one €1 chunk (one tariffed second) at a time and only
melts the next after the current one settles. Stop = don't melt the
next chunk.

- Change: automatic — the un-melted budget never left the wallet.
- Exposure: at most the in-flight chunk (sub-second rounding at 1 s/€).
- Latency: one melt saga (~2-4 s) between seconds — the relay pulses.
- Failure: daemon dies mid-session → only the current chunk is at risk.
- Complexity: wallet loop only. Live since 2026-09-02, e2e-covered
  (including the physical G39 stop).

## Design B — refund-as-mint-quote

Melt the full budget up front. On early end, the daemon settles the
ticket with a delivered/receipt split and issues the remainder as a NEW
branch mint quote NUT-20-locked to the wallet's pubkey — the refund
lands as a deposit card and auto-claims through the existing machinery.

- Change: literal money flowing back (fresh mint, not melt change).
- Exposure: the FULL budget is at risk during the session (the refund
  only happens if the daemon settles it before quote expiry).
- Latency: continuous charging window; refund lands after the session.
- Failure: daemon dies → whole budget burns unless an operator refunds.
- Complexity: processor refund endpoint + wallet claim flow.
  Deliberately the same cryptographic act as melt change (the mint
  blind-signs outputs worth the refund) done through the deposit flow,
  whose delivery channel already works.

## Design C — true async melt change (the "blank option", rehabilitated)

Melt the full budget with blanks attached; the processor settles with
`total_spent = delivered`; the mint signs the un-spent blanks at
finalize; the wallet polls the quote and unblinds the change when PAID.

- Change: real NUT-05/NUT-08 change, exact to the delivered amount.
- Exposure: full budget at risk until the wallet polls the paid quote —
  but recovery is deterministic (mint persists the promises), so the
  risk is latency, not loss (on a mint with the persistence fixes).
- What it takes on OUR stack:
  1. cdk-mintd with ordered paid-quote change (#1961) — verify or bump
     our 0.18.0-rc.0; confirm the branch/custom method stores outputs
     and returns them on the paid check (the LN path demonstrably does).
  2. Processor: `MakePaymentResponse.total_spent = delivered cents` —
     small; the daemon already knows.
  3. coco wallet: attach blanks to branch melts; on PAID, unblind by
     index with mint-assigned amounts (cashu-ts's `createMeltChangeProofs`
     is the reference implementation; the Amethyst bug is the checklist).
  4. e2e: partial-delivery test asserting change proofs land.
- Estimate: 2-4 focused days, dominated by (1).

## Comparison

|                        | A. streaming (shipped) | B. refund quote      | C. async melt change |
|------------------------|------------------------|----------------------|----------------------|
| Change mechanism       | never overpay          | fresh mint quote     | NUT-05 change on paid quote |
| Exactness              | chunk granularity      | exact                | exact                |
| Budget at risk mid-run | ≤ one chunk            | full budget          | full budget (deterministically recoverable) |
| Charging continuity    | pulses between seconds | continuous           | continuous           |
| Mint changes needed    | none                   | none (endpoint on pecan) | cdk-mintd verify/bump + custom-method wiring |
| Wallet changes         | shipped                | claim flow           | blanks + index-unblind |
| Privacy                | many small melts       | melt + mint quote    | one melt             |
| Failure story          | tiny                   | operator-dependent   | poll-dependent       |

Guidance: keep A as the demo default (it is live and honest). Choose C
when exact billing matters and the mint supports it — it is the
ecosystem-blessed answer to this exact question. B remains the fallback
for mints without async-change support.
