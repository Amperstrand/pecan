# Upstream research 02 — Threading the mint quote id and NUT-20 pubkey to payment backends

Status: research complete against pinned cdk rev `6132607495ae0741e412a63f2acc34e4ccddfc55`
(tag `v0.17.2`, fetched from `https://github.com/cashubtc/cdk` — remote verified via
`~/.cargo/git/db/cdk-57defa95db2b7762/FETCH_HEAD`). Date: 2026-08-01.

Downstream artifacts referenced:

- Patch: `patches/cdk-managed-units.patch` (the `crates/cdk/src/mint/issue/mod.rs` hunk, patch lines 315–352)
- Consumer: `processor/src/backend.rs` (`incoming_meta`, `QUOTE_ID_FIELD`, `PUBKEY_FIELD`), `processor/src/state.rs` (teller matching)
- Pin: `processor/Cargo.toml:25-27` pins all cdk crates to the same rev

Everything below is labelled **[verified]** (read from source / git history) or **[inference]**
(reasoned, not directly evidenced).

---

## 1. The constraint

The downstream mint runs a "branch" custom payment method: a human teller settles a mint
quote by matching the **mint-generated quote id** that the customer's wallet displays
(typed tail or scanned full id — `processor/src/state.rs:156-178 normalize_match_input`,
`:198-207 query_matches`). That requires the gRPC payment backend to know the mint's quote
id **at quote-creation time**, plus the wallet's NUT-20 locking pubkey (the backend's
policy is to refuse unlocked branch quotes; `processor/src/backend.rs:163-174`).

Stock cdk does not provide either. In the custom-method path of `get_mint_quote`, the
backend receives only `{method, description, amount, unix_expiry, extra_json}` where
`extra_json` is the **wallet-supplied** `extra` verbatim
(`crates/cdk/src/mint/issue/mod.rs:306-318` at the pinned rev) **[verified]**.

The asymmetry in one sentence **[verified]**: for **melt**, stock cdk already passes the
mint's quote id to backends as a first-class, documented-required field on every variant
(`CustomOutgoingPaymentOptions.quote_id`, `cdk-common/src/payment.rs:307-312`; proto
`PaymentQuoteRequest.quote_id = 6` marked "Required",
`cdk-payment-processor/src/proto/payment_processor.proto:176-179`) — and for **onchain
mint quotes** it passes it too (`OnchainIncomingPaymentOptions { quote_id }`,
`payment.rs:237-241`, proto `:127-129`). Only the bolt11/bolt12/custom **incoming**
options lack it, and no incoming option carries the NUT-20 pubkey.

The downstream patch closes the gap by injecting `quote_id` and `pubkey` into the
`extra_json` map **after** parsing wallet extras, so a wallet cannot spoof either key
(`patches/cdk-managed-units.patch` lines 319–352).

---

## 2. Stock flow trace (custom payment method, pinned v0.17.2)

### 2.1 Wallet → mint: `POST /v1/mint/quote/{method}`

- Route registered by `create_custom_routers`
  (`crates/cdk-axum/src/custom_router.rs:40`) → handler `post_mint_custom_quote`
  (`crates/cdk-axum/src/custom_handlers.rs:179-279`) **[verified]**.
- For a non-bolt11/bolt12/onchain method the raw JSON body is parsed into
  `MintQuoteCustomRequest` (`custom_handlers.rs:253-258`) **[verified]**:

  ```rust
  // crates/cashu/src/nuts/nut04.rs:349-368
  pub struct MintQuoteCustomRequest {
      pub amount: Amount,
      pub unit: CurrencyUnit,
      pub description: Option<String>,
      /// NUT-19 Pubkey            // (sic — the field implements NUT-20 locking)
      pub pubkey: Option<PublicKey>,
      /// Extra payment-method-specific fields
      #[serde(flatten, default, ...)]
      pub extra: serde_json::Value,
  }
  ```

  All unrecognized top-level JSON keys of the wallet's request flatten into `extra`.
  Note the pubkey is **optional** for custom methods; the handler enforces
  `PubkeyRequired` only for bolt12 (`custom_handlers.rs:213-215`) and onchain
  (`:236-241`) **[verified]**.

### 2.2 Inside `Mint::get_mint_quote` — the ordering the patch relies on

`crates/cdk/src/mint/issue/mod.rs` **[verified]**:

| line | event |
|---|---|
| 218 | `let pubkey = mint_quote_request.pubkey();` — for `Custom` this is `request.pubkey` (`cdk-common/src/mint_quote.rs:86-93`) |
| 222 | **`let quote_id = QuoteId::new();`** — UUIDv7 (`crates/cashu/src/quote_id.rs:35-40`) |
| 280–321 | `Custom` arm: length-checks `description` and `extra` against `MAX_REQUEST_FIELD_LEN = 1024` (`crates/cdk/src/mint/verification.rs:12`), then builds `extra_json = request.extra.to_string()` (wallet value only, lines 306–310) and constructs `CustomIncomingPaymentOptions` (312–318) — **`quote_id` and `pubkey` are in scope but not used** |
| 322–326 | contrast: `Onchain` arm constructs `OnchainIncomingPaymentOptions { quote_id: quote_id.clone() }` |
| 329–335 | `ln.create_incoming_payment_request(payment_options).await` — the backend call |
| 337–352 | `MintQuote::new(Some(quote_id), response.request, unit, amount, response.expiry, response.request_lookup_id, pubkey, …, Some(response.extra_json.unwrap_or_default()))` |
| 363–365 | `tx.add_mint_quote(quote)` + `tx.commit()` — **the quote row exists in the DB only after the backend call returns** |

So the quote id **does** exist before the backend call in stock code. That ordering was
introduced by `05fc5fe7` ("refactor(cdk): use polymorphic enums for mint and melt
quotes", thesimplekid, 2026-04-12), which added `let quote_id = QuoteId::new_uuid();` at
exactly this position (renamed to `QuoteId::new()` by `3eed72a5`, "feat: use uuid v7 for
better index", 2026-05-21; both verified via `git log -L`) — and it is **load-bearing
upstream**: the `Onchain` arm consumes the pre-generated id. The downstream patch relies
on ordering that stock cdk itself depends on; it is not incidental **[verified]**.

### 2.3 Mint → backend: trait struct and gRPC message

Trait side (`crates/cdk-common/src/payment.rs:219-234`) **[verified]**:

```rust
pub struct CustomIncomingPaymentOptions {
    pub method: String,
    pub description: Option<String>,
    pub amount: Amount<CurrencyUnit>,
    pub unix_expiry: Option<u64>,
    /// Extra payment-method-specific fields as JSON string
    ///
    /// These fields are passed through to the payment processor for
    /// method-specific validation (e.g., ehash share).
    pub extra_json: Option<String>,
}
```

Wire side (`crates/cdk-payment-processor/src/proto/payment_processor.proto:52-59,
131-142`) **[verified]**:

```proto
message CustomIncomingPaymentOptions {
  optional string description = 1;
  optional AmountMessage amount = 2;
  optional uint64 unix_expiry = 3;
  optional string extra_json = 4;
}
message CreatePaymentRequest { IncomingPaymentOptions options = 2; }
```

Conversions: mint→proto in `proto/client.rs:180-188` (copies the four fields; the
`method` string is **dropped on the wire**), proto→trait in `proto/server.rs:226-241`
(reconstructs with `method: "".to_string()` — server.rs:234). The backend does not even
learn the method name today, a limitation the downstream code documents
(`processor/src/backend.rs:211-214`) **[verified]**.

### 2.4 Backend → mint: `CreateIncomingPaymentResponse`

`payment.rs:529-543` **[verified]**:

```rust
pub struct CreateIncomingPaymentResponse {
    pub request_lookup_id: PaymentIdentifier,  // backend-chosen correlation key
    pub request: String,                       // what the wallet will display/pay
    pub expiry: Option<u64>,
    #[serde(flatten, default)]
    pub extra_json: Option<serde_json::Value>, // backend → wallet passthrough
}
```

`PaymentIdentifier` already has a `QuoteId(QuoteId)` variant with kind string
`"quote_id"` (`payment.rs:94-109, 133-137`) **[verified]**.

The mint stores `request_lookup_id` (+ its `kind`) and `request` on the quote row; both
are UNIQUE-indexed (`cdk-sql-common/src/mint/migrations/sqlite/20240703122347_request_lookup_id.sql`,
`20260416000000_unique_mint_quote_request.sql`) **[verified]**.

### 2.5 Mint → wallet: response

`MintQuote → MintQuoteCustomResponse<QuoteId>` (`cdk-common/src/mint.rs:1287-1306`)
returns `{quote: <mint quote id>, request: <backend's request string>, amount,
amount_paid, amount_issued, unit, expiry, pubkey, ...extra}` where `extra` is the
**backend-returned** `extra_json` stored on the quote (issue/mod.rs:351), serialized
flattened (`nut04.rs:394-424`) **[verified]**. So: the wallet learns the quote id and the
backend's `request`; the backend learned neither the quote id nor the pubkey.

### 2.6 Settlement: how payment events find the quote

Backend emits `WaitPaymentResponse { payment_identifier, payment_amount, payment_id }`
(`payment.rs:510-519`); the mint resolves it via
`get_mint_quote_by_request_lookup_id`, matching **both** the identifier string and its
kind (`issue/mod.rs:429-483`; SQL in `cdk-sql-common/src/mint/quotes.rs:207-242`:
`WHERE request_lookup_id = :id AND request_lookup_id_kind = :kind`) **[verified]**.
`request_lookup_id` is therefore *the* mint-side correlation key — but it is
backend-chosen and the backend gets no mint-side identifier to derive it from in the
custom incoming path.

### 2.7 Who knows what, when (custom method, stock)

| step | wallet | mint | backend |
|---|---|---|---|
| after HTTP parse | amount/unit/pubkey/extra | same + generates `quote_id` (issue/mod.rs:222) | — |
| during `CreatePayment` RPC | — | `quote_id`, `pubkey` (in scope, unsent) | method="", description, amount, expiry, wallet `extra_json` only |
| after RPC | — | + backend's `request_lookup_id`, `request`, response `extra_json` | its own invented key (e.g. fake wallet: fresh `Uuid::new_v4` as `CustomId`, `cdk-fake-wallet/src/lib.rs:872-884`) |
| quote row committed | — | everything | still no mint identifiers |
| wallet response | **quote id**, request, pubkey, extra | everything | still no mint identifiers |

The backend is the only party that never learns the quote id, and the only party that
cannot verify the quote is NUT-20-locked **[verified]**.

### 2.8 The NUT-20 pubkey path in stock

- Enters as `MintQuoteCustomRequest.pubkey` (`nut04.rs:357-359`); extracted at
  `issue/mod.rs:218`; stored on `MintQuote.pubkey`
  (`cdk-common/src/mint.rs:556`; column added by migration
  `20241108093102_mint_mint_quote_pubkey.sql`) **[verified]**.
- Enforced at **mint time** (`POST /v1/mint/{method}`): if `mint_quote.pubkey` is set,
  the NUT-20 signature over `quote_id || B_0..B_n`
  (`crates/cashu/src/nuts/nut20.rs:36-47,61-71`) must verify
  (`issue/mod.rs:809-828`); bolt12 quotes additionally *require* a pubkey
  (`issue/mod.rs:800-806`) — custom quotes do not **[verified]**.
- **No stock path forwards the pubkey to any backend, for any method.** Grep over
  `cdk-common/src/payment.rs` and the proto: no pubkey field exists in any
  incoming/outgoing option or message **[verified]**.
- Consequence: a backend that wants to accept only locked quotes (the branch policy —
  cash over a counter is only safe if the customer's wallet alone can mint) has no way
  to express or verify that policy in stock cdk **[verified]**, and stock cdk has no
  per-method "pubkey required" configuration either (only the hardcoded bolt12/onchain
  requirements above) **[verified]**.

---

## 3. Why the quote id is not passed today

Short answer **[inference, grounded in verified history]**: not a deliberate layering
prohibition — an artifact of `extra_json`'s design purpose plus "no backend needed it
yet". Every time a backend *did* need the id, upstream added it as a **first-class
field**, never via `extra_json`.

Verified history (all commits are ancestors of the pinned rev; `git log` in the
checkout):

- **PR #1251 / merge `255db0c3`** — "feat: support custom payment methods and unified
  router" (author **asmogo**, opened 2025-11-03, merged 2026-01-09;
  https://github.com/cashubtc/cdk/pull/1251). Introduced
  `CustomIncomingPaymentOptions`, `extra`/`extra_json` (all proto extra_json fields were
  in #1251's diff from the start), the custom router, and
  `MintQuoteCustomRequest/Response` **[verified]**. The doc comments state the design
  intent: *"These fields are passed through to the payment processor for
  method-specific validation (e.g., ehash share)"* (`payment.rs:229-233`) and *"This
  enables proper validation layering: the mint verifies well-defined fields while
  passing extra through to the payment processor"* (`nut04.rs:360-367`) **[verified]**.
  The #1251 review thread confirms the intent: **thesimplekid** proposed the flattened
  `extra` design citing ehash — *"I think for ehash they don't [work] as the share can
  be included in the mint quote request"* — and **asmogo** framed extras/request as the
  wallet's channel *"to forward extra data to the payment processor"*, with *"the clean
  upgrade path for wallets"* as the main argument **[verified, quoted from PR review]**.
  `extra` was conceived as a **wallet→processor passthrough**; nothing in the code,
  comments, or review reserves it for — or forbids — mint-injected keys; nobody
  proposed them, and the mint side never wrote into it **[verified]**.
  ("ehash" = ecash-denominated mining shares from **vnprc/hashpool**, *"an accountless
  mining pool that represents mining shares as ecash tokens"*; vnprc's earlier PR #1182
  — a hardcoded `mining_share` method, opened 2025-10-10 — was closed unmerged in
  favor of the generic #1251 **[verified]**; that hashpool drove the feature is
  **[inference]** from those data points.)
- **PR #1870 / commit `5e88c120`** — "Onchain bdk" / "feat(cashu,cdk): add onchain
  protocol support" (author **thesimplekid** — the lead maintainer; commit authored
  2026-04-10, merged 2026-05-22 as `1572941d`, closes #1803). First time an *incoming*
  backend needed the mint's id: added `OnchainIncomingPaymentOptions { quote_id }`
  (struct + proto field) rather than using extra_json **[verified]**. The stock bdk
  backend keys its records on it and echoes it:
  `track_receive_address(&address, &quote_id.to_string())` and
  `request_lookup_id: PaymentIdentifier::QuoteId(quote_id)`
  (`crates/cdk-bdk/src/lib.rs:606-640`) **[verified]**.
- **PR #1973 / merge `bc7e441e`** — "feat(payment-processor): propagate mint quote_id
  to backend" (**author zeugmaster — the downstream maintainer**, opened 2026-05-18,
  merged 2026-05-20, shipped in v0.17.0;
  https://github.com/cashubtc/cdk/pull/1973; the pinned checkout containing it was
  fetched from `github.com/cashubtc/cdk`, so the merge is verified). Added `quote_id`
  to all three then-existing `OutgoingPaymentOptions` variants and to
  `PaymentQuoteRequest`, bumped `PAYMENT_PROCESSOR_PROTOCOL_VERSION` 2.0.0→3.0.0
  **[verified]**. The commit message is the melt-side mirror of this report's argument:
  bolt11/bolt12 backends are *"insulated by the payment_hash / offer being
  intrinsically derivable"*, while *"custom backends have no such anchor, and have to
  fabricate a derivation — typically hashing `request` — which forces the wallet to
  make `request` unique per melt"* **[verified, quoted from the commit body]**. The
  review is the strongest signal available about maintainer attitude — thesimplekid:
  *"Should we just make the quote id required? … I think the quote id is a better look
  up id then what we do now and payment processor should be at least encouraged to use
  that if not forced… We error if the payment processor and mint are different versions
  anyway so I think making this required is okay?"* — after which the field was made
  required and the PR was approved (asmogo ACK, thesimplekid approval)
  **[verified, quoted from PR review]**.
- Related maintainer exploration: **PR #1132** "Quote id as lookup" (thesimplekid,
  closed unmerged) — *"refactors CDK's payment system to use Quote IDs as the universal
  lookup mechanism across all Lightning backends"* — long-standing maintainer
  preference for quote-id-centric correlation **[verified PR existence/description]**.
  Follow-ups hardening extra_json also show the custom-method machinery is actively
  maintained: #1742 (persist mint-quote extra_json — the migration
  `20260316000000_add_extra_json_to_mint_quote.sql` cited in §7.1), #1910 (melt), #2110
  / backport #2112 (stop discarding processor-returned extra_json) **[verified]**.

How the other stock backends correlate (research question 4) **[verified]**:

| backend | incoming `request_lookup_id` | source |
|---|---|---|
| cdk-cln | `PaymentIdentifier::PaymentHash(..)` from the created invoice | `cdk-cln/src/lib.rs:630` |
| cdk-lnd | `PaymentHash` | `cdk-lnd/src/lib.rs:422` |
| cdk-lnbits | `PaymentHash` | `cdk-lnbits/src/lib.rs:270,395` |
| cdk-bdk (onchain) | **`QuoteId` — the mint's id, persisted backend-side** | `cdk-bdk/src/lib.rs:629-634` |
| cdk-fake-wallet (custom) | fresh random `Uuid::new_v4()` as `CustomId` | `cdk-fake-wallet/src/lib.rs:872-884` |

So "backend keys its records on the mint quote id" is not a downstream eccentricity —
it is exactly what upstream's own onchain backend does. The custom incoming path is the
only quote-creating path where a backend that needs a stable mint-side key has nothing
to hold on to, and the fake wallet demonstrates the resulting pattern: invent a random
key **[verified]**.

Layering counter-argument, addressed **[inference]**: one could argue
`request_lookup_id` is *supposed* to be the only correlation key and backends shouldn't
know mint-level ids. Upstream's own code refutes this as a design rule: melt threads the
quote id everywhere with doc comments calling it "the stable correlation key"
(`payment.rs:307-312`) and even "required for protocol uniformity" on bolt11
(`payment.rs:267-271`); onchain *requires* the backend to echo the quote id back as its
lookup id, with mint-side validation of the echo (`payment.rs:324-336`,
`Error::OnchainQuoteLookupIdMismatch`). The direction of travel is explicitly toward
quote-id threading.

---

## 4. Upstream status today (main @ `77256eb0`, checked 2026-08-01)

Findings from fetching current `main` of `cashubtc/cdk` and searching its PRs/issues via
the GitHub API (delegated research pass; queries listed in Appendix B). Repo facts:
main HEAD `77256eb0c335101ba085962044219d229551cb67` (2026-07-30); latest release
**v0.17.3** (2026-07-12); `compare/v0.17.2...main` = ahead 131 / behind 18 (releases are
cut from a release branch; merge-base `86a7c6ca`) **[verified]**.

- `crates/cdk/src/mint/issue/mod.rs` (main): functionally unchanged on every point that
  matters. `let quote_id = QuoteId::new();` (line 222) still precedes
  `create_incoming_payment_request` (line 330); `pubkey` (line 218) still flows only
  into `MintQuote::new` (line 345); the custom arm (lines 312–320) still builds
  `extra_json` solely from wallet-supplied `request.extra` (lines 306–310); the onchain
  arm still passes `quote_id`. Drift vs pinned: custom `amount` became
  `Option` (`request.amount.map(...)`, from PR #2146) and `MintQuote::new` gained two
  timestamp args (accounting refactor `04cbe81ca8`, "feat: align mint quote accounting
  with NUT-04", 2026-07-11) **[verified via fetched main]**.
- `crates/cdk-common/src/payment.rs` (main): `CustomIncomingPaymentOptions` (lines
  220–234) is still `{method, description, amount, unix_expiry, extra_json}` with only
  `amount` now `Option<Amount<CurrencyUnit>>`; the `extra_json`/"ehash share" doc
  comment is unchanged; only `OnchainIncomingPaymentOptions` has an incoming `quote_id`;
  all four outgoing structs keep theirs. **The word "pubkey" appears nowhere in
  payment.rs or the proto** **[verified via fetched main]**.
- `payment_processor.proto` (main): `CustomIncomingPaymentOptions` identical (fields
  1–4). Additions since the pin, both from PR #2146 (asmogo, "feat(nut04/05): optional
  amount", merged 2026-07-10, `5fbcc94dbd`): `PaymentQuoteRequest.amount = 8` and
  `CustomOutgoingPaymentOptions.amount = 4`, both `optional`. `CreatePaymentRequest`
  unchanged (field 1 remains a hole from the `unit` removal in PR #1704)
  **[verified via fetched main]**.
- `PAYMENT_PROCESSOR_PROTOCOL_VERSION` is still `"3.0.0"` (main lib.rs line 22) — even
  though main's proto now differs from v0.17.3's proto, which also declares 3.0.0
  **[verified]**. Main is sitting in a "proto changed, version not yet bumped" state
  (see §5.3).
- **Directly adjacent open work: PR #2275** (asmogo, opened 2026-07-29, "analyze payment
  processor interfaces") adds `optional string method = 5;` to
  `CustomIncomingPaymentOptions` (plus `custom_method = 9` on `PaymentQuoteRequest` and
  `method = 8` on `CustomOutgoingPaymentOptions`), with **no version bump**. This fixes
  the method-name gap noted in §2.3 (server-side `method: ""`), proves
  `CustomIncomingPaymentOptions` is actively growing mint-known context fields, and
  claims field number 5 — the proposal below must coordinate numbering with it
  **[verified from PR file list]**.
- **No open or closed issue/PR asks for the mint quote id or NUT-20 pubkey in
  `create_incoming_payment_request`** for bolt11/bolt12/custom. Verified-negative after
  the searches in Appendix B (including zero hits for `CustomIncomingPaymentOptions` in
  issue/PR search). NUT-20-adjacent work exists but is all mint-HTTP-side, not
  processor-facing: open PRs #1834/#1932 "Mint Quote Lookup by Public Key"
  (implements cashubtc/nuts#341, closes #1746), closed #937, open issue #2204
  (deterministic NUT-20 locking derivation) **[verified]**. This would be the first ask.

> Where the GitHub pass and local git history could disagree, local history of the
> pinned checkout is authoritative up to v0.17.2; main-state claims come from files
> fetched at `77256eb0`.

---

## 5. Security and design analysis

### 5.1 The spoofing problem with extra_json conventions on stock cdk

On stock cdk, `extra` is wallet-controlled and forwarded verbatim
(`issue/mod.rs:306-310`) **[verified]**. Any backend that adopted a "read `quote_id` from
extra_json" convention against an *unpatched* mint is spoofable:

Attack sketch **[inference from verified mechanics]**: the branch teller matches open
tickets by quote-id suffix (≥6 hex chars, `state.rs:156-178`). Victim creates a quote;
their wallet shows mint quote id `Z`. An attacker who can observe `Z` (shoulder-surf,
screen share, or simply colliding on a short suffix) creates their own quote with
`extra = {"quote_id": "Z", ...}`. The backend registers the attacker's ticket keyed `Z`
(the victim's real `Z` was never registered — the unpatched mint never sent it). Teller
types `Z`'s tail, finds the attacker's ticket, takes the victim's cash, confirms — and
the mint credits the quote whose `request_lookup_id` is the *attacker's* ticket. The
attacker's wallet mints; the victim's quote stays unpaid. Suffix collisions alone also
enable cheap counter-DoS (ambiguous matches are refused, `state.rs:180-207`).

The downstream defenses that exist today: `incoming_meta` requires a well-formed UUID
and a pubkey (`backend.rs:145-176`), and `insert_open` rejects a re-used quote id
(`state.rs:316-328`) — but none of that helps if the *value itself* is attacker-chosen.
The only real fix is that the mint, not the wallet, asserts the id. The patch does that
by inserting `quote_id`/`pubkey` after parsing wallet extras, overwriting any
wallet-supplied keys of the same name (`patches/cdk-managed-units.patch:335-349`)
**[verified]**. Note the ordering detail: the 1024-byte `extra` length check
(`issue/mod.rs:291-300`) runs *before* injection, so mint-injected keys never eat into
the wallet's budget and cannot be used to overflow it **[verified]**.

### 5.2 First-class proto fields vs a documented extra_json convention

| | first-class fields | documented extra keys |
|---|---|---|
| spoofing | structurally impossible — separate field, wallet never writes it | prevented only by "mint overwrites last" discipline; every implementation must re-earn it |
| namespace | clean; `extra_json` stays 100% wallet-owned (its documented purpose, `payment.rs:229-233`) | mint and wallet share one JSON object; reserved-key list must be documented and versioned forever |
| typing | `QuoteId` / `PublicKey` parsed once at the boundary (cf. `server.rs:272-274` for onchain) | stringly-typed JSON, per-backend re-parsing |
| upstream precedent | onchain incoming (#1870), all outgoing (#1973), method name (open #2275) — every mint-known datum so far became a field | none — zero mint-injected extra keys exist upstream **[verified]** |
| wire compat | appended field numbers — old parsers skip unknown fields (proto3) | no wire change at all |
| honesty of contract | presence is a compile-time/API-level guarantee | "may or may not be there depending on mint version/patch" |

**[inference]** Upstream would almost certainly prefer first-class fields: it is their
twice-established pattern, and the `bc7e441e` review already accepted the identical
argument for melt. Proposing extra-key injection upstream would also implicitly bless a
mint-writes-into-wallet-namespace pattern they have so far avoided.

### 5.3 Backward compatibility and the strict version check

The gRPC channel enforces **strict equality** on `x-cdk-protocol-version`: the server
interceptor rejects any mismatch with `failed_precondition`
(`cdk-common/src/grpc.rs:47-68`; client injects the constant, `proto/client.rs:117-121`;
constant `"3.0.0"` at `cdk-common/src/lib.rs:19`) **[verified]**. Consequences:

- **Proto field addition, no bump**: wire-compatible in both directions (proto3 unknown
  fields are skipped; absent fields decode as defaults). New mint + old processor: field
  silently ignored — a processor that *requires* quote_id must runtime-check and error
  (the downstream one already does, with a precise message, `backend.rs:151-157`). Old
  mint + new processor: empty `quote_id` → same runtime error.
- **Proto field addition + bump to 4.0.0**: mixed versions fail loudly at connect time
  ("Protocol version mismatch: server=…, client=…"). This is the convention the
  quote-id-threading commit itself argued for: *"any old mint/backend pair will see a
  clear 'Protocol version mismatch' at connection time instead of misbehaving
  silently"* (`bc7e441e` body) **[verified]**. Cost: every out-of-tree processor must
  rebuild against the new cdk-common in lockstep.
- **extra_json convention**: no proto change, no bump — but the "compat" is illusory:
  behavior still differs by mint version, just without any detectable signal.

Actual upstream bump practice (full history of the constant) **[data verified; reading
inferred]**: introduced at 1.0.0 by PR #1617 (2026-02-12, `03a5a914`), whose body states
the nominal rule — *"When the grpc proto file is changed we MUST update the version used
in the header"*. In practice the bumps are batched per release cycle, not per field:
1.0.0→2.0.0 landed as a standalone chore (PR #1723 / `1505652c`, 2026-03-26) closing
issue #1720, *"Bump grpc version in mint payment grpc **before next release**"*, to
cover accumulated breaking changes (#1616/#1673 amount typing, #1704 unit removal);
2.0.0→3.0.0 was bumped in-PR by #1973 because its `quote_id` was **required** with
server-side absence rejection; the onchain message set (PR #1870) merged two days later
and rode the same unreleased bump; and since 3.0.0, **optional** field additions have
merged with no bump at all — #2146 (merged 2026-07-10) and open #2275 — leaving main's
proto ahead of v0.17.3's under the same declared "3.0.0".

**[inference]** Recommendation on versioning: mirror #1973 — make `quote_id` required
(non-optional string, like the outgoing messages) and bump in-PR to 4.0.0; that is the
exact precedent for a required correlation field, and thesimplekid's own #1973 review
("we error if the payment processor and mint are different versions anyway so I think
making this required is okay") pre-approves the reasoning. If maintainers prefer the
#2146/#2275 pattern instead, `optional` fields with no bump are acceptable to the
downstream: its processor already fails closed with a descriptive error when the id is
missing, and a release-time batch bump (the #1720 ritual) would land anyway.

### 5.4 Forwarding the pubkey: is it justified, and is it safe?

Why the backend needs it **[verified downstream rationale]**: the branch method's safety
argument is "cash over the counter is only safe for a NUT-20-locked quote" — otherwise
anyone who observes the quote id can race the customer to `POST /v1/mint`. The mint
verifies NUT-20 signatures (`issue/mod.rs:809-828`) but, for custom methods, never
*requires* a pubkey (§2.8), and the backend cannot see whether one was set. Forwarding
the pubkey (even just its presence) lets the backend enforce the policy at quote
creation — refusing early, with a clear wallet-visible error, instead of the teller
discovering an unlocked quote later. The downstream backend today only checks presence
and discards the value (`backend.rs:220`), but a first-class field also enables future
use (binding tickets to keys, receipts) **[verified/inference as marked]**.

Privacy/safety of forwarding **[inference from verified surfaces]**: the pubkey is
already stored in the mint DB and echoed in the public quote-status response
(`MintQuoteCustomResponse.pubkey`, `cdk-common/src/mint.rs:1299`), which anyone holding
the quote id can fetch. Forwarding it to the mint's own payment processor adds no
exposure beyond the mint's existing trust domain. It should be `optional` on the wire —
bolt11-style custom methods with unlocked quotes remain legal.

Alternative smaller ask **[inference]**: a per-method "pubkey required" mint setting
(mirroring the hardcoded bolt12/onchain checks) would cover the *policy* half without
forwarding anything — but it does nothing for the quote-id half, adds configuration
surface, and still leaves the backend unable to verify. Mentioned for completeness; not
recommended as the primary ask.

---

## 6. Options and recommendation

### Option A (recommended): first-class fields on the custom incoming path

Rust (`cdk-common/src/payment.rs`):

```rust
pub struct CustomIncomingPaymentOptions {
    pub method: String,
    pub description: Option<String>,
    pub amount: Amount<CurrencyUnit>,
    pub unix_expiry: Option<u64>,
    pub extra_json: Option<String>,
    /// The mint's quote id for this mint quote. Mirrors the melt-side
    /// OutgoingPaymentOptions::quote_id and OnchainIncomingPaymentOptions::quote_id.
    pub quote_id: QuoteId,
    /// NUT-20 locking pubkey of the quote, when the wallet supplied one.
    pub pubkey: Option<PublicKey>,
}
```

Proto (`payment_processor.proto`, appended numbers preserve wire layout; **numbering
must be coordinated with open PR #2275**, which claims field 5 for
`optional string method` — if it merges first, use 6/7):

```proto
message CustomIncomingPaymentOptions {
  optional string description = 1;
  optional AmountMessage amount = 2;
  optional uint64 unix_expiry = 3;
  optional string extra_json = 4;
  // (5 = method, if #2275 lands)
  string quote_id = 6;            // mint-generated; required (empty = old mint)
  optional string pubkey = 7;     // NUT-20 pubkey, hex, when the quote is locked
}
```

Note on rebasing the Rust sketch to current main: `amount` there is already
`Option<Amount<CurrencyUnit>>` (PR #2146), so the struct addition is orthogonal to
in-flight work; #2275's `method` proto field would also let `server.rs` stop
reconstructing `method: ""` (§2.3), which composes cleanly with this proposal.

Plumbing: populate in `issue/mod.rs` custom arm (both values are already in scope,
lines 218/222); serialize in `proto/client.rs:180-188`; parse in
`proto/server.rs:226-241` (reuse the onchain `quote_id.parse()` pattern at
`server.rs:272-274`). Impact of the required field: only sites that *construct*
`CustomIncomingPaymentOptions` need updating (the proto server, in-tree tests, and any
out-of-tree mint embedding); consumers that read fields — cdk-fake-wallet's custom arm
(`cdk-fake-wallet/src/lib.rs:872-884`) and third-party backends like the downstream one
— compile unchanged and may simply ignore the new fields, exactly as #1973's commit body
described for the outgoing addition. Bump `PAYMENT_PROCESSOR_PROTOCOL_VERSION` →
`4.0.0`. Roughly the same blast radius as #1973 (`bc7e441e` touched 7 files, +146/−8)
**[verified diffstat]**.

Optional uniformity extension: also add `quote_id` to `Bolt11IncomingPaymentOptions` and
`Bolt12IncomingPaymentOptions` (Rust + proto), completing the symmetry with the outgoing
side, where even bolt11 carries it "for protocol uniformity" (`payment.rs:267-271`).
Existing LN backends ignore it exactly as they did for the outgoing addition
(`bc7e441e` body notes they needed no code changes) **[verified]**. Offer it in the
issue; let maintainers choose minimal vs uniform.

### Option B: documented extra_json injection (the current patch, upstreamed)

Upstream the patch hunk as-is: mint inserts `"quote_id"`/`"pubkey"` into the extra map
after parsing wallet extras, with the overwrite rule documented on
`CustomIncomingPaymentOptions.extra_json`. No proto change, no version bump; the wallet
API is unchanged (wallet-sent keys of those names are silently replaced — today they
already reach the backend unfiltered, so no wallet can be *relying* on them
non-maliciously) **[verified mechanics; inference on impact]**. Downsides per §5.2 —
propose only if Option A is rejected on wire-stability grounds.

### Option C: per-method pubkey-required setting

Covers only the NUT-20-policy half; see §5.4. Not recommended as primary.

### Recommended concrete ask — issue outline

> **Title:** Pass the mint-generated `quote_id` (and NUT-20 `pubkey`) to payment
> backends when creating custom-method mint quotes
>
> 1. **Context.** Since #1251, custom methods let a gRPC processor implement arbitrary
>    payment rails. For melt, the backend receives the mint's `quote_id` on every
>    variant (#1973, the 3.0.0 bump) and onchain incoming quotes carry it too
>    (`OnchainIncomingPaymentOptions`, #1870). Custom **incoming** quotes receive only
>    the wallet-controlled `extra_json`.
> 2. **Problem.** A backend whose rail is keyed by the quote the wallet displays — e.g.
>    person-present settlement where a teller matches the customer's quote id — cannot
>    learn the id the mint just generated, even though it exists before
>    `create_incoming_payment_request` is called. It also cannot see whether the quote
>    is NUT-20-locked, so it cannot refuse unlocked quotes for rails where the lock is
>    the safety mechanism. Reading these from wallet-supplied `extra_json` is spoofable
>    by construction.
> 3. **Proposal.** Add `quote_id: QuoteId` (required) and `pubkey: Option<PublicKey>`
>    to `CustomIncomingPaymentOptions` (struct + appended proto fields); populate from
>    the already-in-scope values in `Mint::get_mint_quote`; bump
>    `PAYMENT_PROCESSOR_PROTOCOL_VERSION` to 4.0.0 per the #1973 convention (or ship
>    the fields `optional` without a bump per #2146/#2275, maintainers' choice).
>    Optionally extend bolt11/bolt12 incoming for uniformity with the outgoing side.
> 4. **Compatibility.** Field numbers appended (coordinated with #2275's `method = 5`);
>    wire-compatible; a version bump makes mixed deployments fail loudly at connect
>    time (same rationale as the 3.0.0 bump). Existing backends (cln/lnd/lnbits/fake)
>    ignore the new fields.
> 5. **Offer.** PR ready — the change mirrors the accepted melt-side patch (#1973).

**[inference]** Framing advice: lead with the melt/onchain symmetry (it makes the change
look like completing existing work, not adding a new concept), cite the bdk backend as
the in-tree consumer pattern, and present the pubkey as `optional` so it cannot be read
as a new protocol requirement. The prior acceptance of `bc7e441e` from the same
contributor materially de-risks the conversation.

---

## 7. Fallbacks and product impact if upstream declines

### 7.1 Bundled-mode workaround: read the mint's sqlite

Feasibility **[verified]**: the processor already opens the mint DB read-only for the
supply audit (`processor/src/supply.rs` — `rusqlite` with `OpenFlags` read-only, WAL
mode, one table, explicitly documented as "the processor's single deliberate exception
to 'talk to the mint only through its APIs'", `supply.rs:9-15`). The `mint_quote` table
contains everything needed: `id`, `request`, `request_lookup_id`,
`request_lookup_id_kind`, `pubkey` (SELECT list at
`cdk-sql-common/src/mint/quotes.rs:117-131`; columns from migrations
`20240703122347`, `20241108093102`). Lookup key: `WHERE request = '<ticket id>'` or
`request_lookup_id = '<ticket id>' AND request_lookup_id_kind = 'custom'` — both
UNIQUE-indexed **[verified]**.

Timing/consistency costs **[verified ordering, inferred impact]**:

- **The row does not exist during the RPC.** `tx.commit()` happens only after
  `create_incoming_payment_request` returns (`issue/mod.rs:329-365`), so the backend
  cannot resolve the quote id synchronously. It must register the ticket under its own
  id, return, and then poll the DB to backfill `quote_id` (and `pubkey`). The window is
  normally milliseconds — far shorter than the customer's walk to the counter — but the
  ticket is briefly unmatchable by quote id, and the NUT-20 policy check moves from
  "refuse the quote" (clean wallet error at creation) to "void the ticket after the
  fact" (quote already exists at the mint, wallet sees an unpaid quote that will never
  settle) — a strictly worse failure mode.
- **Orphans.** If mintd crashes between the RPC and the commit, or `add_mint_quote`
  fails, the ticket never gets a quote row and needs GC.
- **Coupling.** Schema surface grows from one 4-column audit table to the hot
  `mint_quote` table, which upstream migrated 3+ times in the four months before the
  pin (`20260316`, `20260416`, plus kind/index changes) — every CDK bump would need
  revalidation of a much bigger contract **[verified migration cadence]**.

### 7.2 External mints: the honest feature cost

The sqlite read only works when processor and mintd share a filesystem (the bundled
install). For an external/unbundled mint there is no workaround that preserves the
feature **[verified options, inferred assessment]**:

- refuse mint quotes without the patch-injected fields — current behavior
  (`backend.rs:151-157`), i.e. the branch *mint* feature simply does not exist on stock
  mints (melt still works, since melt quote_id is stock);
- or degrade to matching by the backend's own ticket id embedded in `request`
  (`normalize_match_input` already strips a `MINT-` prefix for wallets that display the
  request string, `state.rs:150-161`) — but wallets prominently show the **quote id**,
  and the whole teller UX ("read me the last 6 characters of the quote id") is built on
  it; and the NUT-20 lock policy remains unenforceable;
- or trust wallet-echoed extras — rejected, §5.1.

### 7.3 Keeping the patch

The patch is small (one hunk in `issue/mod.rs`) and applies to a slow-moving function,
but it must be rebased on every CDK bump, it keeps the downstream build off stock
`cdk-mintd` images, and its guarantee is invisible to third-party processors (nothing in
the stock API says "extra_json contains a trustworthy quote_id"). Sustainable
indefinitely; strategically inferior to ~40 lines upstream **[inference]**.

### 7.4 Summary

| path | teller UX | NUT-20 policy | works on stock mintd | works unbundled | maintenance |
|---|---|---|---|---|---|
| upstream Option A | full | enforced at creation | yes (once released) | yes | none after merge |
| keep patch | full | enforced at creation | no | yes (patched mintd anywhere) | rebase per bump |
| sqlite backfill | full after ~ms gap | post-hoc void only | yes (bundled) | **no** | schema-coupled |
| request-string matching | degraded | none | yes | yes | none |

---

## 8. Verdict

**Can it change?** Yes **[verified feasibility]**. Both values are in scope at the call
site (`issue/mod.rs:218,222`); the struct/proto/conversion pattern to copy exists twice
(onchain incoming, all outgoing); wire compatibility is a non-issue with appended field
numbers; blast radius ≈ the already-merged `bc7e441e` (7 files).

**Should it change?** Yes **[inference from verified design trajectory]**. It completes
an asymmetry upstream has been closing step by step; it converts a spoofable
extra-key convention into a structural guarantee for *any* custom-method backend that
needs mint-side correlation (not just this project — the fake wallet's
random-uuid workaround shows the gap is generic); and it is the only way a backend can
enforce a locked-quotes-only policy.

**Recommended ask:** Option A — first-class `quote_id` (required) + `pubkey`
(optional) on `CustomIncomingPaymentOptions`, protocol version → 4.0.0, offered as a PR
mirroring `bc7e441e`, with the bolt11/bolt12 uniformity extension mentioned as
maintainer's choice. Fall back to optional-fields-no-bump if the bump is contested;
fall back to Option B (documented extra injection) only if proto changes are refused
outright. Meanwhile the patch remains the correct downstream posture: it is
spoof-proof, ordering-sound, and forward-compatible with the proposed upstream shape
(the processor's `incoming_meta` reads names identical to the proposed field names).

---

## Appendix A: evidence index (pinned checkout unless noted)

| claim | location |
|---|---|
| quote id generated before backend call | `crates/cdk/src/mint/issue/mod.rs:222` vs `:329` |
| custom options built without quote_id/pubkey | `issue/mod.rs:306-318` |
| onchain incoming carries quote_id | `issue/mod.rs:322-326`; `cdk-common/src/payment.rs:237-241`; proto `:127-129` |
| quote row committed after RPC | `issue/mod.rs:363-365` |
| backend response contract | `cdk-common/src/payment.rs:529-543` |
| settlement lookup by request_lookup_id+kind | `issue/mod.rs:429-483`; `cdk-sql-common/src/mint/quotes.rs:207-242` |
| wallet response fields (custom) | `cdk-common/src/mint.rs:1287-1306`; `cashu/src/nuts/nut04.rs:394-424` |
| NUT-20 message & verification | `cashu/src/nuts/nut20.rs:36-47,61-71`; `issue/mod.rs:809-828` |
| pubkey optional for custom, required bolt12/onchain | `cdk-axum/src/custom_handlers.rs:213-215,236-241`; `issue/mod.rs:800-806` |
| no pubkey in any payment option/proto | `cdk-common/src/payment.rs` (full read); proto (full read) |
| melt-side quote_id fields + docs | `payment.rs:267-271,285-286,307-312,324-336`; proto `:176-183,214-242` |
| strict version equality | `cdk-common/src/grpc.rs:47-68`; constant `cdk-common/src/lib.rs:19` |
| gRPC conversions (method dropped, "" on server) | `cdk-payment-processor/src/proto/client.rs:180-188`; `server.rs:226-241` |
| QuoteId = UUIDv7 (or nutshell base64) | `cashu/src/quote_id.rs:26-40` |
| bdk keys records on mint quote id | `cdk-bdk/src/lib.rs:606-640` |
| LN backends use payment hash | `cdk-cln/src/lib.rs:630`; `cdk-lnd/src/lib.rs:422`; `cdk-lnbits/src/lib.rs:270` |
| fake wallet invents random custom key | `cdk-fake-wallet/src/lib.rs:872-884` |
| extra length check precedes patch injection | `issue/mod.rs:291-300`; `crates/cdk/src/mint/verification.rs:12` |
| mint_quote table columns | `cdk-sql-common/src/mint/quotes.rs:117-131`; migrations `20240703122347`, `20241108093102`, `20260316000000`, `20260416000000` |
| commits: #1251, onchain, quote-id threading, version bumps | `255db0c3`, `5e88c120`, `bc7e441e`, `1505652c` (#1723), `03a5a914` (#1617), `05fc5fe7`, `3eed72a5` (git log in checkout) |
| downstream consts & hard requirement | `processor/src/backend.rs:35-49,145-176` |
| teller matching by quote-id suffix | `processor/src/state.rs:144-207` |
| replay/dup rejection | `processor/src/state.rs:316-328` |
| event identifiers CustomId(ticket) | `processor/src/state.rs:442-449,561-565` |
| supply-audit sqlite precedent | `processor/src/supply.rs:1-15,79-93` |
| dependency pin to cashubtc/cdk rev | `processor/Cargo.toml:25-27`; `~/.cargo/git/db/cdk-57defa95db2b7762/FETCH_HEAD` |

## Appendix B: upstream (GitHub) research notes

Compiled 2026-08-01 from a delegated GitHub pass (authenticated `gh api` + raw file
fetches) against `cashubtc/cdk` main @ `77256eb0c335101ba085962044219d229551cb67`.

Files diffed against the pin: `crates/cdk/src/mint/issue/mod.rs`,
`crates/cdk-common/src/payment.rs`, `crates/cdk-common/src/lib.rs`,
`crates/cdk-payment-processor/src/proto/payment_processor.proto`.

Issue/PR searches run (all `repo:cashubtc/cdk`, open+closed): `"quote id" backend`,
`"payment processor" quote_id`, `"incoming payment" quote_id`,
`pubkey "payment processor"`, `"NUT-20"`, `nut20`, `"quote metadata"`,
`"mint quote" backend pass`, `correlation`, `request_lookup_id`, `extra_json`,
`"custom payment method"`, `CustomIncomingPaymentOptions` (0 hits),
`OnchainIncomingPaymentOptions` (0 hits), `ehash`; commit searches for `quote_id`,
`extra_json`, `"custom payment"`, `onchain`, `ehash` (0),
`PAYMENT_PROCESSOR_PROTOCOL_VERSION`. None surfaced a request for quote id / pubkey in
incoming backend calls.

Primary artifacts:

| ref | what |
|---|---|
| PR #1251 (merged 2026-01-09, `255db0c3`) | custom payment methods + `extra_json`; review thread with the ehash/flatten design discussion |
| PR #1182 (closed unmerged) | vnprc's hardcoded `mining_share` method — predecessor to #1251 |
| vnprc/hashpool | "accountless mining pool that represents mining shares as ecash tokens" (ehash) |
| PR #1973 (merged 2026-05-20, `bc7e441e`) | melt-side quote_id threading, required + 3.0.0 bump; thesimplekid's "required is okay" review |
| PR #1870 (merged 2026-05-22, `1572941d`; commit `5e88c120`; closes #1803) | onchain support incl. `OnchainIncomingPaymentOptions{quote_id}` + echo contract |
| PR #1132 (closed unmerged) | thesimplekid: "Quote IDs as the universal lookup mechanism" |
| PR #1617 (merged 2026-02-12, `03a5a914`; closes #1547) | version header + strict-equality interceptor, 1.0.0; "MUST update the version" rule |
| PR #1723 (merged 2026-03-26, `1505652c`; closes #1720) | batch bump to 2.0.0 "before next release" |
| PR #2146 (merged 2026-07-10, `5fbcc94d`) | optional `amount` proto fields added with **no** bump |
| PR #2275 (open, 2026-07-29) | adds `optional string method = 5` to `CustomIncomingPaymentOptions` (+ 2 more), no bump — coordinate field numbers |
| PRs #1742, #1910, #2110/#2112 | extra_json persistence/propagation fixes |
| PRs #1834/#1932 (open), #937 (closed), issue #2204 | NUT-20-adjacent, all mint-HTTP-side (quote lookup by pubkey, deterministic locking) |
| commit `04cbe81ca8` (2026-07-11) | mint-quote accounting refactor — source of `MintQuote::new` signature drift on main |
| release v0.17.3 (2026-07-12) | latest release; its proto lacks #2146's fields yet declares "3.0.0" |
