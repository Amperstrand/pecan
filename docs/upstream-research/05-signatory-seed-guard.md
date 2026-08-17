# 05 — Signatory seed guard: stock cdk starts with keysets it cannot re-derive

Research date: 2026-08-01.
Stock reference: pinned checkout `cashubtc/cdk` rev `6132607495ae0741e412a63f2acc34e4ccddfc55` (= tag work for v0.17.2, committed 2026-06-29), read at `~/.cargo/git/checkouts/cdk-57defa95db2b7762/6132607`. All `crates/...` paths below refer to that checkout unless marked "main".
Upstream main was additionally checked on 2026-08-01 (see "Upstream status today").

Facts below are **verified** against source unless explicitly marked *(inference)*.

---

## 1. The constraint

Stock `cdk-mintd` (and any embedder of `DbSignatory`) starts normally even when the
keysets stored in the mint database cannot be re-derived from the configured seed.
The signatory re-generates every stored keyset from the current seed at boot, computes
the fresh keyset id in the process, and never compares it to the stored id. With a
wrong seed + DB pairing the mint silently serves **new keys under the old keyset ids**.

The downstream patch (`patches/cdk-managed-units.patch`, hunk at lines 164–181)
inserts, inside `DbSignatory::reload_keys_from_db` immediately after
`let keyset = self.generate_keyset(&info);`:

```rust
if keyset.id != id {
    return Err(Error::Custom(format!(
        "stored keyset {id} cannot be derived from the configured recovery seed; \
         refusing to start with an inconsistent mint identity"
    )));
}
```

Downstream motivation: the appliance pairs a mint DB volume with a recovery mnemonic;
backup/restore and server-migration drills (docs/operations.md:30–63) make
"restore the wrong archive / keep the wrong mnemonic" a realistic operator mistake, and
operations.md:61–63 explicitly promises that "a mixed-up restore fails loudly rather
than forging keys". A config-side sibling guard already exists in the processor
(`processor/src/config.rs:124,387–398,553–556`: an immutable `seed_fingerprint =
sha256(mnemonic)[..16]` refuses to continue if the config's mnemonic changes), but only
the db_signatory guard binds the **mint database** to the seed.

---

## 2. Stock behavior trace

### 2.1 Startup chain

- `cdk-mintd` `build_mint` (`crates/cdk-mintd/src/lib.rs:1203–1240`):
  - if `info.signatory_url` is set → `SignatoryRpcClient` (remote gRPC signatory, lib.rs:1217);
  - else `info.seed` / `info.mnemonic` → `MintBuilder::build_with_seed` (lib.rs:1224–1236).
- `MintBuilder::build_with_seed` (`crates/cdk/src/mint/builder.rs:720–738`) constructs
  `DbSignatory::new(keystore, seed, supported_units, custom_paths)` and wraps it in the
  `embedded::Service` actor (`crates/cdk-signatory/src/embedded.rs:47–58`), then calls
  `build_with_signatory`.
- `DbSignatory::new` (`crates/cdk-signatory/src/db_signatory.rs:44–70`):
  1. `Xpriv::new_master(Network::Bitcoin, seed)` (line 51);
  2. `init_keysets(...)` (line 52);
  3. `reload_keys_from_db()` (line 67).

### 2.2 `init_keysets` — the check-shaped hole

`crates/cdk-signatory/src/common.rs:15–76`: for each configured unit it takes the
stored keyset with the highest `derivation_path_index`; if it is not expired and its
stored `input_fee_ppk` and `amounts` equal the configured ones, it re-activates it
(lines 46–68) and logs `"Current highest index keyset matches expect fee and amounts.
Setting active"` (line 49). Just before re-activating it runs:

```rust
// Validate we can generate it (sanity check)
let _ = MintKeySet::generate_from_xpriv(
    secp_ctx, xpriv,
    &highest_index_keyset.amounts, ..., highest_index_keyset.id.get_version(),
);
```
(common.rs:52–62)

This "(sanity check)" **generates the full keyset — including its id — and discards
it**. It can only ever catch panics; it compares nothing. The comparison the downstream
guard adds is precisely the comparison this code computes and throws away.

### 2.3 `reload_keys_from_db` — where the lie is constructed

`db_signatory.rs:79–98`:

```rust
for mut info in self.localstore.get_keyset_infos().await? {
    let id = info.id;                          // stored id
    let keyset = self.generate_keyset(&info);  // keys from CURRENT xpriv
    info.active = db_active_keysets.get(&info.unit) == Some(&info.id);
    ...
    keysets.insert(id, (info, keyset));        // map keyed by STORED id
}
```

`generate_keyset` (db_signatory.rs:100–111) calls `MintKeySet::generate_from_xpriv`
with the **current** xpriv and the **stored** `amounts`, `unit`, `derivation_path`,
`input_fee_ppk`, `final_expiry`, and the version byte of the stored id
(`info.id.get_version()`, line 109). The freshly generated `keyset.id` is computed
unconditionally inside `MintKeySet::generate` (nut02.rs:640–646) — and never read.

### 2.4 What the keyset id commits to (exact inputs)

`MintKeySet::generate` (`crates/cashu/src/nuts/nut02.rs:612–654`):

- per-amount secret key = `xpriv_at_derivation_path` child-derived at **hardened index
  `i` = the amount's position in the `amounts` array** (nut02.rs:622–629). So the key
  material is a function of `(seed, derivation_path, number-and-order of amounts)` —
  *not* of the amount values themselves.
- **v1 id** (`Version00`, `Id::v1_from_keys`, nut02.rs:237–259): first 14 hex chars of
  `sha256(concat(pubkeys sorted by amount))`. Commits to: seed, path, amount
  count/order. Does **not** commit to: amount *values* (two equal-length amount lists
  produce the same pubkeys → the same v1 id), `input_fee_ppk`, `final_expiry`, unit
  (unit enters only indirectly via the default derivation path).
- **v2 id** (`Version01`, `Id::v2_from_data`, nut02.rs:183–223): first 31 bytes of
  `sha256("amt:pubkeyhex,...|unit:U[|input_fee_ppk:F if F>0][|final_expiry:E if E>0]")`.
  Additionally commits to amount values, the unit's display string, fee, and expiry.
- Default derivation path: `m/129372'/hashed_unit'/index'` where `hashed_unit` is the
  first 4 BE bytes of `sha256(uppercase(unit))` with the top bit cleared
  (`common.rs:118–126`, `crates/cashu/src/nuts/nut00/mod.rs:~637–646`). Custom paths
  from `MintBuilder.custom_paths` are used at creation and **persisted in the keyset
  row** (`create_new_keyset`, common.rs:81–116, stores `derivation_path` in
  `MintKeySetInfo`); re-derivation always uses the stored path, never the live
  `custom_paths` map.

Consequences for the guard's discriminating power:
- A wrong seed changes every pubkey → both v1 and v2 ids change → **always caught**.
- Amount/fee changes never mutate an existing row — `rotate_keyset`
  (db_signatory.rs:190–247) creates a *new* row at `derivation_path_index + 1`;
  the only `UPDATE keyset` statements in the SQL layer toggle the `active` flag
  (`crates/cdk-sql-common/src/mint/keys.rs:117–122`). Old rows always re-derive.
- Residual blind spot *(inference from the id formulas)*: on a **v1** keyset, hand
  editing the stored amount *values* (same count), fee, or expiry would not trip the
  guard, since the v1 id doesn't commit to them. The guard is an identity check, not a
  full row-integrity check. For v2 keysets it does catch value/fee/expiry edits.

### 2.5 Runtime walkthrough with a mismatched seed (verified path)

Boot: nothing fails, nothing warns.
- `init_keysets` re-activates the stored keyset (fee+amounts still match the config)
  and logs the "Setting active" info line (common.rs:49).
- `build_with_signatory` (builder.rs:576–717) finds an active keyset whose stored
  fee/amounts match the config → `rotate = false` → no rotation, no signal
  (builder.rs:599–637).
- `Mint::new_internal` (`crates/cdk/src/mint/mod.rs:143–249`) caches the signatory's
  keysets in an `ArcSwap` (line 247). Piquant detail: the mint **persists its identity
  pubkey** — `MintInfo.pubkey` is set from the signatory xpub on first boot and kept
  thereafter "to ensure stable identity across restarts" (mod.rs:171–191). On a
  wrong-seed restart, stored `MintInfo.pubkey` (old xpub) and
  `SignatoryKeysets.pubkey` (new xpub) silently diverge; nothing compares them.

HTTP surface:
- `/v1/keysets` serves the **stored ids** (`crates/cdk/src/mint/keysets/mod.rs:43–59`).
- `/v1/keys` and `/v1/keys/{id}` serve **stored id + wrong-seed pubkeys**: the
  `SignatoryKeySet` conversion takes `id: info.id` but `keys: key.keys` from the
  freshly generated keyset (`crates/cdk-signatory/src/signatory.rs:142–156`). The mint
  now violates the NUT-02 invariant `id == derive_id(keys)` on every keys response.

Wallet-visible failure modes:
1. **NUT-02-verifying wallets** (including cdk's own): on keys fetch the wallet runs
   `keyset.verify_id()` (`crates/cdk/src/wallet/mint_metadata_cache.rs:676`;
   `nut02.rs:508–524`) → `Error::IncorrectKeysetId`, and the `?` fails the whole
   metadata load — the mint is unusable for them. The error is **client-side only**;
   the mint's logs show nothing.
2. **Old proofs (issued under the real seed) presented for swap/melt**:
   `Mint::verify_proofs` (mod.rs:1140) → `DbSignatory::verify_proofs`
   (db_signatory.rs:162–171). The map lookup by stored id **succeeds**, then
   `verify_message` (`crates/cashu/src/dhke.rs:173–192`) fails →
   `Error::TokenNotVerified` → NUT-00 error code 10001 to the wallet
   (`crates/cdk-common/src/error.rs:1037–1049,1251,1344`). **Every previously issued
   token is unredeemable** while the wrong seed is configured — surfaced only as
   per-request errors.
3. **New issuance**: `blind_sign` (db_signatory.rs:121–159) also looks up by the
   stored id → **signs with the wrong-seed private key** (lines 137–154). In the mint
   flow the invoice is paid *before* the sign step, so a wallet that then rejects the
   signature (DLEQ mismatch against previously cached original keys,
   `crates/cdk/src/wallet/blind_signature.rs:69`, or `IncorrectKeysetId` on fresh
   fetch) has **paid and received nothing it will accept**.
4. **Non-verifying wallets** accept the wrong-key signatures → ecash circulates under
   a forked identity. The moment the operator fixes the seed, that entire population
   of tokens becomes unredeemable — the mirror image of (2). No single seed can ever
   honor both populations.

Bonus hazard, stock: the **standalone signatory daemon auto-creates a fresh random
seed** ("Creating new seed") if its seed file is missing while its keyset DB survives
(`crates/cdk-signatory/src/bin/cli/mod.rs:~166–190`) — the exact wrong-pairing
scenario, reachable by losing one file.

**Verdict on severity**: this is not a nicety. The guard converts a silent mint-identity
fork — unredeemable back-liabilities plus paid-but-worthless new issuance — into a
startup failure. Fund-loss-grade at the edges: losses are permanent for tokens issued
during a wrong-seed window and for paid-quote/rejected-signature cases; back-liabilities
are recoverable only if the true seed still exists somewhere.

---

## 3. Legitimate cases where stored keysets don't re-derive

Enumerated honestly; each checked against source.

| Case | Re-derives with correct seed? | Notes |
|---|---|---|
| **Custom derivation paths** (`MintBuilder.custom_paths`) | Yes | Path is persisted per keyset row at creation (common.rs:103–115) and re-derivation uses `info.derivation_path` (db_signatory.rs:106). Changing `custom_paths` later doesn't affect old rows. **No false positive.** |
| **Rotated keysets (changed amounts/fee/expiry/version)** | Yes | Rotation writes a *new* row (db_signatory.rs:223–242); old rows are immutable except the `active` flag (keys.rs:117–122). Each row re-derives from its own stored parameters. **No false positive.** |
| **v1 vs v2 keysets mixed** | Yes | Regeneration uses the stored id's version byte (db_signatory.rs:109), so a v1 row re-derives a v1 id and a v2 row a v2 id. **No false positive.** |
| **Derivation-scheme history: default path change** (#1257, `046ea2b8`, 2026-02-25: `m/0'/unit'/index'` → `m/129372'/sha256(unit)'/index'`) | Yes | Only affects *newly created* keysets; old rows keep their stored `m/0'/...` path and re-derive under it. **No false positive.** |
| **Derivation-scheme history: `max_order` → `amounts`** (#1329, `24f9a508`, 2025-11-25, fixes #1074) | Yes, when loadable at all | Legacy NULL-`amounts` rows were read with an ascending powers-of-two fallback exactly matching the old `for i in 0..max_order` child-index scheme (pre-#1329 `sql_row_to_keyset_info`), and re-upserted with amounts on activation (old keys.rs upsert `amounts = excluded.amounts`). A never-re-upserted NULL row **already hard-fails stock startup today** with `Error::Database("amounts field is required")` (keys.rs:38–40; no backfill migration exists — checked `migrations/sqlite/20250903200000_add_signatory_amounts.sql` and `20251122000000_drop_max_order.sql`). The guard adds no new failure class here — and this is precedent that stock already refuses to start over unusable keyset rows. |
| **Custom-unit string normalization** (#1257 added NFC-trim in `CurrencyUnit::FromStr`, nut00/mod.rs:~649–667) | Almost always | *(inference)* A **v2** custom-unit keyset (creatable only after #1505, 2026-01-15) made before #1257 (2026-02-25) with a non-NFC or whitespace-padded unit string could round-trip through the DB to a different display string → different v2 id → guard trips despite the correct seed. Requires a pathological unit string in a ~6-week release window; no known real instance. The only theoretical same-seed false positive found. |
| **Imported / foreign keysets** | N/A | cdk has no import path: keyset rows are written only by `create_new_keyset` via `init_keysets`/`rotate_keyset`. Hand-edited or cross-implementation DBs are out of contract. |
| **Seed rotation** | Does not exist | No config knob, RPC, or documented procedure rotates a mint seed in cdk (checked `example.config.toml`, `cdk-mint-rpc` server — its keyset RPC only calls `rotate_keyset`, which creates keysets under the *same* seed). Today, changing the seed is precisely the silent-fork bug, not a feature. There is no legitimate workflow for the guard to break. |
| **Remote signatory (gRPC)** | Guard placement is correct | With `signatory_url`, the mint process runs `SignatoryRpcClient` and constructs **no** `DbSignatory` (lib.rs:1208–1223) — but the standalone signatory daemon itself constructs `DbSignatory` over *its* seed and keyset DB (bin/cli/mod.rs:191). A guard inside `DbSignatory` therefore runs in whichever process actually holds the seed, covering both deployments. What no guard can cover: swapping the mint to a *different but self-consistent* signatory (new seed + new DB) — the mint's own proof/quote DB would reference unknown keyset ids; that is a different (already-loud: `UnknownKeySet`) failure. |
| **Future: periodic reload across instances** (#2273, open) | Design note | If loads start happening mid-flight, a hard `Err` in the load path aborts a *reload*, not a start; the correct semantics there are "fail the reload, keep the previous snapshot, log an error". Worth one sentence in the upstream PR so the guard composes with that work. |

Net: **zero false positives in supported configurations**; one theoretical unicode edge
on early-2026 v2 custom-unit keysets.

---

## 4. Why is there no stock guard?

All evidence points to **inherited oversight**, not a deliberate trade-off:

1. **The check is computed and discarded twice.** `MintKeySet::generate` always
   computes the id (nut02.rs:640–646), so every boot already derives the very value the
   guard compares — in `reload_keys_from_db` for *every* stored keyset, and again in
   the `init_keysets` "(sanity check)" (common.rs:52–62) whose comment says "Validate
   we can generate it" while validating nothing. Startup cost was never the reason:
   the marginal cost of the guard is an equality test on bytes already in hand.
2. **No upstream discussion exists.** GitHub searches over `cashubtc/cdk` issues/PRs
   for "wrong seed", "different mnemonic", "different seed", "keyset id changed",
   restore/backup + keyset turned up nothing on this topic (searched 2026-08-01 via
   the GitHub API; Matrix/Discord history is not searchable from here — noted as a
   gap). Nobody has argued *for* tolerating mismatches; nobody has reported the
   failure either — consistent with a latent hazard whose victims see only confusing
   client-side errors.
3. **The reference implementation has the same gap.** Nutshell's
   `cashu/mint/keysets.py` `init_keysets` "load[s] all past keysets from db, the keys
   will be generated at instantiation" from the single configured seed, with no
   derived-vs-stored consistency check (verified against the method body on nutshell
   main, 2026-08-01; its only startup assertion is "No active keyset found."). cdk's
   design descends from the same founding assumption: *seed and DB always travel
   together*. That assumption predates operators doing volume-level backup/restore.
4. **File history shows the loop unchanged since birth.** `db_signatory.rs` was created
   in #509 (`ade48cd8`, 2025-05-28, author crodas) with the identical
   generate-and-insert loop; every later touch (#1032, #1505 `fac06105`, #1257
   `046ea2b8`, #1659 `99b0aee6`, #1686 `200b5bb3`, expiry enforcement `bbe7be09`,
   `d31acecc`) extended the generation *inputs*, never adding a comparison.
5. **Upstream already accepts hard boot failures around keysets** — `NoActiveKeyset`
   (mod.rs:153–158, relaxed to a warning only in #2270's embedded-mint case), and the
   "amounts field is required" load error above. And the brand-new ADR-0003 (see next
   section) states "Both deployment models prefer boot failure over running without
   keys" while listing "Out-of-band database mutations go undetected until restart" as
   an accepted negative consequence — language that *assumes* restart is the detection
   point, which for seed mismatch it currently is not.

---

## 5. Upstream status today (2026-08-01)

- `crates/cdk-signatory/src/db_signatory.rs` on main was **reworked days ago**: commit
  `783efcb2` (2026-07-27), merged via PR **#2270 "Signatory: serve keys from memory"**
  (author **crodas**, merged 2026-07-30,
  https://github.com/cashubtc/cdk/pull/2270), preceded by `899675fc` (2026-07-14,
  keyset watch subscriptions) and `f1736558` (2026-07-02, DLEQ borrow refactor).
- Structure on main now: `new` → `boot_load()` → `load_keys_from_db()` (renamed from
  `reload_keys_from_db`), plus `publish_snapshot` for watch subscribers; rotation
  updates memory directly and **no longer reloads from the DB**. Construction is
  strict: `signatory.boot_load().await?` — "a failed load fails construction".
- **The vulnerable loop survives verbatim** on main (fetched 2026-08-01): same
  `let id = info.id; let keyset = self.generate_keyset(&info); ... keysets.insert(id,
  (info, keyset))`, same `generate_keyset` body, and **no seed/keyset consistency
  validation anywhere in the file**.
- New ADR **docs/adr/0003-signatory-database-persistence-only.md** (merged with
  #2270): database is persistence-only, memory is source of truth, reads happen only
  at initialization, and — verbatim — "Both deployment models prefer boot failure over
  running without keys."
- In flight: PR **#2273 "Signatory: share keysets across instances via periodic
  reload"** (open, crodas, https://github.com/cashubtc/cdk/pull/2273, ADR-0004) makes
  the load path re-runnable (opt-in). Related: issue #2253 (auto-rotate on age).
- Consequence for the patch: it rebases trivially (function rename + one
  `publish_snapshot` line of context). Under main's structure the guard runs exactly
  once, at boot — even cleaner than on v0.17.2, where `rotate_keyset` also re-ran the
  reload (db_signatory.rs:244).

---

## 6. Options and recommendation

This is a pure safety patch — no downstream feature depends on its exact shape — so
the bar is "correct for every cdk operator".

**(a) Hard bail at load (the downstream patch).**
- Cost: zero derivation added (ids already computed); one comparison per stored keyset.
- False positives: none in supported configurations (§3); one pathological unicode edge.
- Operator recovery: restore the matching seed, or deliberately start a new mint
  identity with a fresh DB. Since upstream has **no seed-rotation story**, there is no
  legitimate flow this blocks; the guard *forces the only two coherent choices*.
- Philosophy fit: exactly ADR-0003's "prefer boot failure"; completes the intent of the
  discarded "(sanity check)".
- Acceptance likelihood: **high**. Small diff, testable, aligns with the maintainer's
  own week-old refactor. Improvement over the downstream hunk for upstreaming: a
  dedicated error variant (e.g. `Error::KeysetSeedMismatch { stored, derived }`)
  instead of `Error::Custom`, and include the *derived* id in the message for
  diagnosability.

**(b) Bail unless `--allow-keyset-mismatch`.**
- The escape hatch would let a mint keep serving keys that violate NUT-02
  (`id != derive_id(keys)`) — a protocol-invalid mint that compliant wallets reject
  anyway (wallet `verify_id`). Anyone consciously abandoning a seed should delete or
  deactivate the stale rows, not advertise forged ones. Adds config plumbing through
  `DbSignatory::new` for a flow nobody should use. Offer only if maintainers insist on
  an escape; default must be refuse.

**(c) Warn + mark mismatched keysets inactive / skip them.**
- The mint starts; the builder then sees no active keyset for the unit and rotates a
  new one **under the wrong seed** (builder.rs:633–653) — institutionalizing the fork
  while old proofs die with `UnknownKeySet`. Quiet identity forks are the precise
  failure the guard exists to prevent; a mint holds liabilities and should not guess.
  Also strictly more code (exclusion logic; to be honest it would need
  outstanding-liability checks against `keyset_amounts`). Rejected as primary; at most
  a documented fallback if upstream refuses any hard failure.

**(d) Verify lazily on first signature.**
- By the first sign, `/v1/keys` has already poisoned wallet caches with forged
  id→keys mappings, and `verify_proofs` would need the same check anyway. Detection
  after the mint has already lied on the wire. Worst option.

**Recommendation: (a)**, placed in `load_keys_from_db` (main's name) so it also
guards every future reload; if #2273 lands, a failed *reload* keeps the previous
snapshot (memory-is-source-of-truth makes that natural) — one sentence in the PR
description should call this out.

Suggested test matrix (all cheap, in-memory sqlite, mirroring the existing pattern at
db_signatory.rs:262–300):

1. **restore-mismatch**: build `DbSignatory` with seed A over a fresh store, rotate a
   keyset (v1 and v2 variants), drop it; rebuild over the same store with seed B →
   expect the mismatch error naming the keyset id.
2. **same-seed reopen** (regression): rebuild with seed A → `Ok`, ids unchanged.
3. **custom-path**: create with `custom_paths` for a unit, reopen with the same seed
   (with *and without* the `custom_paths` argument still supplied) → `Ok`, proving
   re-derivation uses the stored path.
4. **rotated-keyset**: rotate to different amounts + nonzero fee + expiry (v2), reopen →
   `Ok` — both old and new rows re-verify.
5. **mixed versions + auth keyset** present → `Ok`.

Optional follow-ups worth mentioning but not bundling: turn the `init_keysets`
"(sanity check)" into a real comparison or delete it; make the standalone signatory
daemon refuse to auto-generate a seed when its DB is non-empty (bin/cli/mod.rs);
compare stored `MintInfo.pubkey` against the signatory xpub in `Mint::new_internal`
as a second, mint-side belt.

---

## 7. Verdict

- **Can it change?** Yes. The insertion point survives on main nearly verbatim; the
  check costs nothing at runtime; it rebases across #2270 in minutes.
- **Should it change?** Yes, for everyone. A mint must never serve keys that do not
  hash to the keyset id it advertises — that is the NUT-02 invariant wallets rely on —
  and today a one-file mistake (wrong mnemonic, wrong volume, lost seed file) makes a
  stock mint do exactly that, signalling nothing. The failure it prevents is
  fund-loss-grade (§2.5); the legitimate-mismatch surface is empty (§3); the
  maintainers' own fresh ADR endorses boot failure over degraded operation (§5).
- **Concrete ask**: one small PR to `cashubtc/cdk` — the id comparison in
  `load_keys_from_db`, a dedicated error variant, the five tests above — framed around
  the restore/migration operator story and the NUT-02 invariant, referencing ADR-0003's
  strict-boot language, with a note on reload semantics for #2273. Given that crodas
  authored #509, #2270 and #2273, that is the natural reviewer.

## 8. Impact downstream

- Once upstream lands the check, the `db_signatory.rs` hunk of
  `patches/cdk-managed-units.patch` disappears; the downstream keeps its independent
  config-side `seed_fingerprint` guard (processor/src/config.rs) as the second layer
  (config↔mnemonic, vs. DB↔mnemonic).
- The operations.md:61–63 promise ("a mixed-up restore fails loudly rather than
  forging keys") becomes stock-backed instead of patch-backed — including for
  operators who later move to an external stock mintd (`MintConnection::External`,
  processor/src/config.rs:141–158), where the downstream patch does not travel today.
- Until then: when downstream bumps cdk past v0.17.2, the hunk must be rebased onto
  the #2270 shape (`reload_keys_from_db` → `load_keys_from_db`; guard before
  `publish_snapshot`). Semantics are otherwise unchanged.
