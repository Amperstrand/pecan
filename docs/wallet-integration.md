# Wallet Integration

How wallets interact with a mint attached to Pecan's branch processor, and
what happens at the counter.

## Settlement flow

Deposit (mint):

1. The customer's wallet creates a NUT-20-locked mint quote at the mint
   (`POST /v1/mint/quote/branch`) and shows its quote id. The mint forwards
   the quote id and pubkey to the processor (PR #2295), which registers a
   ticket.
2. The teller matches the quote — scans the id or types its last 6+
   characters — and checks the amount with the customer. Before showing the
   confirm card, the processor cross-checks the quote against the mint's own
   record and refuses on any disagreement.
3. Customer hands over cash; teller presses **Cash received**. The mint marks
   the quote paid and the wallet mints the ecash (only that wallet can — the
   quote is locked to its key, so the quote id is not a bearer secret).

Withdrawal (melt):

1. The customer's wallet creates a melt quote (`POST /v1/melt/quote/branch`)
   declaring the payout `amount`, then pays its ecash into it — the mint
   locks the proofs before any cash moves.
2. The teller matches the melt quote id the same way. The card blocks payout
   until the wallet's funds are locked ("Awaiting wallet" → "Ready to pay
   out").
3. Teller hands over cash and presses **Cash paid out**; the mint finalizes
   the melt. **Void** at any earlier point releases the customer's proofs.

Abandoned quotes expire at the mint (the mint's quote TTLs govern this — the
console's config snippet seeds counter-friendly values on fresh databases,
and the self-test warns when they are too short) and the processor deletes
expired, never-funded tickets automatically.

## Wallet contract

Wallets talking to a branch mint must:

- create **locked** mint quotes: `POST /v1/mint/quote/branch` with `amount`,
  `unit`, and a NUT-20 `pubkey` (unlocked quotes are rejected), then sign the
  mint request with that key;
- display the quote id for the teller: as text with the **last 6 characters
  emphasized**, and as a QR encoding the **bare quote id** (no URL scheme —
  handheld scanners type the payload verbatim into the match field);
- poll `GET /v1/mint/quote/branch/{quote_id}` (or subscribe via NUT-17) and
  mint once `amount_paid` covers the quote;
- for withdrawals: `POST /v1/melt/quote/branch` with `unit`, a free-form
  `request` memo, and the payout declared in the `amount` field, then submit
  the melt with proofs. The melt may exceed the synchronous window — handle
  the pending-timeout response and keep polling the melt quote;
- expect rejections to surface as generic mint errors (cdk flattens payment
  processor errors); the specific reason — missing pubkey, wrong unit,
  amount limits, too many open quotes — is logged by the mint and processor.
