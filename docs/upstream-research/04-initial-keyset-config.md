# 04 — A unit's first keyset cannot be configured from mintd config

Research for an upstream-contribution decision. Stock cdk pinned at rev
`6132607495ae0741e412a63f2acc34e4ccddfc55` (tag `v0.17.2`, 2026-06-29), read from
`/Users/dariolass/.cargo/git/checkouts/cdk-57defa95db2b7762/6132607` (below: `cdk:`).
Upstream `main` checked at `77256eb0c335101ba085962044219d229551cb67` (2026-07-30).
Downstream repo: `/Users/dariolass/Developer/cashu/custom-unit-mint` (below: `dw:`).
Facts are cited `file:line`; anything not directly observed is marked **inference**.

---

## 1. The constraint

When cdk-mintd registers a payment backend for a unit, the unit's **first keyset** is
created by `MintBuilder::build` with hardcoded shape: powers-of-2 amounts, zero input
fee, and `final_expiry: None`. The library API to override amounts/fee —
`MintBuilder::configure_unit(unit, UnitConfig)` — exists upstream but **nothing in
cdk-mintd's config surface ever calls it**, and no API at all sets an expiry on a
builder-created keyset outside a test helper. The management RPC's `RotateNextKeyset`
already accepts `unit, amounts, input_fee_ppk, use_keyset_v2, final_expiry`
(`cdk:crates/cdk-mint-rpc/src/proto/cdk-mint-rpc.proto:129-135`), so every keyset
**after** the first is fully controllable; only the initial one is not.

The downstream patch (`dw:patches/cdk-managed-units.patch`) closes the gap with three
hunks relevant here:

- `[grpc_processor.unit_keysets.<unit>]` config struct (`GrpcProcessorUnitKeyset`:
  `amounts`, `input_fee_ppk`, `initial_final_expiry`) in `cdk-mintd/src/config.rs`
  (patch lines 138-163);
- a `configure_unit(...)` + `configure_initial_keyset_expiry(...)` call inside the new
  `configure_backend_for_managed_unit` in `cdk-mintd/src/lib.rs` (patch lines 42-57);
- `initial_keyset_expiries: HashMap<CurrencyUnit, u64>` on `MintBuilder` plus an
  `is_initial_keyset` branch replacing `final_expiry: None` in the ensure-keyset loop
  of `crates/cdk/src/mint/builder.rs` (patch lines 186-286).

The processor renders these blocks per managed unit
(`dw:processor/src/config.rs:630-641`), with
`initial_final_expiry = configured_at + keyset_lifetime_days * 86400`
(`dw:processor/src/config.rs:627-629`).

---

## 2. Stock behavior trace (verified)

### 2.1 mintd → builder path for a grpcprocessor unit

Per `[[ln]]` entry with `ln_backend = "grpcprocessor"`, mintd builds the processor and
calls `configure_backend_for_unit` (`cdk:crates/cdk-mintd/src/lib.rs:694-722`), which
discovers methods from the processor's settings and funnels into
`configure_backend_for_methods` (`lib.rs:939-975`). That function:

1. calls `mint_builder.add_payment_processor(unit, method, limits, backend)` per
   method (`lib.rs:948-957`);
2. applies the **global** `[info] input_fee_ppk` (an `Option<u64>`,
   `cdk:crates/cdk-mintd/src/config.rs:59`) to the unit via
   `set_unit_fee(&unit, input_fee)` (`lib.rs:970-971`). The same single value is
   applied to every backend unit — there is no per-unit fee config.

### 2.2 Auto-configuration with defaults

`add_payment_processor` ends with (`cdk:crates/cdk/src/mint/builder.rs:553-556`):

```rust
// Check that the unit has been pre-configured
if !self.supported_units.contains_key(&key.unit) {
    self.configure_unit(key.unit.clone(), Default::default())?;
}
```

`UnitConfig::default()` (`builder.rs:37-44`) is:

```rust
amounts: (0..32).map(|i| 2_u64.pow(i)).collect(),   // 1, 2, 4, …, 2^31 (32 denominations)
input_fee_ppk: 0,
```

So "powers of 2" means **2^0 through 2^31 = 2,147,483,648 — 32 keys**.
`configure_unit` itself (`builder.rs:353-382`) validates amounts (non-empty, sorted
ascending, deduplicated, no zero) and inserts into
`supported_units: HashMap<CurrencyUnit, (u64 /*fee*/, Vec<u64> /*amounts*/)>`.

**Ordering with `add_payment_processor`:** the doc comment (`builder.rs:334-337`) says
config is used "if not called before `add_payment_processor`", but mechanically the
auto-default fires only when the unit is *absent* from `supported_units`
(`builder.rs:554`), and `configure_unit` is a plain `HashMap::insert`
(`builder.rs:379-380`). Calling `configure_unit` **after** `add_payment_processor` but
before `build` therefore also works (last write wins) — this is exactly what stock
mintd's own `set_unit_fee` relies on, and what the downstream patch exploits by calling
`configure_unit` before `configure_backend_for_methods` in the same wrapper.

**Stock callers of `configure_unit`: none.** A repo-wide grep at the pinned rev finds
only the re-export (`cdk:crates/cdk/src/mint/mod.rs:43`) and unit tests inside
`builder.rs`. Neither cdk-mintd, cdk-integration-tests binaries, nor cdk-ffi call it;
mintd's only use of `UnitConfig` is `UnitConfig::default().amounts` when building
fakewallet *test* rotations (`lib.rs:777`). The same is true on current `main`
(`grep -c configure_unit crates/cdk-mintd/src/lib.rs` → 0). No stock config path of any
backend or unit type reaches `configure_unit`.

### 2.3 The ensure-keyset loop and `final_expiry: None`

`build_with_seed` (`builder.rs:720-738`) first constructs `DbSignatory::new(keystore,
seed, supported_units, custom_paths)` — whose `init_keysets` only **re-activates** an
existing highest-index keyset if its fee *and* amounts match the configured pair and it
is not expired (`cdk:crates/cdk-signatory/src/common.rs:30-68`) — then runs
`build_with_signatory` (`builder.rs:576-717`):

- Auth unit force-inserted as `(0, vec![1])` when auth is enabled (`builder.rs:584-588`).
- For each `(unit, (fee, amounts))` in `supported_units` (`builder.rs:590-654`):
  - find the active keyset for the unit; **none → rotate** (`builder.rs:633-637`);
  - active but `is_expired()` → warn "not rotating" and `continue` (`builder.rs:599-602`);
  - fee mismatch → rotate (`builder.rs:605-613`); **amounts mismatch → rotate**
    (`builder.rs:616-619`); explicit `use_keyset_v2` preference mismatch → rotate
    (`builder.rs:622-632`). **`final_expiry` is never compared.**
  - rotation call (`builder.rs:640-652`): `RotateKeyArguments { unit, amounts, fee,
    keyset_id_type: use_keyset_v2.unwrap_or(true) → Version01, final_expiry: None }`.
    The `None` is a literal at `builder.rs:650` — this is the only place the first
    keyset's expiry comes from, and there is no builder state that could feed it.
- Afterwards, `keyset_rotations` queued via `with_keyset_rotation(KeysetRotation)` are
  executed (`builder.rs:656-671`). `KeysetRotation` **does** carry
  `final_expiry: Option<u64>` (`builder.rs:46-60`) but is documented "Used to create
  inactive/expired keysets for testing" and, running after the ensure loop, always
  produces a *second* keyset. Its only caller is the fakewallet test config
  (`lib.rs:769-794`).

### 2.4 Keyset generation in the signatory

`DbSignatory::rotate_keyset` (`cdk:crates/cdk-signatory/src/db_signatory.rs:190-247`):

- First keyset for a unit: `derivation_path_index = 1`, inherited amounts empty
  (`db_signatory.rs:204-206`); `args.amounts` empty + no predecessor → error, so the
  builder always passes concrete amounts.
- Derivation path: `custom_paths` override (settable via
  `with_custom_derivation_paths`, `builder.rs:301-307` — also never called by mintd) or
  `derivation_path_from_unit(unit, index)` = **`m/129372'/unit_index'/index'`**
  (`common.rs:118-126`), where `unit_index` =
  `CurrencyUnit::hashed_derivation_index()` = first 4 big-endian bytes of
  SHA-256(uppercased unit string) with the top bit cleared
  (`cdk:crates/cashu/src/nuts/nut00/mod.rs:638-647`). Custom unit strings are fully
  supported; a unit-string hash collision check runs on creation
  (`common.rs:129-153`).
- `create_new_keyset` (`common.rs:81-116`) generates the keys and a `MintKeySetInfo`
  with `active: true`, `valid_from: now`, and the passed `final_expiry`; the keyset is
  persisted with `add_keyset_info` + `set_active_keyset(unit, id)`
  (`db_signatory.rs:239-242`), which repoints the unit's single active slot —
  **the previous active keyset becomes inactive** (active is computed as
  `db_active_keysets[unit] == id`, `db_signatory.rs:90`).
- Keyset ID: v2 IDs commit to keys + unit + fee + **final_expiry**
  (`cdk:crates/cashu/src/nuts/nut02.rs:183-223`; `Id::v2_from_data` appends
  `|final_expiry:<ts>` at `nut02.rs:205-209`).

---

## 3. Spec analysis: keyset `final_expiry`

**Status: ratified, not draft, not cdk-specific.** The current NUT-02 on
`cashubtc/nuts` `main` is marked `mandatory` and is the v2-keyset text; the keyset-v2
material (including `final_expiry`) merged via **PR cashubtc/nuts#182 "Keyset ID V2"**
(commit `9e601391`, 2026-01-11). V1 keyset IDs are explicitly "deprecated" (02.md
§"V1 Keysets (deprecated)"). Companion change: NUT-01 `/keys` now includes keyset
metadata (nuts#325, commit `cc6d06f7`, 2026-01-11).

Key spec points (from `https://raw.githubusercontent.com/cashubtc/nuts/main/02.md`):

- §"Keyset Final Expiry": *"A unix epoch number for a future point in time that
  represents the final expiry of the keyset. After the keyset's final expiry, the Mint
  is no longer obliged to fulfill promises signed with the keys from that keyset."*
  The mint may then *"irrevocably remove all of the nullifiers … associated with the
  expired keyset."* The field is optional and MAY be omitted/null. This is exactly the
  downstream redemption-gating model.
- ID derivation step 5 includes `|final_expiry:<ts>` when set — so for v2 keysets the
  expiry is **immutable at creation by construction**: it cannot be added to an
  existing keyset without producing a different keyset ID. This is the strongest
  protocol argument for creation-time expiry configuration: rotation can only
  *replace* a non-expiring keyset, never fix it.
- `GET /v1/keysets` schema includes `final_expiry: <int|null>`, and the **example
  response shows an `active: true` keyset with `final_expiry: 2059210353`** — an
  initial/active keyset carrying an expiry is not just permitted but illustrated.
- §"Active keysets": inactive keysets' proofs *"are still accepted as inputs"*; new
  outputs MUST come from active keysets; wallets SHOULD prioritize swapping proofs out
  of inactive keysets.

**cdk conformance** (pinned rev): `KeySetInfo.final_expiry` is serialized when present
(`nut02.rs:546-548`); `RotateNextKeyset` threads it end-to-end
(proto → `cdk:crates/cdk-mint-rpc/src/proto/server.rs` handler →
`Mint::rotate_keyset`, `cdk:crates/cdk/src/mint/keysets/mod.rs:74-101` → signatory).
Enforcement: expired keysets are rejected for **outputs and inputs**
(`cdk:crates/cdk/src/mint/verification.rs:79-85, 124-130`) and in `blind_sign` itself
(`db_signatory.rs:138-143`); inactive keysets are rejected for outputs only
(`verification.rs:72-78`). `is_expired` = `final_expiry` set and strictly past
(`cdk:crates/cdk-signatory/src/signatory.rs:93-95`).

**Wallet expectations:** NUT-02's wallet notes prescribe fetching all keysets and
tracking `active` flags; nothing yet mandates expiry-driven behavior beyond the mint's
released obligation. cdk's wallet carries/caches `final_expiry`
(`cdk:crates/cdk/src/wallet/mint_metadata_cache.rs:566`) and selects the active
lowest-fee keyset for outputs (`cdk:crates/cdk/src/wallet/keysets.rs:122-148`), but at
this rev has **no proactive swap-before-expiry logic** (inference from absence of any
`final_expiry` conditional in wallet code). Wallets must be herded off a keyset by
*inactivating* it well before expiry — which is precisely the downstream rollover
policy (rotate 14 days before a 90-day expiry, `dw:processor/src/config.rs:272-278`).

**Verdict: "initial keyset with expiry" is protocol-kosher.** The spec puts no
constraint on when an expiry may be set, shows an active keyset with one, and the v2 ID
scheme makes creation the *only* moment it can be set.

---

## 4. Why the initial shape is unconfigurable

Evidence points to **recency plus sat-centric minimalism**, not a deliberate design
stance. No issue or PR rejecting such config was found.

Timeline (all from `git log` in the pinned checkout):

| Date | Change | Ref |
|---|---|---|
| 2025-06-19 | `final_expiry` introduced (Keysets V2) | #702, `c61fd383` |
| 2025-11-25 | `max_order` removed; rotation RPC gains `repeated uint64 amounts` | #1329, `24f9a508` |
| 2026-02-03 | `use_keyset_v2` config in mintd (`[info]`, env var, README) + ensure-loop rewrite | #1592, `121ca874` |
| 2026-02-25 | Derivation aligned to `m/129372'/hash(unit)'/index'`; the literal `final_expiry: None` lands in the ensure loop | #1257, `046ea2b8` |
| 2026-02-26 | **`configure_unit`/`UnitConfig` added** — "enables non standard denominations of keysets". Touches builder/signatory/ffi-test only; **no mintd files** | #1659, `99b0aee6` |
| 2026-02-26 | `with_keyset_rotation` for inactive/expired **test** keysets | `d6143294` (fakewallet config: #1596) |
| 2026-03-03 | Rotation RPC gains `final_expiry` ("pass final_expiry through in DbSignatory::rotate_keyset") | #1686, `200b5bb3` |

Reading of the record:

1. **Recency / half-finished plumbing.** #1659 was merged four months before the
   pinned release to serve a library consumer's need for non-standard denominations.
   PR #1592 shows the project's own pattern of shipping a builder knob *and* its mintd
   config in one PR (`use_keyset_v2` got config, env var, example.config.toml and
   README lines simultaneously). #1659 simply did not do that half, and nobody has
   since (verified on `main` 2026-07-30). **Inference:** oversight/no-demand rather
   than refusal.
2. **Sat-centric defaults suffice for the flagship use case.** A sat mint with
   powers-of-2 and a single global fee needs nothing else; the only fee config ever
   added is the global `[info] input_fee_ppk` (`config.rs:59`, applied per-unit at
   `lib.rs:970-971`), and the only amounts "config" is the hardcoded default.
3. **Rotation RPC as the intended lifecycle tool.** The mintd README documents
   `mint-cli rotate-next-keyset` for keyset changes
   (`cdk:crates/cdk-mintd/README.md:168-184`), and the RPC accumulated exactly the
   fields the first keyset lacks (amounts 2025-11, version 2026-02, expiry 2026-03).
   **Inference:** upstream's mental model is "boot with defaults, shape by RPC" —
   which works for everything except the unavoidable first keyset.

**Config precedent in other backend sections:** none per-unit. `cln`/`lnd`/`lnbits`/
`ldk_node` sections contain payment-side settings only; the sole keyset-shape configs
are global (`[info] input_fee_ppk`, `[info] use_keyset_v2`) plus the fakewallet-only
`[[fake_wallet.keyset_rotations]]` (unit, fee, version, boolean `expired` — amounts
hardcoded to the default, expiry only "one hour in the past";
`cdk:crates/cdk-mintd/src/config.rs:724-743`, `lib.rs:769-794`,
`example.config.toml:300-317`). Notably, **nutshell** (the reference Python mint) has
long exposed initial-keyset shape as operator config: `max_order = 64`,
`mint_derivation_path`/`mint_derivation_path_list`, `mint_input_fee_ppk`
(`cashu/core/settings.py:31,54-55,67` on nutshell `main`) — cross-implementation
precedent that this belongs in mint config.

---

## 5. Upstream status today (checked 2026-07-31/08-01)

- **`main` @ `77256eb0`** (2026-07-30): unchanged. `builder.rs` still hardcodes
  `final_expiry: None` in the ensure loop (main line 658); `configure_unit` still has
  zero mintd callers; `cdk-mintd/src/config.rs` has no unit/keyset section.
- **PR #2253 "Auto-rotate keysets on an age interval"** (crodas — maintainer — opened
  2026-07-23, open, active): background rotation in the embedded signatory, config
  `[signatory] keyset_rotation_interval_seconds` (default 90 days), inspired by
  nutshell#1058 (also still open there); depends on #2270 (merged). Crucially: *"The
  replacement keeps the previous amounts, input fee and id version, and carries
  final_expiry forward by the keyset's active age."* Under #2253 every future keyset
  **inherits the first keyset's shape** — a `None` expiry presumably propagates as
  `None` forever — which makes the initial keyset's configurability *more* important,
  and makes an initial-shape config the natural companion feature.
- **PR #2268 "fix(signatory): reject non-future keyset expiries"** (open) — closes
  issue **#1945** ("rotate_keyset does not validate that expiry is in the future",
  2026-04-28). Upstream is actively hardening exactly this field.
- **Issue #1999 "Mint Keyset Autorotate & Auto-Prune"** (2026-05-23, open): operator
  demand for lifecycle automation; "prune" there means deleting proofs/blind
  signatures of aged keysets — keyset records themselves are not deleted.
- **Issue #1984 "Support adding custom (unit, method) pairs at runtime"** (gudnuf,
  2026-05-20, open, active contributor discussion): wants gRPC-registered epoch units
  with per-unit expiries, no restart. This is the RPC-first future; it also documents
  the same pain (unit registration is startup-config-bound today).
- **No open PR or issue proposes per-unit amounts/fee/expiry mintd config.** Searches
  for "keyset config", "amounts denominations", "max_order", "configure_unit",
  "unit_keysets" over cashubtc/cdk issues/PRs return nothing on point. The niche is
  empty and adjacent work is in flight — good timing for a proposal.

---

## 6. Workaround evaluation: boot with defaults, then immediately `RotateNextKeyset`

Mechanics if the whole keyset portion of the patch were dropped: mintd boots, the
builder creates keyset #1 (powers-of-2 ×32, fee 0, v2, no expiry, **active**); the
processor's existing reconciler then rotates. The downstream already has the machinery:
`reconcile_rollover` runs every 60s (8s initial delay) and rotates whenever the active
keyset has `final_expiry: None` (`dw:processor/src/main.rs:395-461`, the `None => true`
arm at 430-434), passing amounts/fee/expiry from the per-unit policy (446-448).

What the junk first keyset costs (all verified):

- **Permanent public listing.** Rotation deactivates it (`set_active_keyset`
  repoints; `db_signatory.rs:90,241`) but it stays in `GET /v1/keysets` forever:
  `Mint::keysets` filters only the Auth unit (`cdk:crates/cdk/src/mint/keysets/
  mod.rs:43-59`); the keys-database trait has **no delete/remove/hide operation**
  (`cdk:crates/cdk-common/src/database/mint/mod.rs:130-157` — `add_keyset_info`,
  `set_active_keyset`, getters only); no GC exists, and even #1999's proposed
  auto-prune deletes proofs/signatures, not keyset rows. `/v1/keys/{id}` continues to
  serve its 32 pubkeys (`keysets/mod.rs:15-24`).
- **Per-wallet footprint.** cdk's wallet fetches and persists **keys for every listed
  keyset including inactive ones** (`mint_metadata_cache.rs::fetch_from_http` — the
  "Fetch keys for each keyset" loop issues `GET /v1/keys/{id}` per unknown keyset,
  verifies the ID, stores keys in cache and DB), and NUT-02's recommended wallet flow
  does the same (02.md "Wallet implementation notes"). One extra HTTP round-trip and
  keyset+keys DB rows in every wallet, per junk keyset, forever.
- **Mint DB:** one `keyset` table row (`cdk:crates/cdk-sql-common/src/mint/
  migrations/sqlite/20240612124932_init.sql:18-26` + later columns). Negligible.
- **NUT-02 legality:** an active-then-immediately-inactive keyset violates nothing;
  rotation timing is unconstrained. Cost is cosmetic/forensic (a mystery genesis
  keyset in every explorer view) plus the wallet footprint above.
- **Issuance race window.** Between mintd readiness and the reconciler's rotation
  (≤ ~68s, longer if the processor is down), keyset #1 is active and signable. Outputs
  minted then would live on a **never-expiring** keyset — proofs on inactive,
  non-expired keysets stay redeemable indefinitely (`verification.rs:116-141` blocks
  only *expired* inputs), breaking the "all liabilities eventually expire" invariant.
  Downstream can close this: the processor is the only payment rail for these units,
  so refusing quotes for a unit until its keyset is correct prevents issuance (swap is
  no entry path — it needs pre-existing proofs of that unit). But correctness then
  depends on gating logic instead of construction.

**The disqualifying problem — builder reconciliation fights the RPC.** The ensure loop
re-runs on *every* boot and compares the active keyset against the *configured*
amounts/fee (`builder.rs:605-619`). Without `configure_unit`, "configured" means the
powers-of-2/fee-0 default (or the global `[info] input_fee_ppk`). Therefore:

- **Custom denominations are unstable:** an RPC-created keyset with non-default
  amounts triggers "amounts mismatch" on the next restart → mintd rotates *back* to
  powers-of-2 with `final_expiry: None` → the reconciler rotates *forward* again.
  Every restart mints two junk keysets and opens a fresh no-expiry active window.
  Per-unit fees differing from the single global value fight identically.
- **Default-shaped units are stable:** the loop never compares `final_expiry`, so a
  keyset with default amounts, matching fee, default version, plus an expiry passes
  untouched. Downstream's `default_amounts()` is bit-identical to upstream's default
  (`(0..32).map(2^i)`, `dw:processor/src/config.rs:468-470`) and the default fee is 0
  — so the *default* downstream policy happens to be workaround-stable.

**Honest rating:** viable only for units that keep default amounts and a uniform fee —
i.e., it supports the expiry dimension alone, at the cost of one junk keyset per unit
and a gated race window. It **cannot** replace the `configure_unit` plumbing for the
product's per-unit custom denominations/fees; making the builder tolerate custom
shapes would itself require reaching `configure_unit` from config, which is the very
constraint. As a *patch-shrinking* step it can remove only the `builder.rs` hunk
(initial-expiry), not the config.rs/lib.rs hunks — and since the downstream patch
touches the `cdk` crate for unrelated reasons anyway (`mint/mod.rs` info refresh,
`issue/mod.rs` quote extras: patch lines 287-353), dropping that hunk does not reduce
the set of patched crates.

---

## 7. Options for the upstream proposal

### (a) Backend-agnostic per-unit keyset config in mintd — recommended

A top-level section, not tied to grpc_processor:

```toml
[keyset.SAT]
amounts = [1, 2, 4, 8, 16, 32]
input_fee_ppk = 100
lifetime_seconds = 7776000   # optional; builder-created keysets get final_expiry = now + lifetime
```

Wiring: mintd calls `configure_unit` for each configured unit before/after backend
registration (ordering is safe, §2.2), and the lifetime feeds keyset creation in the
ensure loop. Cleanest mechanism: add the expiry to `UnitConfig` itself (or a
`lifetime`), so `configure_unit` fully describes a unit's keyset shape and the ensure
loop consumes it — a smaller delta than the downstream's parallel
`initial_keyset_expiries` map, and semantically better ("keysets of this unit expire
after N", applying to *any* builder-created keyset, not a one-shot "initial" flag).
A relative `lifetime_seconds` beats the downstream's absolute `initial_final_expiry`
in a config file (absolute timestamps go stale; #2253 already established
seconds-based naming with `keyset_rotation_interval_seconds`).

Pros: solves the whole class for every backend; per-unit fees finally beat the odd
global `[info] input_fee_ppk`; matches the builder's existing "config declares desired
shape, mismatch rotates" semantics (fee/amounts/version already work that way —
`builder.rs:604-632`); composes perfectly with #2253, where the first keyset's shape
becomes the inherited template and its expiry ages forward; nutshell precedent
(§4). Cons: largest review surface of the three; needs answers for "amounts changed in
config" (already stock behavior: rotate) and whether config-triggered rotations also
carry the lifetime (they should).
**Acceptance: medium-high** — maintainers are actively editing these exact files
(#2253 touches `builder.rs`, `db_signatory.rs`, mintd config/env/README), #1659's
commit message anticipated non-standard denominations, and no competing design exists.

### (b) Builder hook only, config stays downstream

Upstream just the API: either `configure_initial_keyset_expiry` as in the patch, or
(better) the `UnitConfig` expiry field from (a). Precedent: `KeysetRotation` already
carries `final_expiry` (`builder.rs:46-60`); #2268 gives the validation story.
Pros: small PR, hard to object to; removes the `crates/cdk` builder hunk from the
patch. Cons: downstream still patches mintd config.rs/lib.rs, and only library
consumers benefit. Semver note: `UnitConfig` has public fields, so adding one is
breaking for struct literals — acceptable in cdk's pre-1.0 cadence (0.17→0.18 does
breaking changes routinely) but worth flagging in the PR.
**Acceptance: high.**

### (c) RPC-first: no config; first-rotation semantics

Make a unit's first keyset creatable only via RPC (builder defers creation, or a
`CreateKeyset` RPC), eliminating initial-shape config entirely. This is where #1984's
runtime unit registration is heading, and downstream's reconciler could drive it. But
it inverts a deep invariant — the ensure loop exists to guarantee every advertised
unit has an active keyset from boot (NUT-02 requires at least one active keyset;
NUT-04/05 advertise methods that would 500 without keys) — and interim
rotate-after-create fails for custom shapes (§6). **Acceptance as a standalone: low;**
realistic only inside #1984's larger redesign. Worth citing in the proposal as the
long-term direction that (a) does not conflict with: config seeds boot-time units,
RPC registers runtime units, both feed the same `configure_unit`/rotation machinery.

---

## 8. Verdict and recommendation

**Can it change?** Yes, trivially — the library API is already there (#1659), the
validation is being hardened (#2268), the mechanical delta is a config struct, one
`configure_unit` call site, and one field through the ensure loop. Zero protocol
impact: NUT-02 already specifies everything the config would set.

**Should it change?** Yes. The auto-default is a sat-mint convenience that becomes
actively hostile the moment a unit's economics differ (custom denominations, per-unit
fees) or its liabilities must expire: v2 keyset IDs commit to `final_expiry`, so a
compliant expiring genesis keyset **can only be created, never amended**, and stock
mintd's reconciliation loop actively reverts RPC-set custom shapes on every restart.
With #2253 making all future keysets inherit the first one's shape, the first keyset
is becoming the unit's de-facto template — it should be configurable.

**Concrete ask upstream:** propose (a) — `[keyset.<unit>]` with `amounts`,
`input_fee_ppk`, optional `lifetime_seconds`, implemented as: extend `UnitConfig` with
the expiry/lifetime, wire the section through mintd for all backends, deprecate
nothing (global `[info] input_fee_ppk` remains a fallback). Frame it as the config
companion to #2253 (template keyset for inheritance-based auto-rotation), citing
#1659's stated goal, nutshell's `max_order`/`mint_input_fee_ppk` precedent, and #1984
as the compatible long-term RPC path. If maintainers balk at config-surface growth,
fall back to (b), which still deletes the downstream's `crates/cdk` builder hunk.

**Adopt the rotate-after-create workaround now?** No — keep the patch until the
upstream conversation resolves. Rationale: (i) the workaround cannot cover custom
amounts/per-unit fees at all (builder reverts them every restart — the constraint is
not just "first keyset" but "config is the only stable authority the builder
respects"); (ii) even the expiry-only variant leaves one permanent junk keyset per
unit in every wallet's database plus an issuance window needing new gating code;
(iii) it would shrink the patch by only ~20 builder lines while other hunks keep the
`cdk` crate patched anyway. Present the workaround in the upstream issue as evidence
that the RPC path is insufficient, not as the downstream's plan.

---

## 9. Impact downstream

- The patch's `unit_keysets` blocks are rendered per non-retired unit
  (`dw:processor/src/config.rs:591-644`) into the mint.toml
  (`dw:processor/src/config.rs:690-744`) and into the external-mint snippet
  (`config.rs:649+`) — the external-mint mode means the config surface, not just the
  bundled container, is a product feature; an upstream `[keyset.<unit>]` section would
  let external operators run **unpatched stock mintd**.
- If upstream lands (a): the downstream renderer changes key names
  (`[grpc_processor.unit_keysets.X]` → `[keyset.X]`, `initial_final_expiry` →
  `lifetime_seconds`), and the config.rs/lib.rs/builder.rs hunks disappear from the
  patch. If only (b) lands: the builder hunk disappears; the mintd hunks shrink to the
  config struct + two calls.
- One latent edge in the current patch worth fixing regardless: a post-genesis
  config-triggered rotation (operator changes a unit's amounts/fee → builder detects
  mismatch on restart) creates the replacement with `final_expiry: None`
  (`is_initial_keyset` is false; patch lines 270-284), i.e., a non-expiring keyset in
  a lifecycle mint until the reconciler catches it — the same ≤68s window as the
  workaround. Upstreaming the "lifetime applies to any builder-created keyset"
  semantics from option (a) fixes this class; a downstream-only fix is to apply the
  configured expiry on *every* builder rotation for the unit, not just the first.
- The downstream reconciler (`dw:processor/src/main.rs:413-461`) and console rotation
  (`dw:processor/src/web.rs:1942-1993`) already run entirely on stock RPC and need no
  changes under any option.
