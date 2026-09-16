You are working on the existing `Amperstrand/pecan` project and its associated Cashu/CDK mint infrastructure.

Implement a **working spike**, including deployment to the existing `giftcare.cashu.exchange` infrastructure, demonstrating physical egg futures using the supplied `NUT-32.md` proposal.

This is not a design-only task.

You have permission to modify:

- Pecan;
- cdk-mintd;
- CDK libraries used by the deployment;
- mint configuration;
- wallet/demo code;
- deployment configuration;
- database schemas;
- APIs between Pecan and mintd;
- the existing test/demo infrastructure.

You have **full control of the experimental mint**.

Do not preserve an artificial boundary simply because current Pecan does not touch some mint internals. If implementing NUT-32 correctly requires changes in CDK/mintd, make those changes.

Do, however, preserve sensible key-security boundaries: do not copy the mint seed/private key into Pecan merely for convenience. Operations requiring the mint identity key should happen inside mintd/CDK.

This is a spike, so prioritize proving the complete concept cleanly over maintaining backward compatibility with every historical Pecan design assumption.

Existing functionality should still work where reasonably possible, especially the existing charger demo.

---

# Primary question

Can we make this user story work end-to-end?

## Sarah's story

Sarah wants eggs next Friday.

A farm has chickens that produce exactly:

```text
10 eggs per day
```

Every production date is represented as a scarce Cashu future series.

For next Friday:

```text
Farm-YYYYMMDD Eggs
capacity = 10
```

Sarah wants:

```text
5 eggs
```

The farm charges a configurable demo price denominated in **Bitcoin Signet sats**.

For the spike, use:

```text
1 egg = 1000 Signet sats
```

unless existing infrastructure makes another fixed amount materially easier.

Therefore Sarah's purchase is:

```text
5 Friday eggs
×
1000 Signet sats

=

5000 Signet sats
```

Sarah pays 5000 actual Signet sats using the Signet infrastructure available to the deployment.

After confirmed payment she receives:

```text
5 units
```

of the Cashu NUT-32 future representing next Friday's egg production.

She can subsequently transfer or resell those claims without the farm maintaining an ownership registry.

For example:

```text
Sarah receives: 5 Friday eggs

Sarah sends Bob: 2 Friday eggs

Sarah retains: 3 Friday eggs
Bob owns:      2 Friday eggs
```

At maturity the bearer can redeem the future for the physical eggs.

This user story is the primary acceptance criterion for the spike.

---

# First inspect reality

Before coding, inspect:

- Pecan's current `main`;
- all EV/charger code;
- current deployment code;
- current CDK/payment processor integration;
- existing wallet/demo implementation;
- current infrastructure configuration;
- DNS/domain assumptions;
- deployed mint configuration;
- current Signet support, if any;
- the supplied `NUT-32.md`.

Do not assume this prompt's file names match the latest repo.

The user referred to:

```text
giftcare.cashu.exchange
```

Inspect the actual deployment configuration.

If the repository/infrastructure actually uses a slightly different hostname, such as `giftcard.cashu.exchange`, use the real existing infrastructure rather than creating a parallel deployment merely to satisfy the spelling in this prompt.

Document any hostname discrepancy in the final report.

---

# This must end in a deployed spike

Do not stop after local tests.

The deliverable includes deployment into the existing experimental Pecan infrastructure.

The final result should have a reachable demo where the Sarah flow can actually be exercised.

Deployment should include, as necessary:

```text
Pecan
modified cdk-mintd
NUT-32-aware mint
Signet payment backend
demo wallet/UI
farm production oracle
future terms store
```

Use existing deployment practices in the repository.

Do not deploy anything involving mainnet Bitcoin.

**Signet only.**

The system has no intended real economic value.

---

# Conceptual model

Each production day is one future series.

For example:

```text
Friday eggs != Saturday eggs
```

but within Friday's production:

```text
Friday egg == Friday egg
```

Do NOT issue individually numbered egg NFTs.

Do NOT model:

```text
egg #1
egg #2
egg #3
...
```

Instead:

```text
series = Farm-20260918 Eggs

capacity = 10

Cashu amount = number of egg claims
```

Thus:

```text
amount = 1
```

means a claim on one egg.

```text
amount = 5
```

means a claim on five eggs.

This is **semi-fungible**:

- the dated production series is unique;
- units inside the series are fungible.

It is NFT-like only in the loose sense that the dated series represents a unique scarce real-world allocation.

Do not build an NFT framework.

---

# NUT-32 is the protocol basis

Read and follow the supplied `NUT-32.md`.

The future should remain ordinary Cashu ecash structurally.

The important shape is:

```text
unit
amount
normal Cashu proofs
NUT-10 secret containing future terms reference
```

Use normal Cashu amount handling for quantity.

The proof secret must carry the immutable future terms commitment as specified by NUT-32.

Do not put authoritative contract terms in mutable token metadata.

The dated future must remain transferable as bearer Cashu.

---

# Daily series naming

Human-facing name:

```text
Farm — 18 Sep 2026 eggs
```

Internal logical identifier:

```text
Farm-20260918
```

NUT-32 unit should obey the draft's grammar.

Use a documented convention such as:

```text
future:farm-egg:20260918T160000Z
```

where maturity is the time the day's eggs become available for collection.

For the spike:

```text
maturity = 16:00 UTC
```

unless the deployment's farm timezone model makes another clearly documented convention better.

Store actual maturity as UTC.

---

# Terms

Each series gets immutable signed terms.

Conceptually:

```json
{
  "mint": "https://<mint>",
  "signature": "<mint signature>",
  "terms": {
    "unit": "future:farm-egg:20260918T160000Z",

    "contract_size": "1",

    "commodity": "egg",
    "producer": "farm",
    "production_date": "2026-09-18",

    "production_capacity": "10",

    "oracle": "https://<pecan>/api/farm/2026-09-18",

    "settlement_method": "physical",
    "settlement_unit": "egg",

    "purchase_currency": "signet-sat",
    "reference_price_sats": "1000",

    "shortfall_policy": "issuer-default"
  }
}
```

Use canonical encoding exactly as required by the NUT-32 draft.

The terms must be signed using the mint identity key specified by the draft.

Pecan should request that signature from mintd/CDK.

Do NOT export the mint's private key into Pecan.

---

# Content-addressed terms

Implement immutable content-addressed storage.

If using Blossom is easy and already available, use it.

Otherwise implement a minimal Pecan endpoint/store such as:

```text
/terms/<sha256>
```

where:

```text
SHA256(exact blob bytes)
```

determines the path.

Once written, a digest must never resolve to different bytes.

A future proof should contain the NUT-32 tag:

```json
["future", "1", "https://.../terms/<sha256>"]
```

Mutation must be detectable.

---

# NUT-32 support belongs in mintd/CDK where necessary

Pecan alone cannot correctly implement this if mintd treats the result as an arbitrary custom token.

Implement the minimum real NUT-32 support needed inside CDK/mintd.

At minimum:

## Capability

Advertise:

```json
"32": {
  "supported": true,
  "versions": [1]
}
```

through mint info.

## Validation

Validate:

- canonical future unit;
- exactly one `future` tag;
- valid terms URI;
- terms blob hash;
- terms signature;
- issuing mint identity;
- `terms.unit == proof unit`;
- known/authorized future series;
- maturity;
- unknown terms fields are preserved.

## Swap

A NUT-32-aware swap must preserve:

```text
future unit
terms URI
```

It may split or combine normal amounts.

It must NOT turn:

```text
future:farm-egg:Friday
```

into:

```text
future:farm-egg:Saturday
```

or into ordinary `sat`.

---

# Hard production-capacity invariant

The farm produces:

```text
10 eggs/day
```

Therefore:

```text
total authorized issuance for a production day <= 10
```

This MUST be enforced transactionally.

For example:

```text
Friday:

capacity = 10
issued = 6

request issue 5

6 + 5 > 10

REJECT
```

Never allow an 11th Friday egg claim.

Retries must be idempotent.

Do not use the wallet balance as the capacity ledger.

Maintain explicit production accounting.

---

# Signet purchase architecture

Sarah's 5000 Signet sat payment is **consideration for issuance of another Cashu unit**.

This is not an ordinary NUT-03 same-unit swap.

Model it explicitly as a sale saga.

Conceptually:

```text
Sarah
  │
  │ wants 5 Friday eggs
  ▼
Pecan
  │
  │ sale quote
  ▼
5000 Signet sats
  │
  │ actual Signet payment
  ▼
payment confirmed
  │
  ▼
production capacity reserved
  │
  ▼
NUT-32 mint authorization
  │
  ▼
Sarah mints
5 × Farm-Friday egg futures
```

Do not pretend:

```text
5000 sat
```

and:

```text
5 future:farm-egg:...
```

are the same Cashu unit.

They are not.

Build a durable cross-unit/resource saga.

---

# Sarah purchase API

Implement approximately:

```text
POST /api/farm/futures/quote
```

request:

```json
{
  "production_date": "next-friday",
  "quantity": 5
}
```

response:

```json
{
  "purchase_id": "...",

  "series": "Farm-20260918",
  "unit": "future:farm-egg:20260918T160000Z",

  "quantity": 5,

  "price_per_egg_sats": 1000,
  "total_sats": 5000,

  "payment": {
    "...": "Signet payment details"
  },

  "expires_at": "..."
}
```

Use the actual payment mechanism best supported by the existing infrastructure.

Preference order:

1. existing Signet Lightning/BOLT11 support, if genuinely available;
2. existing Signet on-chain backend;
3. a small clean Signet backend added for this spike.

Do not fake Signet payment by clicking an admin button.

There must be a cryptographically/verifiably confirmed Signet payment.

---

# Reserving capacity while Sarah pays

When Sarah requests five eggs:

```text
available capacity = 10
requested = 5
```

create a short-lived purchase reservation:

```text
capacity:
10

reserved_for_open_purchases:
5

remaining:
5
```

Otherwise Alice and Bob could simultaneously each pay for 10 and overissue production.

State should resemble:

```text
OPEN
PAID
ISSUANCE_AUTHORIZED
MINTED
EXPIRED
FAILED
```

Use better names if they fit the existing code.

An unpaid quote expiration releases its reserved capacity.

---

# Bind issuance to Sarah

Once Sarah's Signet payment is confirmed, do not simply expose an unauthenticated mint authorization URL.

Use an appropriate wallet-locking mechanism such as NUT-20 if compatible with the new future issuance path.

Sarah should provide a wallet public key when creating the purchase.

The future mint authorization should be claimable only by that wallet.

Then:

```text
payment confirmed
+
Sarah wallet authentication

→

mint 5 future units
```

The payment quote itself should not become a bearer credential anyone can steal.

---

# Sarah's UI story

Build the demo around Sarah rather than around protocol internals.

The user should be able to open the deployed demo and see something like:

```text
FARM

Next Friday
10 eggs produced
10 available
1000 Signet sats / egg
```

Sarah selects:

```text
Quantity: 5
```

UI shows:

```text
5 eggs
5000 Signet sats

Production:
Friday 18 Sep

Available for pickup:
Friday 16:00 UTC
```

Action:

```text
Buy for 5000 Signet sats
```

Then show the real Signet payment request.

After payment confirmation:

```text
Payment received
Minting 5 Friday egg claims...
```

Then:

```text
YOU OWN

Farm — Friday eggs

5 eggs
```

Expose enough technical detail behind an expandable/debug area to show:

```text
NUT-32 unit
terms hash
maturity
mint
proof state
```

but keep the primary UI understandable to Sarah.

---

# Sarah resale story

The second user story is:

> Sarah's plans change. She sells two of her five Friday egg claims to Bob.

For the spike, an order book is NOT required.

Normal Cashu bearer transfer is enough.

Demonstrate:

```text
Sarah before:
5 Friday eggs

Sarah sends:
2 Friday eggs

Sarah after:
3 Friday eggs

Bob:
2 Friday eggs
```

This should use normal Cashu splitting/transfer.

The farm/Pecan backend should NOT need to record:

```text
Bob now owns egg futures
```

It should know only aggregate series accounting.

Bearer ownership remains in Cashu.

---

# Show the privacy property

Pecan should know:

```text
Friday series
capacity = 10
issued = 5
redeemed = 0
```

It should not need a permanent ownership table saying:

```text
Sarah = 3
Bob = 2
```

Cashu proofs represent that ownership.

Add an explicit test or architecture assertion for this.

---

# Redemption

At or after maturity:

```text
Bob presents 2 Friday egg futures
```

The teller/farm interface verifies them.

UI:

```text
FARM REDEMPTION

Farm — Friday eggs
Quantity: 2

[ Eggs handed over ]
```

Before confirmation the proofs must not be irreversibly consumed if the operator aborts.

Once the operator actually hands over the eggs:

```text
2 physical eggs
        ↓
redemption finalized
        ↓
2 future claims cannot be redeemed again
```

Double redemption must fail.

---

# Physical settlement versus current NUT-32 wording

Read the draft carefully here.

The current proposal describes settlement as spending the future proof and issuing the stated settlement-unit amount.

Physical egg delivery may not map perfectly onto that.

Do NOT quietly redefine the draft.

Implement the smallest defensible experiment and document any deviation.

If necessary define this spike's extension as:

```text
settlement_method = physical
```

where successful physical handoff produces:

```text
spent future proofs
+
mint/farm redemption receipt
```

rather than another Cashu egg unit.

Clearly label that an experimental physical-settlement interpretation if the current NUT-32 draft does not already permit it.

---

# Production shortfall

Normal spike assumptions:

```text
expected eggs = 10
actual eggs = 10
```

But implement enough state to simulate:

```text
expected = 10
actual = 7
```

Do NOT silently settle all ten.

The remaining three claims should become explicitly unresolved/defaulted according to the terms.

Do not build insurance, liquidation or compensation logic.

---

# Refactor charger architecture while doing this

Use this spike to improve the existing EV charging architecture.

We now have two examples of the same general pattern.

## Charger

```text
Cashu payment
      ↓
external resource allocation
      ↓
charger triggered
      ↓
meter observes delivery
      ↓
receipt
      ↓
settlement/refund
```

## Egg future

```text
Signet payment
      ↓
future production capacity allocated
      ↓
Cashu future issued
      ↓
bearer transfer
      ↓
physical redemption
      ↓
receipt
```

Refactor common infrastructure where it is genuinely shared:

- durable operation IDs;
- quote/purchase correlation;
- external state transitions;
- idempotency;
- capacity/resource reservation;
- immutable pricing/terms snapshot;
- receipts;
- reconciliation;
- crash recovery;
- success/failure state.

Do NOT build an abstract framework for its own sake.

Keep:

```text
Wh
charger IDs
meter readings
device triggering
```

inside the EV adapter.

Keep:

```text
eggs
production dates
daily capacity
physical pickup
```

inside the farm adapter.

The result should make adding a third resource later feel natural without requiring it now.

---

# Preserve the charger's important lessons

In particular:

## Snapshot economic terms

Sarah's purchase stores:

```text
price_per_egg_sats = 1000
quantity = 5
total = 5000
terms hash
series
```

Changing the farm price tomorrow must not change Sarah's already-created paid purchase.

Same lesson as the charging tariff snapshot.

## Explicit ambiguity

Physical actions cannot be transactionally rolled back.

If:

```text
operator hands Sarah eggs
```

and then the process crashes before state is persisted, that ambiguity must be visible and reconcilable.

Do not pretend SQL makes physical handoff atomic.

---

# Deployment spike

Deploy the complete working branch to the existing experimental infrastructure.

The deployment must demonstrate:

```text
browser
   ↓
Sarah selects 5 next-Friday eggs
   ↓
real Signet payment request
   ↓
Sarah pays 5000 Signet sats
   ↓
Signet payment confirms
   ↓
capacity changes 10 → 5 remaining
   ↓
Sarah receives 5 NUT-32 future claims
   ↓
wallet shows 5 Friday eggs
```

Then demonstrate transfer:

```text
Sarah sends 2 to Bob
```

Then verify:

```text
Sarah = 3
Bob = 2
```

without requiring farm ownership registration.

For maturity/redemption, do not wait a real week during automated tests.

Use:

- injected clock;
- test maturity;
- or a clearly marked demo maturity override.

Production code must still respect real maturity timestamps.

---

# Automated Sarah acceptance test

Add an end-to-end automated test named around the user story, for example:

```text
sarah_buys_five_friday_eggs_with_signet
```

It must cover as much of the real stack as practical.

Scenario:

```text
GIVEN
    next Friday production capacity = 10
    price = 1000 Signet sats per egg
    Sarah has sufficient Signet funds

WHEN
    Sarah requests 5 Friday eggs

THEN
    purchase reserves 5 of 10 capacity
    quote requires 5000 Signet sats

WHEN
    Sarah pays the Signet request

THEN
    payment is cryptographically confirmed
    purchase becomes paid
    mint authorizes exactly 5 Friday futures

WHEN
    Sarah's wallet completes issuance

THEN
    Sarah controls amount=5
    unit=future:farm-egg:<Friday maturity>
    proofs contain valid NUT-32 terms commitment
    terms signature verifies
    series reports issued=5
    available capacity=5
```

Then:

```text
WHEN
    Sarah sends amount=2 to Bob

THEN
    Sarah controls 3
    Bob controls 2
    total supply remains 5
    unit unchanged
    terms URI unchanged
```

Then with test clock after maturity:

```text
WHEN
    Bob redeems 2
    operator confirms 2 eggs handed over

THEN
    those claims cannot be redeemed again
    redeemed=2
```

---

# Additional tests

At minimum test:

1. next-Friday series generation;
2. capacity exactly 10;
3. correct NUT-32 unit;
4. signed immutable terms;
5. terms content-address verification;
6. NUT-32 advertised by mint;
7. exactly-one future tag;
8. malformed future rejected;
9. `terms.unit` mismatch rejected;
10. terms signed by wrong mint rejected;
11. Sarah quote for 5 = 5000 demo sats;
12. unpaid Sarah quote reserves capacity;
13. expired unpaid quote releases capacity;
14. confirmed Signet payment authorizes issuance;
15. issuance before Signet confirmation fails;
16. 10 total issuance succeeds;
17. 11th egg claim fails;
18. concurrent purchase race cannot exceed 10;
19. same payment cannot mint twice;
20. Sarah's NUT-32 issuance is wallet-bound;
21. 5 can split into 3 + 2;
22. Sarah can transfer 2 to Bob;
23. normal swap preserves unit;
24. normal swap preserves terms URI;
25. no conversion to Saturday series;
26. no silent conversion to ordinary sat;
27. redemption before maturity rejected;
28. redemption after maturity succeeds;
29. duplicate redemption fails;
30. failed/aborted physical handoff preserves appropriate recoverable state;
31. existing charger tests pass;
32. Pecan's existing main flows remain operable where intended.

---

# Operational observability

Add useful operator diagnostics for the deployed spike.

For each purchase expose:

```text
purchase id
series
quantity
Signet amount
payment state
capacity reservation state
future issuance state
wallet claim state if knowable without breaking privacy
error/reconciliation state
```

For each series:

```text
capacity
reserved by unpaid purchase quotes
issued
redeemed
remaining issuable capacity
actual production
```

Do not display holder identities as part of aggregate series state.

---

# No fake success

A green UI is not sufficient.

For the deployed acceptance demonstration verify independently that:

- the Signet transaction/invoice was actually settled;
- NUT-32 proofs really exist;
- their signatures verify;
- their terms references verify;
- capacity accounting changed;
- Cashu transfer really changes bearer control;
- spent-state prevents double redemption.

Capture these checks in automated tests and/or a reproducible runbook.

---

# Documentation

Add something like:

```text
docs/egg-futures-spike.md
```

Include:

## Sarah's story

Describe in plain language:

> Sarah wants five eggs next Friday. She selects five eggs in Pecan. At 1000 Signet sats each, she pays 5000 Signet sats. After the Signet payment confirms, the mint issues five bearer claims against next Friday's ten-egg production. Sarah can keep them, give them away, or resell them. The farm does not need to know who currently holds them. At maturity, the bearer redeems them for physical eggs.

Include sequence diagram:

```text
Sarah        Pecan       Signet       Mint       Farm ledger

  | quote 5    |            |           |             |
  |----------->|            |           |             |
  |             | reserve 5  |           |             |
  |             |------------------------------------->|
  |             |            |           |             |
  | 5000 sats   |            |           |             |
  |------------------------->|           |             |
  |             | confirmed  |           |             |
  |             |<-----------|           |             |
  |             | authorize 5 futures    |             |
  |             |----------------------->|             |
  |             |            |           |             |
  |      5 Friday egg Cashu futures      |             |
  |<-------------------------------------|             |
```

Also explain why this is:

```text
NFT-like
```

but not actually an NFT architecture:

```text
unique dated series
+
fungible quantity inside the series
+
Cashu bearer ownership
```

---

# Explicit non-goals

Do not build:

- mainnet payments;
- securities exchange;
- order book;
- margin;
- leverage;
- liquidation;
- derivatives pricing engine;
- NFT marketplace;
- numbered eggs;
- blockchain;
- token launch;
- price speculation UI;
- farm ownership registry;
- identity/KYC system;
- production insurance;
- generalized commodity marketplace.

This is an experimental Signet/Cashu physical-resource PoC.

---

# Development approach

Work directly on the code.

Do not ask for approval between normal implementation steps.

Proceed in this order unless repository reality strongly suggests otherwise:

1. inspect current Pecan/CDK/deployment;
2. read NUT-32 completely;
3. document the minimum NUT-32 implementation boundary;
4. branch cleanly for the spike;
5. implement NUT-32 primitives in CDK/mintd;
6. implement terms signing;
7. implement content-addressed terms storage;
8. implement farm daily-series state;
9. implement capacity reservations;
10. implement actual Signet payment quote/confirmation;
11. implement Sarah's purchase saga;
12. implement future issuance;
13. implement Cashu transfer/split validation;
14. implement physical redemption;
15. refactor charger/resource lifecycle code where useful;
16. implement Sarah-focused UI;
17. implement tests;
18. deploy to existing `giftcare.cashu.exchange` infrastructure;
19. run the real Sarah Signet purchase;
20. verify resulting proofs independently;
21. exercise transfer to Bob;
22. exercise accelerated/test redemption;
23. fix deployment/runtime problems;
24. document the working runbook.

Do not stop at “code compiles.”

The spike is complete when the deployed Sarah story works.

---

# Final report

At completion report:

- deployed URLs;
- actual hostname used;
- branch/commit(s);
- Pecan modifications;
- CDK/mintd modifications;
- NUT-32 subset implemented;
- deviations/extensions to NUT-32;
- how mint identity signing works;
- how terms are content-addressed;
- how Friday capacity=10 is enforced;
- how concurrent purchase races are prevented;
- how Signet payment is confirmed;
- exact Sarah purchase tested;
- Signet sats paid in the demonstration;
- Sarah's resulting future proofs;
- demonstration of Sarah → Bob transfer;
- redemption demonstration;
- physical-settlement ambiguity handling;
- charger refactor performed;
- automated tests and results;
- deployment smoke-test results;
- remaining technical debt;
- smallest next experiment.

The most important final artifact is not a design document.

It is this working story:

```text
Sarah has Signet sats
        ↓
Sarah pays for 5 next-Friday eggs
        ↓
Farm receives confirmed Signet consideration
        ↓
Cashu mint issues 5 scarce dated bearer futures
        ↓
Sarah can transfer/resell them
        ↓
bearer can redeem them for Friday's physical production
```