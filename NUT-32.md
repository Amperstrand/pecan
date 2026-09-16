# NUT-32: Cashu Futures

`draft`

`depends on: NUT-00, NUT-01, NUT-03, NUT-04, NUT-06, NUT-10`

`uses: NUT-07, NUT-11, NUT-12, NUT-14, NUT-20, NUT-28, NUT-31`

This is an application-layer proposal. It does not change Cashu proofs, blind
signatures, keysets, or the standard amount type.

## Scope and model

A future is a Cashu bearer instrument for a defined payoff at a future
maturity. The mint that issues it is the settlement authority. NUT-32 does not
define an order book, collateral, margin, liquidation, or a price oracle
network.

The token keeps the normal Cashu fields:

| Field | Required value | Why it is here |
| --- | --- | --- |
| `unit` | `future:<base>-<quote>:<maturity>` | Selects the future series, direction, and maturity in the Cashu namespace. |
| `amount` | Normal Cashu non-negative integer | Counts future units; reusing Cashu amount keeps denomination, splitting, and fee logic unchanged. |
| proofs | Normal Cashu proofs | Carry ownership and mint authorization. |
| proof secret | NUT-10 secret with one `future` tag | Binds the terms reference into the mint-signed message without changing token encoding. |

There is no new top-level token property. The terms reference belongs in the
proof secret, because token-level memos are optional, mutable application
metadata and are not covered by a proof signature.

## Unit

The canonical unit grammar is:

```text
future:<base>-<quote>:<YYYYMMDD>T<hhmmss>Z
```

`base` and `quote` are lowercase ASCII identifiers matching `[a-z0-9]+`.
The direction is conventionally long `base` / short `quote`; reversing the
two identifiers is the opposite direction. The timestamp is UTC in ISO-8601
basic form, so `:` is not overloaded as a time separator. Implementations MUST
reject lowercase `t`/`z`, offsets, fractional seconds, and impossible dates.

For example:

```text
future:mb-btc:20021225T000000Z
```

The maturity in `unit` identifies the series. It is not a general Cashu token
expiry. NUT-02 keyset `final_expiry` and NUT-04/NUT-05 quote `expiry` retain
their existing meanings.

## Future secret

The proof secret remains a NUT-10 `Secret`. Its `tags` array MUST contain
exactly one tag of this form:

```json
["future", "1", "https://blossom.example/<sha256>"]
```

The three elements mean version, terms URI, and nothing else. The URI MUST be
canonical and content-addressed. A Blossom URL ending in the SHA-256 digest of
the exact blob is the recommended form. The tag is part of the secret hashed
by Cashu's blind signature, so it cannot be changed without replacing the
proof. Applications MAY use P2PK, HTLC, or NUT-28 spending conditions around
this tag; those conditions do not alter future terms.

## Terms blob

The blob at `terms_uri` is a UTF-8 canonical JSON signed envelope:

```json
{
  "mint": "https://mint.example",
  "signature": "<signature over canonical JSON of terms and mint>",
  "terms": {
    "contract_size": "1",
    "oracle": "https://oracle.example/mb-btc",
    "settlement_method": "physical",
    "settlement_unit": "sat",
    "strike": "0.00010",
    "unit": "future:mb-btc:20021225T000000Z"
  }
}
```

`terms.unit` MUST equal the token unit. `strike`, `contract_size`, and all
quantities are canonical non-negative decimal strings; the terms define their
scale and payoff formula. `settlement_unit`, `settlement_method`, and
`oracle` define how the mint settles the series. The `terms` object MAY contain
additional application fields, but a wallet MUST preserve unknown fields and
MUST NOT interpret them as settled obligations.

The signed payload is exactly the object `{ "mint": ..., "terms": ... }`,
serialized canonically, prefixed with the domain string
`Cashu_NUT32_Terms_v1:`. `signature` is a BIP-340 Schnorr signature over the
SHA-256 digest of that message, verified with the mint's NUT-06 `pubkey`.
It authenticates the mint named in `mint`.
The content address authenticates the bytes; the mint signature authenticates
the issuer. A mutable ordinary HTTPS document is not sufficient.

## Capability and validation

A supporting mint advertises NUT-32 in NUT-06:

```json
"32": { "supported": true, "versions": [1] }
```

Wallets MUST require this capability before issuing, swapping, or settling a
future. They MUST verify the unit grammar, the exactly-one future tag, the
content-addressed terms blob, its mint signature, and `terms.unit`. A generic
Cashu wallet MUST treat a future as an unsupported custom unit; it MUST NOT
claim to understand or settle it.

## Issuance, transfer, and settlement

The mint MUST issue only outputs whose future unit and signed terms are valid
for the mint. A NUT-32-aware swap MUST preserve the future unit and terms URI
for every replacement proof; it MUST NOT convert a future into ordinary Cashu
or silently change its maturity, direction, or terms. The normal Cashu amount
is split and summed normally.

At or after maturity, the mint verifies its published settlement rule and
oracle result, atomically spends the future proof, and issues the stated
`settlement_unit` amount. The operation MUST be idempotent: retrying the same
settlement either returns the same result or reports that the proof is already
spent. Until settlement, normal NUT-07 state checks apply. A failed settlement
must not silently spend the future.

## Compatibility and security

The future-specific data is outside the ordinary Cashu token envelope only in
the sense that the blob is external; its URI is inside each signed proof
secret. This keeps existing token encodings and amount handling compatible
while making the terms reference tamper-evident.

Sending a future to a wallet that supports only standard units may fail at unit
selection or be displayed as an unknown token. Senders MUST negotiate NUT-32
support and MUST not downgrade a future to another unit. A terms URI alone is
not authority, and a mint signature alone without a content-addressed blob is
not an immutable terms commitment.

## Minimal test vector

```text
unit: future:mb-btc:20021225T000000Z
amount: 3
future tag: ["future", "1", "https://blossom.example/..."]
terms.unit: future:mb-btc:20021225T000000Z
```

This represents three contracts of one future series. The quantity of MB (or
the settlement payoff) is defined by `contract_size` and the payoff rule in
the signed terms blob, not by a second Cashu amount field.
