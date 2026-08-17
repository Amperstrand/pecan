# 03 — Mint info persistence: capabilities pinned to first boot

Research track 3 of 5 for the upstream-contribution decision. This is the constraint the
downstream cannot work around from outside cdk: **stock cdk-mintd, with the management RPC
enabled, persists the whole `MintInfo` blob in the database on the first boot and treats the
stored blob as authoritative on every later boot.** Config-driven capability changes
(add unit, retire unit, stop issuing, change limits) never reach the served `/v1/info`, and
the builder-side registration that would reflect them is append-only, so any attempt to make
the computed info authoritative again immediately duplicates every advertised (unit, method)
pair.

All stock citations are to the pinned checkout
`/Users/dariolass/.cargo/git/checkouts/cdk-57defa95db2b7762/6132607`
(rev `6132607495ae0741e412a63f2acc34e4ccddfc55` = tag **v0.17.2**, commit dated 2026-06-29,
verified with `git log -1`). Downstream citations are to
`/Users/dariolass/Developer/cashu/custom-unit-mint`. Facts are verified against source
unless explicitly marked *inference* or *judgment*.

---

## 1. The constraint, precisely

The downstream console applies **every** configuration change by regenerating `mint.toml`
and restarting cdk-mintd (`processor/src/config.rs:690-759` renders the file; the rendered
file always sets `[mint_management_rpc] enabled = true`, `config.rs:738-741`, because the
processor needs the RPC for `RotateNextKeyset` and `UpdateQuoteTtl`,
`processor/src/clients.rs:2-13,79-84`).

With the management RPC enabled, stock cdk-mintd:

1. restores the stored `MintInfo` into the `MintBuilder` before reading config
   (`crates/cdk-mintd/src/lib.rs:1712-1734` → `MintBuilder::init_from_db_if_present`,
   `crates/cdk/src/mint/builder.rs:157-178`);
2. lets every config-registered payment backend **append** its NUT-04/05 method entries to
   that restored info with no dedup (`builder.rs:440,453,468,479,495,506,536,547` — all
   `methods.push(...)`);
3. then discards the computed result and keeps serving the **boot-1 database blob**
   (`crates/cdk/src/mint/mod.rs:177-231`, trace in §2).

Consequences (all verified in §2):

- a unit **removed** from config stays advertised in `/v1/info` forever, with its keyset
  still served — it can never be unadvertised, by config or by RPC (§5);
- a unit **added** to config gets a keyset but is neither advertised nor usable
  (`check_mint_request_acceptable` rejects it against the stored blob) until the operator
  manually calls `UpdateNut04`/`UpdateNut05` over the RPC;
- limit/lifecycle changes in config are silently ignored;
- the moment anything makes the computed info authoritative again (the obvious fix, and
  what the downstream patch does in `crates/cdk/src/mint/mod.rs`), the append-only
  registration of step 2 persists **one duplicate set of (unit, method) entries per
  restart** — which is why the downstream patch must clear the restored methods before
  backends repopulate them.

The downstream patch (`patches/cdk-managed-units.patch`) counters this in three places:

- **(a)** `run_mintd_with_shutdown` hunk (patch lines 105-123): after
  `init_from_db_if_present`, clear `nut04.methods`/`nut05.methods` (setting
  `disabled = true` until a backend re-enables) and `nut17.supported`, so backends
  repopulate from a clean slate;
- **(b)** `mint/mod.rs` hunk (patch lines 287-314): in `Mint::new_internal`, overwrite the
  stored identity fields (name, descriptions, contact, icon_url, urls, motd, tos_url) and
  stored `nuts.nut04/nut05/nut17` with the computed ones and set `mutated = true`
  unconditionally — "runtime-managed fields must follow the current configuration";
- **(c)** `builder.rs` hunk (patch lines 214-264): do not advertise a NUT-04 (mint) or
  NUT-05 (melt) entry whose configured max is zero (redemption-only units), plus the
  `lib.rs` NUT-17 hunk (patch lines 84-104) advertising only
  `{method}_melt_quote` + `proof_state` for such units via `WsCommand::custom_melt_quote`.

---

## 2. Stock behavior trace (two-boot walkthrough)

Scenario: one custom unit `ora` served by the gRPC payment processor with custom method
`branch` (the downstream's actual method name, `processor/src/config.rs:289`), management
RPC enabled. Everything below is stock v0.17.2 behavior — no downstream patch.

### The storage primitive

`MintInfo` is serialized as one JSON blob under the KV key
`cdk_mint / config / mint_info` (`mod.rs:50-53`). There are exactly three writers at this
rev, all in `crates/cdk/src/mint/mod.rs`:

- `Mint::new_internal` first-boot seed (`mod.rs:219-230`, `None` branch);
- `Mint::new_internal` limited merge write (`mod.rs:206-217`, `Some` branch, only when
  `mutated`);
- `Mint::set_mint_info` (`mod.rs:551-564`) — called by `start_services_with_shutdown`
  (`cdk-mintd/src/lib.rs:1299,1313,1328`) and by every cdk-mint-rpc update handler.

The single reader that matters is `Mint::mint_info()` (`mod.rs:500-547`), which serves
`/v1/info` (`crates/cdk-axum/src/router_handlers.rs:172-187`) **and** gates quote creation
(`crates/cdk/src/mint/issue/mod.rs:142-183` for mint,
`crates/cdk/src/mint/melt/mod.rs:215-220` for melt).

### Boot 1 (empty database)

1. `run_mintd_with_shutdown` (`lib.rs:1698`) builds `MintBuilder::new(localstore)`. RPC is
   enabled, so `init_from_db_if_present` runs (`lib.rs:1712-1722`) — KV read returns
   `None`, builder keeps its defaults (`builder.rs:168-175`).
2. `configure_mint_builder` (`lib.rs:409-486`): `configure_basic_info` sets
   name/description/version (`lib.rs:489-558`); the `[[ln]]` grpcprocessor entry
   (`lib.rs:695-722`) → `configure_backend_for_unit` derives methods from the processor's
   settings — custom key `branch` (`lib.rs:906-926`) — →
   `configure_backend_for_methods` (`lib.rs:939-975`):
   - `add_payment_processor(ora, branch, limits, backend)` (`builder.rs:394-560`): the
     `PaymentMethod::Custom` arm **pushes**
     `MintMethodSettings { branch, ora, min: 1, max: 500000, options: Custom{} }` onto
     `nut04.methods` and sets `nut04.disabled = false` (`builder.rs:487-496`), pushes the
     matching `MeltMethodSettings` onto `nut05.methods` (`builder.rs:498-508`);
   - the NUT-17 loop (`lib.rs:959-968`) adds
     `{ branch, ora, [branch_mint_quote, branch_melt_quote, proof_state] }` via
     `with_supported_websockets`, which — unlike nut04/05 — has an exact-equality
     `contains` dedup (`builder.rs:276-286`).
3. `config_mint_info = mint_builder.current_mint_info()` (`lib.rs:1741`) — one entry per
   list.
4. `build_mint` → `build_with_signatory` (rotates in the `ora` keyset,
   `builder.rs:590-654`) → `Mint::new_internal` (`mod.rs:143-252`): KV read → `None` →
   **writes the computed info** (`mod.rs:219-230`). DB blob v1 = config-derived.
5. `start_services_with_shutdown` (`lib.rs:1242`): `rpc_enabled = true`;
   `mint.mint_info()` now succeeds (step 4 already seeded it — the
   "first boot with RPC: seed from config" branch at `lib.rs:1296-1300` is unreachable at
   this rev), so the `else` branch runs (`lib.rs:1301-1316`): seed QuoteTTL if absent,
   re-read the stored blob, stamp `version`, write back. Log line `lib.rs:1315`:
   `"Mint info already set, not using config file settings."`
6. `/v1/info` serves the DB blob: exactly one `(ora, branch)` entry in nut04, nut05,
   nut17. Correct.

### Boot 2 (any restart — same or changed config)

1. `init_from_db_if_present` **replaces** the builder's `MintInfo` with the stored blob
   (`builder.rs:170`): nut04/05/17 entries from boot 1, plus pubkey and version.
2. `configure_mint_builder` runs again over that state:
   - `configure_basic_info` overwrites scalar fields (name, motd, …) with config values in
     the *builder*; contacts are appended (`lib.rs:529-531` → `with_contact_info` pushes,
     `builder.rs:261-266`), so configured contacts duplicate in the builder state too;
   - `add_payment_processor(ora, branch, …)` **pushes a second identical
     `(ora, branch)` entry** onto `nut04.methods` and `nut05.methods` — there is no dedup
     at any layer for these lists;
   - nut17's `contains` check suppresses an *identical* re-add, but a changed entry (e.g.
     a different command set after a lifecycle change) is appended **next to** the stale
     stored one, and a stale entry for a removed unit is never dropped.
3. The builder's computed info now holds 2× `(ora, branch)`. It flows to two places and
   **dies in both**:
   - `Mint::new_internal` (`mod.rs:177-231`), `Some` branch: the *stored* blob is parsed
     and only mutated if `stored.pubkey` is missing (`mod.rs:188-191`), or stored
     `nut21`/`nut22` are missing while computed has them (`mod.rs:196-203`). **Stock never
     copies computed nut04/05/17 — or name, motd, anything else — into the stored blob.**
     The computed info is used only to configure the OIDC client (`mod.rs:239-244`).
   - `config_mint_info` → `start_services_with_shutdown(mint_builder_info)`
     (`lib.rs:1741,1753`): with RPC on, `mint_builder_info` is consumed only by the
     unreachable `is_err` branch (`lib.rs:1296-1300`). The reachable `else` branch reads
     the stored blob, refreshes `version`, writes the stored blob back
     (`lib.rs:1311-1313`).
4. Served `/v1/info` = **boot-1 capabilities, forever** (modulo RPC edits and the version
   stamp).

### What this means for each lifecycle operation (stock, RPC on)

| Config change | Keyset layer (follows config) | Advertised info (pinned) | Operational result |
|---|---|---|---|
| Add unit `usd` | keyset rotated in, keys served | **absent** from nut04/05/17 | mint/melt quotes rejected — `check_mint_request_acceptable` calls `get_settings(&unit,&method)` on the **stored** blob and returns `Error::UnsupportedUnit` (`issue/mod.rs:159-161`; melt `melt/mod.rs:219-221`). Operator must hand-run `UpdateNut04` + `UpdateNut05` RPCs to make the unit exist. |
| Retire unit `ora` | keyset stays in DB, keys still served | **still advertised** in nut04/05/17 | quote requests pass the nut04/05 settings check, then fail at `get_payment_processor` → `Error::UnsupportedUnit` (`mod.rs:470-478`). Wallets see a fully-advertised capability that always errors. No RPC can remove it (§5). |
| Change limits / stop issuing | n/a | old min/max advertised | stored limits keep being enforced (`issue/mod.rs:163-180`). |
| Remove **all** `[[ln]]` entries | — | still advertised | the "at least one backend" guard (`lib.rs:475-483`) checks the *builder* info, which was pre-seeded from the DB — so mintd boots with **zero payment processors while advertising boot-1 capabilities**. (Downstream sidesteps this with its standby supervisor.) |

### Where the duplication actually bites — an honesty note

At this exact rev, **pure stock pins; it does not yet serve duplicates**, because the two
writes that could persist the doubled builder state are unreachable (trace above). The
duplication is a loaded gun in the computed state: it fires the moment computed info is
made authoritative, which is

- exactly what the downstream's `mint/mod.rs` hunk (b) does — hence its paired `lib.rs`
  hunk (a) that clears the restored lists first (the patch comment
  "otherwise every managed restart duplicates NUT-04/05/17 pairs" describes the pipeline
  with (b) but without (a)); both hunks shipped together from the patch's first commit
  (downstream `fb54041`, "Add managed multi-unit lifecycle migrations");
- exactly what any naive upstream fix of the pinning would do (restore the pre-#1081
  "config wins" write while keeping `init_from_db_if_present` → duplicates on every
  restart);
- and what upstream's own in-flight redesign explicitly guards against by *skipping* the
  DB pre-load on its apply path (§4, PR #2242).

When talking to upstream, the accurate claim is: *"the stored blob is pinned, and the
registration path is non-idempotent; the two defects are coupled — you cannot fix the
first without hitting the second."* Overclaiming "stock duplicates on every restart
today" would be checkable and wrong.

Related same-pattern appends that any fix should cover: NUT-15 MPP methods
(`builder.rs:425-427`, bolt11-with-mpp only) and `contact` (`builder.rs:261-266`).

---

## 3. Why it exists: the RPC-edit persistence story

### The history (verified from git in the pinned checkout + GitHub)

- **Before 2025-09-20**: `Mint::new_internal` unconditionally wrote the config-derived
  info on every boot (`tx.set_mint_info(mint_info.clone())` — visible in the parent of
  `aeafab9a`), and mint info lived in a dedicated SQL config table. Config was the source
  of truth; **RPC edits were clobbered by every restart.**
- **Issue #1080** (filed 2025-09-16 by `orangeshyguy21`,
  <https://github.com/cashubtc/cdk/issues/1080>): "Mint Bug: nut4, nut5, and quote ttl
  settings overridden on mint start — If any of the minting, melting, or quote ttl
  settings are changed via the RPC they do not persist between startups… Values are
  overwritten in the database config table on boot." Follow-up comment: "Looks to be
  happening with mint info as well."
- **PR #1081** (`thesimplekid`, merged 2025-09-20, "fix: config overwrite on start up",
  body: "fixes #1080", commit `aeafab9a` in the pinned checkout,
  <https://github.com/cashubtc/cdk/pull/1081>): introduced everything this report is
  about — `init_from_db_if_present` + `current_mint_info` (builder), the KV blob and the
  `Some/None` + `mutated` merge in `new_internal`, the RPC-gated builder pre-load in
  `run_mintd_with_shutdown`, the `config_mint_info` plumbing, the `quote_ttl` seeding
  rules, and the config-table → KV migration
  (`20250916221000_drop_config_table.sql`). Verified with
  `git log -S init_from_db_if_present` (single hit) and `git show aeafab9a`.
- **Issue #801** (<https://github.com/cashubtc/cdk/issues/801>): "Mint info is not updated
  when version is updated if management grpc is enabled… mint_version… will be stuck on
  the version where the rpc was enabled." This earlier symptom of the same pinning was
  special-cased: the boot-time `version` refresh (`lib.rs:1306-1313`). **Precedent:**
  upstream already accepts that some fields are runtime-derived and must be re-stamped
  over the stored blob on every boot. The downstream's hunk (b) generalizes exactly that
  precedent from `version` to the capability blocks.

So the pendulum swung from *config-wins* (clobbers RPC edits, #1080) to *DB-wins* (pins
config, the present constraint) with no field-level ownership in between.

### What the RPC actually owns

The full management surface (`crates/cdk-mint-rpc/src/proto/cdk-mint-rpc.proto:5-23`):

| RPC | Fields written | Handler |
|---|---|---|
| `UpdateMotd` | `motd` | `server.rs:257-275` |
| `UpdateShortDescription` / `UpdateLongDescription` | `description` / `description_long` | `server.rs:278-317` |
| `UpdateName` | `name` | `server.rs:320-338` |
| `UpdateIconUrl` / `UpdateTosUrl` | `icon_url` / `tos_url` | `server.rs:341-382` |
| `AddUrl` / `RemoveUrl` | `urls` (push / retain) | `server.rs:385-432` |
| `AddContact` / `RemoveContact` | `contact` (push / retain) | `server.rs:435-482` |
| `UpdateNut04` | one `(unit, method)` entry's `min_amount`, `max_amount`, `options`; plus **whole-NUT** `nut04.disabled` | `server.rs:485-554` |
| `UpdateNut05` | same for nut05 | `server.rs:557-624` |
| `UpdateQuoteTtl` / `GetQuoteTtl` | separate `quote_ttl` KV key | `server.rs:627-…` |
| `UpdateNut04Quote`, `RotateNextKeyset` | quote state / keysets — not mint info | — |

**No RPC touches** `nut17`, `nut15`, `nut19`, `nut21/22`, `pubkey`, or `version`. Yet the
persistence unit is the *entire* blob: the DB is the source of truth for the
RPC-editable operator fields **and**, by side effect, for the backend-derived capability
blocks that no RPC can fully manage. That conflation — one blob, two owners — is the root
cause. *(Inference as to intent: #1081 restored the whole blob rather than per-field
ownership because it was the minimal fix for #1080; nothing in the PR discusses capability
lifecycle.)*

---

## 4. Upstream status today

### Not fixed anywhere released

- **v0.17.3** (latest tag): the GitHub compare `v0.17.2...v0.17.3` (13 commits) touches
  none of `cdk/src/mint/{mod,builder}.rs`, `cdk-mintd/src/lib.rs`,
  `cdk-mint-rpc/src/proto/server.rs`. Identical behavior.
- **main @ `77256eb0`** (2026-07-30, fetched 2026-08-01): the `new_internal` merge is
  byte-identical (pubkey/nut21/nut22 only; main `mint/mod.rs:314-346`);
  `init_from_db_if_present` unchanged (main `builder.rs:157`); `add_payment_processor`
  still pushes without dedup (only diff: a new `method_name` field on the settings
  structs); `run_mintd_with_shutdown`/`start_services_with_shutdown` flow unchanged (main
  `lib.rs:1645-1678, 2069, 2091`); `update_nut04`/`update_nut05` unchanged upsert
  (main `rpc_server.rs:525-663`).
- **No upstream issue found** describing the duplication or the retire/unadvertise gap.
  Searches over `cashubtc/cdk` issues/PRs: "mint info", "duplicate", "config restart",
  "stale", "advertised", "source of truth", "nut04 methods". Closest hits are the
  ancestry above (#1080, #801). So this is **not a known bug upstream** — the
  conversation would introduce it.

### But upstream is actively redesigning exactly this: PR #2242

**PR #2242 "move mintd config to db"** (<https://github.com/cashubtc/cdk/pull/2242>,
open, author `asmogo`, opened 2026-07-21, 25 commits, head `3a44ab18`, under active
review by `crodas`, `thesimplekid`, `orangeshyguy21`; targets **v0.18** per its
`docs/migrations/v0.18.md`). Key verified properties (fetched from the PR head):

- The authoritative configuration document moves into the mint database; "A normal daemon
  start no longer reads `config.toml`". Changes flow through
  `cdk-mintd config validate/init/apply/rollback` + restart.
- Migration doc: "The first successful start applies the imported mint metadata and quote
  TTL and marks the document applied. **Later starts preserve RPC-managed canonical
  values when management RPC is enabled.**" and "Edit an import document, then explicitly
  stage it: … `config apply` … Restart the daemon to activate the replacement. Do not
  make management RPC changes between `config apply` and that restart."
- Implementation: `reconcile_canonical_configuration(mint, builder_info, ttl, preserve)`
  with `preserve = rpc_enabled && !force_configuration` (PR head `lib.rs:1711-1751,
  1820-1826`). When a newly staged document activates (`force_configuration = true`), the
  builder **skips `init_from_db_if_present`** (PR head `lib.rs:2262-2264`) and
  `preserve = false` **overwrites the entire stored blob from the document-derived
  builder info** — capabilities follow config, removed units disappear, and no duplicates
  arise because the pre-load was skipped. Ordinary restarts keep today's preserve
  behavior. An RPC "mutation guard" blocks RPC writes between apply and restart.

**Reading:** upstream has, without naming this bug, already converged on the same stance
as the downstream patch — *config authoritative for everything at explicit apply
boundaries, DB authoritative for RPC edits in between* — and independently discovered
that the fix requires suppressing the DB pre-load to avoid re-appending (their
`force_configuration` skip is the structural twin of downstream hunk (a)). This
determines the ask's framing: for **main/v0.18** the design conversation is already
happening in #2242 (engage there); for **0.17.x** (what the downstream ships against) a
narrow bug-fix is the right vehicle. What #2242 does **not** contain: zero-limit
advertisement gating, NUT-17 command subsets, per-pair RPC removal, or any dedup guard on
its *preserve* path (a boot that pre-loads and re-registers still computes duplicated
builder state; it just never persists it — same latency as stock).

---

## 5. RPC semantics: retirement is impossible via RPC (definitive)

`update_nut04` (`server.rs:485-554`), identically `update_nut05` (`server.rs:557-624`):

1. Parses `unit` and `method` from strings (proto `UpdateNut04Request`:
   `{unit, method, disabled?, min_amount?, max_amount?, options?}`, proto lines 86-93).
2. **Requires a live registered payment processor** for the pair:
   `get_payment_processor(unit, method)` or `invalid_argument("Unit payment method pair
   is not supported")` (`server.rs:505-507`).
3. `remove_settings(&unit, &method)` pops the existing entry — **first match only**
   (`cashu/src/nuts/nut04.rs:319-328`) — then `methods.push(updated)` with
   omitted request fields inherited from the removed entry (`server.rs:509-540`).
   Net effect: **upsert of one entry, keyed by (unit, method).** It can never leave the
   list smaller.
4. `disabled` (if present) sets `Settings.disabled` — the **whole-NUT flag**
   (`server.rs:542-544`; struct at `nut04.rs:290-295`). There is no per-entry disabled
   field anywhere in the type or the spec (§6).

Therefore:

- **Retired unit** (removed from config): step 2 fails — the processor map no longer
  contains the pair — so the stale entry cannot even be *edited*, let alone removed.
- **Still-configured unit**: no removal verb exists in the service (the only `Remove*`
  RPCs are `RemoveUrl`/`RemoveContact`, proto lines 13-16). The strongest degradation is
  clamping `min/max` (e.g. 0/0) — the pair **stays advertised**, and amount-less requests
  still pass because limits are enforced only `if let Some(amount)`
  (`issue/mod.rs:167-180`). Setting `disabled = true` kills minting for **all** units.
- **Duplicates are un-repairable by RPC**: with N duplicate entries, one `UpdateNut04`
  removes one and pushes one — N-1 stale copies remain, and reads resolve to the *first*
  match (`get_settings`, `nut04.rs:304-316`), i.e. the stale one.

Conclusion (verified, not inference): **unadvertising a (unit, method) pair is impossible
via the management RPC at v0.17.2 and at current main.** The only stock path that ever
removes entries is… nothing. No code path shrinks `nut04.methods`/`nut05.methods`/
`nut17.supported` once persisted.

Side observation for the upstream conversation: the handlers rebuild `options` as
`MintMethodOptions::Bolt11 { description }` whenever the request carries options, even
for custom methods (`server.rs:514-517`) — more evidence this surface was built for the
single-bolt11-mint case, not multi-unit lifecycle management.

---

## 6. Spec analysis: NUT-04 / NUT-05 / NUT-17

Source: <https://github.com/cashubtc/nuts> (`04.md`, `05.md`, `17.md`, `main` as of
2026-08-01).

### NUT-04 / NUT-05 — membership means support; limits have no "0 = off" meaning

- NUT-04 §Settings: "**The settings for this NUT indicate the supported method-unit pairs
  for minting.**" and "`MintMethodSetting` indicates supported `method` and `unit` pairs
  and additional settings of the mint. **`disabled` indicates whether minting is
  disabled.**" (04.md lines 156, 170). NUT-05 mirrors this: settings indicate "the
  supported method-unit pairs for melting"; "`disabled` indicates whether melting is
  disabled."
- "`min_amount` and `max_amount` indicate the minimum and maximum amount for an operation
  of this method-unit pair." (04.md line 185). Both are `<int|null>`.
- The specs are **silent** on zero values and on advertising-vs-omitting. There is **no
  per-entry disabled flag** in either spec; `disabled` sits next to `methods` at the
  settings level (04.md line 165), i.e. it is NUT-global — matching the cdk struct.

Verdict on the patch's zero-limit gating: "max_amount = 0 means do not offer" is
**undefined by spec**, not spec-legal-with-meaning. A limits-honoring wallet would treat
`[min 0, max 0]` as "only amount 0"; a non-checking wallet would request quotes and get
errors. Since the methods array is *defined* as the list of supported pairs, **omission
is the only spec-shaped way to express "this pair cannot mint"** — a mint that lists a
pair it will never serve is arguably violating the spec's plain meaning. The patch's
approach (config uses 0 as a sentinel, `processor/src/config.rs:601-618`; the builder
gate consumes the sentinel and omits the entry, never advertising the zeros) is the
conservative, spec-aligned reading. *Judgment:* upstream should prefer omission over a
disabled-flag variant too, because a per-entry disabled flag would require a **nuts spec
change** first, while omission needs none. If upstream wants belt-and-braces, proposing a
per-entry `disabled` to cashubtc/nuts is a separate, slower conversation.

### NUT-17 — command subsets are first-class

17.md defines `supported: [{method, unit, commands: <str[]>}]` with five commands
(`bolt11_mint_quote`, `bolt11_melt_quote`, `bolt12_mint_quote`, `bolt12_melt_quote`,
`proof_state`), and its own example advertises a **subset** (bolt11/sat with only three
commands). No MUST/SHOULD constrains which commands a pair lists. The downstream's
melt-only advertisement (`{method}_melt_quote` + `proof_state`) is therefore fully
conformant, and the helper it uses already exists upstream
(`WsCommand::custom_melt_quote`, `cashu/src/nuts/nut17/mod.rs:106-116`) — the change is
literally a different constructor call in cdk-mintd (`lib.rs:962-966` today defaults every
custom pair to the full set via `SupportedMethods::default_custom`).

---

## 7. Options for the upstream proposal

### (a) nut04/05/17 (+nut15) always recomputed from config; identity fields stay stored
*(the downstream patch's stance, minus its identity-field overwrite)*

- **Who breaks:** operators who set `min/max/options` via `UpdateNut04`/`UpdateNut05` and
  expect them to survive restarts — the exact population #1080 was fixed for. Their edits
  would become restart-transient. The downstream accepts this (its console owns limits via
  config, and it restarts only through the console), but upstream cannot regress its own
  fix from ten months ago. The downstream patch goes further and re-derives the
  RPC-editable identity fields too (name, motd, urls, contact, …) — that breaks the whole
  `cdk-mint-cli` value proposition and has ~zero acceptance upstream.
- **Migration:** none (blob shape unchanged); behavior change needs a loud changelog.
- **Code size:** small (~30 lines: skip/clear pre-load + overwrite-on-merge).
- **Acceptance:** *low as stated* — it re-opens #1080 for limits. *(judgment)*

### (b) membership-follows-config merge: upsert-if-absent + prune-unregistered + dedup
*(the surgical variant — recommended)*

In `Mint::new_internal`'s `Some` branch (or a builder helper called before build): after
computing which `(unit, method)` pairs the configured processors registered this boot,

1. **dedup** stored `nut04.methods`/`nut05.methods` by `(unit, method)` (first wins —
   matches `get_settings` resolution);
2. **add** entries present in computed but missing in stored (new units become usable and
   advertised);
3. **prune** stored entries whose `(unit, method)` has no registered processor (retired
   units disappear — the mint stops advertising what it structurally cannot serve; note
   quote creation already fails for them at `get_payment_processor`, so no working flow
   can break);
4. same membership rule for `nut17.supported` and `nut15.methods`;
5. **keep stored values** (`min_amount`, `max_amount`, `options`, NUT-level `disabled`)
   for surviving pairs — RPC edits still win for everything the RPC can edit.

- **Who breaks:** nobody's supported workflow. RPC min/max edits persist (no #1080
  regression). The only observable change is that the advertised membership finally
  tracks the processor map — which is also what quote validation *enforces*
  (`get_payment_processor` is the hard gate), so the change makes `/v1/info` truthful
  rather than different. Edge case: an operator who deliberately kept a backend removed
  from config while wanting it advertised — no such workflow can function today (all its
  quotes error), so nothing real breaks. *(judgment)*
- **Migration:** none; existing pinned/duplicated blobs self-heal on first boot.
- **Code size:** ~40-60 lines + tests, entirely in `cdk` (mod.rs merge) or shared with a
  small builder change; also makes `init_from_db_if_present` + re-registration idempotent,
  which #2242's preserve path silently needs too.
- **Acceptance:** *high* — it is a strictly-truthfulness fix, aligned with the #801
  version-refresh precedent and with #2242's direction. *(judgment)*

### (c) Add/Remove per-pair RPCs + idempotent registration

`RemoveNut04Method{unit, method}` (bypassing the live-processor check) and making
`add_payment_processor` upsert instead of push. Gives console-style operators full
lifecycle control without restarts.

- **Who breaks:** nobody; additive proto change (new RPCs), plus the same dedup needed
  anyway.
- **Cost:** proto + server + `cdk-mint-cli` + FFI surface; and it still does not fix the
  restart pinning for config-driven mints on its own (an entry added by config on boot 2
  still never appears without (b)). Complement, not core.
- **Acceptance:** *medium* — more API to maintain; upstream may prefer #2242's
  config-apply as the lifecycle mechanism instead. *(judgment)*

### (d) Namespace the stored blob (config-owned vs rpc-owned fields)

The architecturally "right" split. **#2242 already is this**, at document granularity
(config document owns everything at apply time; RPC canon owns between applies).
Proposing a competing field-ownership scheme now would collide with an active,
maintainer-reviewed PR. The useful move is reviewing #2242, not duplicating it.

---

## 8. Verdict and recommended asks

**Can it change?** Yes. The merge point is small, well-localized
(`Mint::new_internal`), and upstream's own v0.18 work is already abandoning
whole-blob-pinning at apply boundaries. Nothing in wallets depends on stale
advertisement; quote validation already enforces the processor map.

**Should it change?** Yes, also for stock users: today, any RPC-enabled mint that edits
`[[ln]]` config (adds a backend, switches bolt11→bolt12, changes units) silently serves
wrong capabilities and rejects valid new-unit quotes — a footgun independent of the
downstream's exotic use case.

**Recommended concrete asks — three pieces, split as follows:**

1. **Bug report + fix PR (piece 1, standalone, against main, backportable to 0.17.x):**
   "Advertised NUT-04/05/15/17 membership is pinned to the first RPC-enabled boot; DB
   pre-load + append-only registration also makes the computed info non-idempotent."
   Report the concrete symptoms (added unit unusable, retired unit unremovable — §2
   table), cite #801 as precedent and #1080 as the constraint to preserve, and implement
   option (b): membership from config, values from DB-else-config, dedup on merge. Do
   **not** propose touching identity fields. This is the piece the downstream cannot work
   around and should lead with.
2. **Redemption-only advertisement PR (pieces 2+3 together, separate PR):** builder skips
   NUT-04/NUT-05 entries whose configured max is 0 (`builder.rs` gating) **and** cdk-mintd
   advertises the NUT-17 `{method}_melt_quote` + `proof_state` subset for such pairs.
   Bundle these two because they share one motivation ("a unit you can redeem but not
   buy") and one spec argument (§6: methods arrays are *supported*-pair lists; NUT-17
   subsets are exemplified by the spec itself). Keep them out of PR 1 — different review
   axis (advertisement policy vs persistence correctness), and PR 1 must not carry
   anything debatable. Optionally, open a small cashubtc/nuts issue asking whether
   `max_amount = 0` should be defined, to surface wallet-author opinions — but do not
   block the cdk PR on it.
3. **Engage on PR #2242 now** (review comment, not a new PR): confirm the apply path is
   the sanctioned mechanism for capability removal, point out that the *preserve* path
   still computes duplicated builder state (harmless today, latent regression tomorrow)
   and would be hardened by PR 1's dedup, and flag the downstream's integration mode
   (external config generator + restart) as a consumer of `config apply`. This buys
   goodwill and ensures the v0.18 world keeps a programmatic apply path the console can
   drive.

---

## 9. Impact downstream

- **If piece 1 lands:** downstream hunks (a) and (b) shrink to at most the
  identity-field overwrite — and that overwrite is a downstream *policy* (console owns
  name/description via config), replaceable by having the processor issue
  `UpdateName`/`UpdateShortDescription`/`UpdateLongDescription` RPCs at boot, i.e. the
  patch pieces for this constraint can disappear entirely.
- **If piece 2 lands:** the `builder.rs` zero-limit hunk and the NUT-17 `WsCommand` hunk
  disappear. The downstream's `min_mint = 0 / max_mint = 0` rendering
  (`processor/src/config.rs:601-618`) becomes plain upstream configuration.
- **Until then:** the patch is load-bearing and correct, with one caveat to keep in mind:
  because hunk (b) re-derives identity fields every boot, any operator RPC edits to
  name/motd/urls/contact/icon/tos are reverted on the next console-driven restart
  (fields absent from `mint.toml` revert to `None`). That is intended downstream
  behavior, but it is the part upstream will not take as-is.
- **v0.18 / #2242 watch item:** when the downstream tracks a cdk ≥ 0.18, "regenerate
  mint.toml + restart" must become "regenerate document + `config apply` + restart"
  (config.toml is no longer read at boot). Capabilities will then follow config by
  design, and the console's consistency view (`capabilities_from_info`,
  `processor/src/web.rs:867-902` — which already dedups pairs via a `BTreeMap`, so the
  console UI is robust even against duplicated advertisements that external wallets
  would not be) keeps working unchanged.

---

## Appendix: primary evidence index

| Claim | Evidence |
|---|---|
| Blob restored into builder pre-config | `cdk-mintd/src/lib.rs:1712-1734`; `cdk/src/mint/builder.rs:157-178` |
| Append-only nut04/05 registration | `builder.rs:440,453,468,479,495,506,536,547` |
| nut17 exact-equality dedup only | `builder.rs:276-286` |
| Stored-vs-computed merge (pubkey/nut21/nut22 only) | `cdk/src/mint/mod.rs:185-217` |
| First-boot seed write | `mod.rs:219-230` |
| Served info = DB blob | `mod.rs:500-547`; `cdk-axum/src/router_handlers.rs:172-187` |
| Quote validation reads stored blob | `issue/mod.rs:142-183`; `melt/mod.rs:215-220`; processor gate `mod.rs:470-478` |
| Unreachable seed-from-config branch | `lib.rs:1296-1300` (dead because `mod.rs:219-230` always seeds first) |
| Version-refresh special case | `lib.rs:1301-1316`; motivated by issue #801 |
| RPC upsert-only, live-processor-gated, whole-NUT disabled | `cdk-mint-rpc/src/proto/server.rs:485-554,557-624`; proto lines 5-23, 86-108; `cashu/src/nuts/nut04.rs:290-339` |
| Origin: #1080 → PR #1081 (`aeafab9a`, 2025-09-20) | `git log -S`, `git show aeafab9a`; github.com/cashubtc/cdk/{issues/1080, pull/1081} |
| Unchanged at v0.17.3 and main `77256eb0` (2026-07-30) | GitHub compare v0.17.2...v0.17.3; fetched main files (diffs in scratchpad) |
| PR #2242 direction + force_configuration skip | github.com/cashubtc/cdk/pull/2242, head `3a44ab18`: `docs/migrations/v0.18.md`; `lib.rs:1711-1751,1820-1826,2262-2264` (PR head) |
| NUT-04/05/17 wording | cashubtc/nuts `04.md` lines 156,165,170,179,185; `05.md` settings section; `17.md` supported array + subset example |
| Downstream patch hunks | `patches/cdk-managed-units.patch` lines 84-123 (nut17 subset + clear-before-repopulate), 214-264 (zero-limit gating), 287-314 (stored-follow-computed) |
| Downstream renderers/consumers | `processor/src/config.rs:591-644,690-759`; `processor/src/web.rs:619-645,867-902`; `processor/src/clients.rs:2-13,79-84` |
