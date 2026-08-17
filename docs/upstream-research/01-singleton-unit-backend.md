# Upstream research 01 — The singleton-unit backend handshake in cdk-mintd

Status: research complete, 2026-07-31.
Question: can/should stock cdk-mintd stop requiring that each `[[ln]]` entry's unit equal the single `unit` string a payment backend reports in `get_settings`, so one gRPC payment processor can serve several currency units?

Sources and conventions:

- **Pinned checkout** = `/Users/dariolass/.cargo/git/checkouts/cdk-57defa95db2b7762/6132607`, verified pristine (`git status` clean except the untracked `.cargo-ok`; `git diff HEAD` empty), HEAD `6132607495ae0741e412a63f2acc34e4ccddfc55` = tag v0.17.2 ("chore: bump v0.17.2"). The rev is confirmed to exist in upstream `github.com/cashubtc/cdk` (verified via `gh api repos/cashubtc/cdk/commits/6132607...`). All `file:line` cites without a prefix are paths under this checkout.
- **main** = raw files fetched 2026-07-31 from `raw.githubusercontent.com/cashubtc/cdk/main/...` at main HEAD `77256eb0` (2026-07-30). Cites marked "(main)" use line numbers of that snapshot.
- **Downstream** = `/Users/dariolass/Developer/cashu/pecan` (patch `patches/cdk-managed-units.patch`, processor crate `processor/`).
- Claims are verified facts unless explicitly marked **Inference**.

---

## 1. The constraint

`cdk-mintd` registers payment backends per `[[ln]]` config entry. For every entry it calls the backend's `get_settings()` and hard-fails startup unless the entry's configured `unit` equals the backend's single reported `unit` string (with `sat`/`msat` treated as interchangeable):

- `crates/cdk-mintd/src/lib.rs:904` — `validate_backend_unit(&unit, &payment_settings.unit)?;`

The gRPC settings message can only name one unit (`SettingsResponse.unit`, proto field 1). A processor that serves several units therefore cannot satisfy more than one `[[ln]]` entry: with multiple `grpcprocessor` entries pointing at one endpoint, all but (at most) one mismatch and mintd refuses to boot. The downstream patch (`patches/cdk-managed-units.patch`, hunk adding `configure_backend_for_managed_unit`) removes exactly this boot-time comparison for the gRPC-processor arm and nothing else; requests remain unit-checked by the processor per call.

## 2. Stock behavior trace (pinned v0.17.2)

### 2.1 The handshake chain

1. `configure_mint_builder` (`crates/cdk-mintd/src/lib.rs:409`) calls `configure_lightning_backend` at `lib.rs:446-453` and `configure_onchain_backend` at `lib.rs:456-457`. Any `Err` propagates out and aborts mintd startup.
2. `configure_lightning_backend` iterates `settings.ln` in config order (`lib.rs:575`). The gRPC arm (`lib.rs:694-722`) clones the **single** `[grpc_processor]` section (`lib.rs:696`), calls `grpc_processor.setup(...)` (`lib.rs:708-710`), then `configure_backend_for_unit(settings, mint_builder, ln_entry.unit.clone(), ...)` (`lib.rs:714-721`).
3. `GrpcProcessor::setup` (`crates/cdk-mintd/src/setup.rs:315-333`) **ignores its `_unit` parameter** and constructs a fresh `PaymentProcessorClient::new(&self.addr, self.port, self.tls_dir.clone())` per call (`setup.rs:324-329`). Two `[[ln]]` grpcprocessor entries therefore create two independent gRPC clients/channels to the same address.
4. `configure_backend_for_unit` (`lib.rs:896-937`): calls `backend.get_settings().await?` (`lib.rs:903`), then the guard (`lib.rs:904`), then derives the method list from the settings (`bolt11`/`bolt12`/`onchain`/`custom` keys, `lib.rs:906-926`) and hands off to `configure_backend_for_methods` (`lib.rs:939-975`).

### 2.2 The validation functions

`crates/cdk-mintd/src/lib.rs:977-1005`:

```rust
fn validate_backend_unit(configured_unit: &cdk::nuts::CurrencyUnit, backend_unit: &str) -> Result<()> {
    let backend_unit = cdk::nuts::CurrencyUnit::from_str(backend_unit)
        .with_context(|| format!("Payment backend returned invalid unit `{backend_unit}`"))?;
    if units_are_compatible(&backend_unit, configured_unit) { return Ok(()); }
    bail!(
        "Payment backend reports unit {} but config registers unit {}; only matching units or sat/msat conversions are supported",
        backend_unit, configured_unit
    )
}

fn units_are_compatible(backend_unit: &CurrencyUnit, configured_unit: &CurrencyUnit) -> bool {
    backend_unit == configured_unit
        || matches!((backend_unit, configured_unit),
            (CurrencyUnit::Sat, CurrencyUnit::Msat) | (CurrencyUnit::Msat, CurrencyUnit::Sat))
}
```

Notes:

- The **sat/msat special case** exists because the two Lightning-node backends internally denominate in msat while operators conventionally configure `unit = "sat"`; the amounts are converted at request time (e.g. `cdk-lnd/src/lib.rs:412`, `cdk-lnbits/src/lib.rs:273-274`). It is a unit-*conversion* whitelist, not an equality relaxation.
- `CurrencyUnit::from_str` (`crates/cashu/src/nuts/nut00/mod.rs:655-667`) is case-insensitive for `SAT/MSAT/USD/EUR/AUTH` and maps **any other string** to `Ok(CurrencyUnit::Custom(normalize_custom_unit(value)))` (`mod.rs:665`; normalization = trim + NFC, `mod.rs:650-653`). It never fails, so the "returned invalid unit" branch at `lib.rs:981-982` is practically unreachable; the real gate is the equality check. Custom units compare by normalized string.
- Unit tests for the guard: `lib.rs:1944-1965`.

### 2.3 Where `payment_settings.unit` comes from

The Rust trait: `MintPayment::get_settings` returns `SettingsResponse` (`crates/cdk-common/src/payment.rs:439`), defined at `payment.rs:649-662` with `pub unit: String` at `payment.rs:652`, doc-commented "Base unit of backend".

The wire shape, `crates/cdk-payment-processor/src/proto/payment_processor.proto:5-13` and `:22-28` (quoted verbatim):

```proto
service CdkPaymentProcessor {
    rpc GetSettings(EmptyRequest) returns (SettingsResponse) {}
    ...
}

message SettingsResponse {
  string unit = 1;
  Bolt11Settings bolt11 = 2;
  Bolt12Settings bolt12 = 3;
  map<string, string> custom = 4;
  OnchainSettings onchain = 5;
}
```

The gRPC client maps proto → struct 1:1 (`crates/cdk-payment-processor/src/proto/client.rs:135-169`, `unit` passthrough at `client.rs:148`); the server side mirrors it (`server.rs:196`). Every request on this channel carries the header `x-cdk-protocol-version: 3.0.0` (`client.rs:117-121`; constant `PAYMENT_PROCESSOR_PROTOCOL_VERSION` at `crates/cdk-common/src/lib.rs:19`), which the processor server rejects on **exact string inequality** with `Status::failed_precondition("Protocol version mismatch: server={}, client={}")` (`crates/cdk-common/src/grpc.rs:47-68`; wired in `crates/cdk-payment-processor/src/proto/server.rs:106-124`).

### 2.4 Every caller of the guard

`configure_backend_for_unit` (and thus `validate_backend_unit`) is called from exactly these sites in `crates/cdk-mintd/src/lib.rs`:

| Arm | Call site | Backend-reported unit |
|---|---|---|
| CLN | `lib.rs:607` | `"msat"` hardcoded (`crates/cdk-cln/src/lib.rs:95-108`, unit at `:98`) |
| LNbits | `lib.rs:627` | `"sat"` hardcoded (`crates/cdk-lnbits/src/lib.rs:65`, returned at `:154-156`) |
| LND | `lib.rs:653` | `"msat"` (`crates/cdk-lnd/src/lib.rs:116` + `:126-127`, returned at `:222-223`) |
| Fake wallet (LN) | `lib.rs:683` | per-instance `self.unit` (`crates/cdk-fake-wallet/src/lib.rs:492-494`) |
| **gRPC processor** | `lib.rs:714` | whatever the remote returns in `SettingsResponse.unit` |
| LDK node | `lib.rs:740` | `"msat"` (`crates/cdk-ldk-node/src/lib.rs:579-581`) |
| BDK (onchain) | `lib.rs:833` | `"sat"` (`crates/cdk-bdk/src/lib.rs:468-470`), registered as `CurrencyUnit::Sat` at `lib.rs:836` |

One path bypasses the guard: the onchain fake-wallet arm iterates `fake_wallet.supported_units` and calls `configure_backend_for_methods` directly with one backend **instance per unit** (`lib.rs:866-882`) — each instance is constructed for its unit, so no handshake is needed. This instance-per-unit pattern is cdk's historical answer to multi-unit (see section 3).

`SettingsResponse.unit` has **no other consumer in the entire workspace** (verified by grep): besides the proto passthroughs, the only read is `lib.rs:904`. The three runtime users of `get_settings()` read other fields only — `MintBuilder::add_payment_processor` reads `bolt11`/`bolt12`/`onchain`/`custom` to build NUT-04/05/15 entries (`crates/cdk/src/mint/builder.rs:412` ff.), `Mint` enumerates `custom` method names (`crates/cdk/src/mint/mod.rs:448-457`), and the bolt11 mint-quote path checks `bolt11.invoice_description` (`crates/cdk/src/mint/issue/mod.rs:240-249`).

### 2.5 What exactly fails with two grpcprocessor `[[ln]]` entries on one address

Config shape: there is only **one** `[grpc_processor]` section (`crates/cdk-mintd/src/config.rs:845-855`; `addr` default `127.0.0.1` at `:868`, `port` default `50051` at `:872`), so all grpcprocessor entries necessarily share the endpoint. Boot sequence for entries `[{unit=eur}, {unit=usd}]` against a processor whose settings report `"eur"`:

1. Entry 1 (`eur`): new client, `get_settings` → `unit: "eur"` → `validate_backend_unit(Eur, "eur")` passes → backend registered under `PaymentProcessorKey { unit: Eur, method }`.
2. Entry 2 (`usd`): second client to the same address, `get_settings` → `"eur"` again → `units_are_compatible(Eur, Usd)` is false → `bail!` at `lib.rs:988-992`.
3. The `anyhow` error unwinds through `configure_lightning_backend` → `configure_mint_builder` → mintd startup aborts (non-zero exit) with:

   `Payment backend reports unit EUR but config registers unit USD; only matching units or sat/msat conversions are supported`

   (Units render uppercase per `Display`, `crates/cashu/src/nuts/nut00/mod.rs:670-675`.) Which entry dies is order-dependent: the first entry whose unit is not the reported one kills boot; if the processor's reported unit matches no entry, the first entry fails.

Two additional structural facts relevant to any fix:

- The duplicate-registration check would **not** block multi-unit registration: it keys on `(unit, method)` (`crates/cdk/src/mint/builder.rs:394-410`), and different units produce different keys. Only the handshake stands in the way.
- Because each entry gets its own client Arc, the mint's per-processor dedup — `Arc::ptr_eq` in `seen_processors` (`crates/cdk/src/mint/mod.rs:295-302`, `:408-416`, `:439-447`, and in `wait_for_paid_invoices` at `:635-647`) — does not recognize them as one processor. A multi-entry-same-endpoint config (as the downstream patch enables) runs N settings calls and N payment-event streams against one processor. **Inference:** duplicate event delivery is presumably absorbed idempotently by quote state, but it is wasteful and a good argument for sharing one client per endpoint in any upstream design (not tested here).

### 2.6 The dormant `supported_units` field

Stock config already declares plural units for the gRPC processor: `GrpcProcessor.supported_units: Vec<CurrencyUnit>` (`config.rs:847`, `#[serde(default)]`, default empty at `:859`), settable via `CDK_MINTD_GRPC_PAYMENT_PROCESSOR_SUPPORTED_UNITS` (`crates/cdk-mintd/src/env_vars/grpc_processor.rs:10-11`, parsed at `:19-27`). At the pinned rev it is **never consumed** by backend wiring — its only read is a presence heuristic when merging env config (`env_vars/mod.rs:211`). The field's plural name is inherited from the 2024 multi-unit work for Strike and the fake wallet (section 3).

## 3. Why the constraint exists (history)

All commits verifiable in the pinned checkout's full history (2,298 commits); PR mapping via `gh api`.

- **2024-07-26** — `169f5f15` "feat: strike multi unit" and `48bff144` "feat: multi unit for fake wallet": cdk's original multi-unit pattern is **one backend instance per unit**, each instance constructed for and reporting its own unit. The `supported_units` config-field shape dates from here.
- **2025-02-11** — `162507c4` "feat: payment processor": the gRPC processor is born with the singleton `string unit = 1` in `SettingsResponse`. The one-unit assumption is original, not a later restriction.
- **2026-02-12** — `03a5a914` (PR [#1617](https://github.com/cashubtc/cdk/pull/1617)): adds the `x-cdk-protocol-version` header with strict equality, version `"1.0.0"`.
- **2026-02-24 .. 2026-03-09** — per-request unit plumbing matures: [#1673](https://github.com/cashubtc/cdk/pull/1673) (`674ddc64`) adds `unit` to `MakePaymentRequest` instead of hardcoding msat; [#1616](https://github.com/cashubtc/cdk/pull/1616) (`d2db9593`) introduces typed `AmountMessage { value, unit }` everywhere; [#1704](https://github.com/cashubtc/cdk/pull/1704) (`1929bc98`) **removes** `CreatePaymentRequest.unit` as redundant because amounts now carry units. Result at the pinned rev: every request already identifies its unit — `PaymentQuoteRequest.unit` (proto `:170`), `MakePaymentRequest.unit` (proto `:248`), and `AmountMessage.unit` inside incoming options (proto `:17-20`).
- **2026-03-26** — `1505652c` (PR [#1723](https://github.com/cashubtc/cdk/pull/1723)): protocol version bumped to `"2.0.0"`.
- **2026-05-18** — `bc7e441e` (quote_id propagation): bumped to `"3.0.0"`. Three protocol versions in ~3 months; the maintainers bump on breaking proto changes without hesitation.
- **2026-05-31** — the constraint itself. PR [#2015](https://github.com/cashubtc/cdk/pull/2015) "Feat/multiple backends" (author thesimplekid, merged 2026-05-31T12:08Z, merge commit `3b182b1905be4841149457b6a52fbbe5fa3f13c2`) lands two relevant commits:
  - `aaeffa83c7d9d2a1a642eea0978d8190c8e7b21f` "feat(mintd): allow multiple lightning backends per currency unit" — introduces the multiple-`[[ln]]`-entry mechanism (the very feature that makes per-entry units freely configurable).
  - Its **direct child** `a1488006a947be0a957ca82bcf7db0d83c2f723d` "fix: ensure backend support" — adds `validate_backend_unit` + `units_are_compatible` + tests (+55/−2, cdk-mintd only), and fixes the README example that had shown `[[ln]] ln_backend = "lnbits"` with `unit = "eur"` — an invalid pairing (LNbits reports sat) that the docs themselves were recommending — changing it to `"msat"` and adding: "The configured unit must match the backend's reported unit, except for the supported sat/msat conversion pair."
  - Provenance chain: community PR [#1949](https://github.com/cashubtc/cdk/pull/1949) (Micah-Shallom, closed by thesimplekid "Close for #2012") → [#2012](https://github.com/cashubtc/cdk/pull/2012) "multiple payment backends" (closed unmerged) → #2015 merged. The v0.17.0 CHANGELOG credits the feature to `[asmo]` and lists "backend support checks" among fixes by `[thesimplekid]` (`CHANGELOG.md:51`, `:95`). PR #2015's body is the empty template and the guard drew **no review discussion** (only a codecov comment and one user question about same-unit/different-method).
- First released in **v0.17.0** (2026-06-12; it entered between rc.0 of 2026-05-22 and rc.3 of 2026-06-03).

**Why it exists — conclusion (verified + inference):** the guard is a two-month-old misconfiguration tripwire added the same day as, and in the same PR as, the multi-backend feature that created the misconfiguration surface. The recorded motivation is the README's own invalid `lnbits`+`eur` example: without the guard such a config boots and only fails at request time with conversion errors (the failure class users reported in issue [#838](https://github.com/cashubtc/cdk/issues/838) "Error 'Cannot convert units' when using USD backend" — closed; cited at title level, body not reviewed). **Inference:** there is no evidence anywhere in the PR, commits, or issues that the singleton handshake was a deliberate design decision about processors serving one unit; it front-loads an error for the built-in single-unit backends, and the gRPC processor is simply caught in the same net because `SettingsResponse` predates any multi-unit thinking.

## 4. Upstream status today (main @ `77256eb0`, 2026-07-30; latest release v0.17.3, 2026-07-12)

Everything relevant is still in place, unchanged in substance:

- `validate_backend_unit` / `units_are_compatible` — present and identical in logic (main `crates/cdk-mintd/src/lib.rs:1232`, `:1305`, `:1323`; tests `:2351+`).
- `SettingsResponse` proto — still the singleton `string unit = 1` (main proto `:22-28`); `GetSettings` still unary (main proto `:6`).
- `PAYMENT_PROCESSOR_PROTOCOL_VERSION` — still `"3.0.0"` (main `cdk-common/src/lib.rs:22`).
- `GrpcProcessor` config — gained `address` (alias `addr`) and `allow_insecure`; `supported_units` still present (main `config.rs:908-919`).

One notable change: since `703849ef` "fix(mintd): validate startup configuration" (2026-07-19, PR [#1962](https://github.com/cashubtc/cdk/pull/1962)), mintd on main **requires** `[grpc_processor].supported_units` to be non-empty whenever a grpcprocessor entry exists — `bail!("gRPC payment processor supported_units must contain at least one unit via [grpc_processor].supported_units or CDK_MINTD_GRPC_PAYMENT_PROCESSOR_SUPPORTED_UNITS")` (main `lib.rs:485-486`) — yet still consumes it **only as a presence check**. Current main thus forces operators to declare a plural list of units for the processor and then ignores the list. This is a strong wedge for the upstream conversation.

In-flight work touching this exact area:

- Issue [#1984](https://github.com/cashubtc/cdk/issues/1984) (open, gudnuf, 2026-05-20) "Support adding custom (unit, method) pairs at runtime": epoch-rotating custom units (`credit-<T>`) behind a payment processor, registered at runtime without restart. A contributor (GEET3001) is actively proposing `ArcSwap` processor maps + DB persistence (comments 2026-06-09..12). This end state is *one processor, many (changing) units* — structurally incompatible with a boot-frozen singleton-unit handshake.
- PR [#1997](https://github.com/cashubtc/cdk/pull/1997) (open, d4rp4t, 2026-05-23) "chore: settings stream": makes `GetSettings` server-streaming and restructures `Bolt11/Bolt12/OnchainSettings` (breaking field replacement). No human review yet, but it shows `SettingsResponse` evolution is on the table.
- PR [#2275](https://github.com/cashubtc/cdk/pull/2275) (draft, asmogo, 2026-07-29) "analyze payment processor interfaces": hardens the remote-processor integration and refactors the exact `configure_backend_for_unit` call sites (introduces `wrap_payment_processor`); does not touch the unit handshake. Any downstream rebase and any upstream patch will need to track this.
- Proto still actively changing post-v0.17.2 (`5fbcc94d`, `57336181`, 2026-07-10).

No upstream issue or PR proposes multi-unit settings for the processor handshake itself (searches: `supported_units`, "multiple units", "custom unit", "processor" over issues/PRs). The niche is open.

## 5. Who else is affected

For every in-tree backend the check is either tautological or the sat/msat bridge (table in section 2.4): CLN/LND/LDK report msat and are typically configured `sat` (bridge); LNbits/BDK report sat; fake wallet reports whatever unit it was instantiated with. None can ever *legitimately* mismatch. The guard's entire value is therefore:

1. Catching genuinely mis-paired configs for single-unit backends — e.g. `lnbits` + `unit = "eur"` (the old README bug) now fails at boot with a clear message instead of failing per-request with unit-conversion errors.
2. (Unintentionally) forbidding multi-unit gRPC processors.

Risk assessment for relaxing:

- A relaxation **scoped to declared multi-unit** (backend attests a unit list, or operator opts in per config) changes nothing for the built-in backends: they would attest exactly one unit and keep today's protection bit-for-bit.
- A **blanket removal** of the boot check (what the downstream patch does, scoped to the grpc arm only) would regress the lnbits+eur class of protection if applied to all arms; even scoped to grpcprocessor it shifts mis-pointed-processor detection from boot to request time. Downstream compensates because its processor validates every request against its managed-unit lifecycle (`processor/src/backend.rs:97-120`, enforced at `:215`, `:254`, `:308`); a generic upstream change cannot assume every third-party processor does this.
- The stock workaround upstream would presumably offer today — run one processor process per unit on separate ports — is impossible to express anyway (single `[grpc_processor]` section, one addr/port), so stock cdk-mintd effectively supports **at most one non-sat/msat unit per deployment through the gRPC processor**.

## 6. Options analysis

### (a) `SettingsResponse` carries a list of supported units (recommended)

Add `repeated string units = 6;` to `SettingsResponse` (field 6 is free), keep `unit = 1` as the legacy/primary unit. Mintd logic in `configure_backend_for_unit`: if `units` is non-empty, accept the entry when its unit is a member (applying the same sat/msat bridging per element); otherwise fall back to today's singleton check.

- **Protocol compatibility:** adding a `repeated` field is wire-compatible in proto3. Old processor + new mint → field absent → empty list → legacy behavior, unchanged. New processor + old mint → old mint reads only `unit` → identical to today (the processor's primary unit works; extra units are rejected until the mint upgrades — a graceful degradation, not a break). The strict-equality version header is orthogonal: nothing forces a bump for an additive field, and the issue should explicitly request that `"3.0.0"` be kept so mixed-version deployments keep working. If maintainers bump anyway (their record: 1.0.0→2.0.0→3.0.0 in three months), the change becomes lockstep for third-party processors — still fine for anyone pinning both sides to one rev.
- **Code size:** proto +1 line; `SettingsResponse` struct +1 field (`cdk-common/src/payment.rs`); client/server mapping +2 lines (`client.rs:148` area, `server.rs:196` area); mintd validation ~10-15 lines; built-in backends optionally fill `units: vec![self.unit]` (or nothing — fallback covers them). Small, test-friendly.
- **Fit:** matches the direction upstream is already moving — typed per-request units (#1616/#1673/#1704), a *required* plural `supported_units` config field on main, and issue #1984's one-processor-many-units future. Also the natural place to later feed #1997's settings stream (unit list updates at runtime).
- **Acceptance likelihood (inference):** high. It formalizes something their own config surface already implies, costs little, and breaks nothing.

### (b) Per-method unit validation

Move unit attestation from the backend level to the method level (e.g. structured per-method settings that each carry their units; today `custom` is `map<string, string>` with free-form JSON values, `payment.rs:659-661`). Strictly more expressive (a processor could serve bolt11-sat and branch-eur), and the `custom` map could even smuggle a units list today with zero proto change — but that is a stringly-typed side contract, helps only custom methods, and requires more invasive mintd rework (validation currently happens before methods are known, `lib.rs:903-904` vs `:906-926`). **Inference:** low-to-medium acceptance as a designed contract; better folded into a later settings-schema redesign (#1997) than proposed now.

### (c) Make the existing `[grpc_processor].supported_units` authoritative (minimal alternative)

No proto change at all: when the entry's unit is contained in `supported_units` (a field main already **requires** to be non-empty), accept the entry even if the handshake unit differs — optionally downgrading the mismatch to a warning. Smallest possible diff, default protection intact, explicit operator opt-in. Weakness: the config attests what the backend should attest — a mis-pointed address is caught only per-request, and config self-agreement is a weaker invariant than backend attestation. **Inference:** medium-high acceptance; it finally gives meaning to a field upstream forces operators to set. Works well as the interim step or fallback ask.

### (d) Validate lazily per-request only (drop the boot check)

Delete/bypass `validate_backend_unit` and rely on per-request unit checks. This is effectively reverting `a1488006` and regresses boot-time misconfiguration UX for every backend — directly against upstream's current trajectory of *adding* startup validation (PR #1962). **Inference:** near-zero acceptance. Not recommended even though it is what the downstream patch does locally (downstream can afford it because its processor enforces per-request units; upstream cannot assume that).

### Cross-cutting: client sharing

Whatever option lands, the multi-entry-same-endpoint shape should share **one** `PaymentProcessorClient` Arc across entries (today `setup.rs:324-329` builds one per entry), so the mint's `Arc::ptr_eq` dedup (`mint/mod.rs:635-647` etc.) collapses settings calls and payment-event streams to one per processor. Under option (a) the natural implementation — resolve the client once per `[grpc_processor]` section, then loop the configured units — gets this for free.

## 7. Verdict and recommended ask

- **Can it change (technically): yes, cleanly.** `SettingsResponse.unit` has exactly one consumer in the workspace (`lib.rs:904`); an additive `repeated units` field is wire-compatible in both mixed-version directions and need not touch the protocol-version constant.
- **Should it change (design-wise): yes.** The guard is a two-month-old misconfiguration tripwire (born of a README bug, merged without design discussion), not a load-bearing invariant; every request already carries its unit; upstream main *requires* operators to declare a plural `supported_units` list it then ignores; and upstream's own open issue #1984 needs one-processor-many-units anyway.
- **The concrete ask** (precise enough to open an issue titled e.g. "Payment processor settings should be able to advertise multiple units"):
  1. Add `repeated string units = 6;` to `SettingsResponse` in `crates/cdk-payment-processor/src/proto/payment_processor.proto` (keep `unit = 1` for compatibility), mirrored in `cdk_common::payment::SettingsResponse` and the gRPC client/server mappings.
  2. In `cdk-mintd::configure_backend_for_unit`, accept a `[[ln]]` entry when its unit is in `units` (same sat/msat bridging per element); fall back to the existing singleton check when `units` is empty. Built-in backends unchanged (fallback covers them).
  3. Explicitly do **not** bump `PAYMENT_PROCESSOR_PROTOCOL_VERSION` — the field is additive; state the old-mint/new-processor and new-mint/old-processor behavior in the issue.
  4. Optionally: share one `PaymentProcessorClient` across grpcprocessor entries so per-processor dedup works; and/or honor `[grpc_processor].supported_units` (already mandatory on main) as an interim operator-level override.
  5. Reference: #2015/`a1488006` (origin of the guard), #1616/#1673/#1704 (units are per-request already), #1984 (runtime multi-unit needs this), #1997 (settings evolution in flight).

## 8. Impact on the downstream patch

**If accepted (option a):** the largest and most invasive hunk of `patches/cdk-managed-units.patch` — `configure_backend_for_managed_unit`, whose sole essential difference is skipping `validate_backend_unit` — shrinks to configuration glue or disappears (the `unit_keysets`/keyset-expiry configuration it also performs would remain as a much smaller, less contentious diff, or become its own upstream proposal). The downstream processor's `get_settings` (`processor/src/backend.rs:182-203`) stops reporting the awkward `primary_unit`-or-empty-string singleton (`backend.rs:191-195`, fed from `[mint].unit` in `processor/src/main.rs:227-237`) and instead returns its managed-unit set; the "wire filler" comment and the primary-unit concept go away. Per-request enforcement (`backend.rs:215`, `:254`, `:308`) stays as defense in depth. The remaining downstream hunks (mint-info refresh on restart, keyset-seed consistency check, quote_id/pubkey extras in `issue/mod.rs`) are independent of this constraint and unaffected. Bonus: adopting the shared-client shape would eliminate the current N-streams-to-one-processor pattern the patch inherits.

**If rejected:** the patch remains necessary and must be rebased across an actively moving area — PR #2275 alone rewrites every `configure_backend_for_unit` call site, and the proto changed twice in July. The strict version handshake is not itself a risk for downstream (Dockerfile pins both mintd and the processor to the same `CDK_REV`, `Dockerfile:18`, `:45-54`; `processor/Cargo.toml:25-27`), but each upstream protocol bump forces a coordinated re-pin plus patch rebase. Option (c) — if offered upstream as a consolation — would still let downstream drop the lib.rs divergence at the cost of maintaining `supported_units` in mint config, which the downstream config generator already effectively knows.

---

### Fact/inference ledger

Verified: all `file:line` cites above against the pristine pinned checkout; commit SHAs, dates, authorship, and PR membership via the checkout's git history and `gh api`; main-branch state via raw fetch at `77256eb0`; release dates via GitHub releases; the emptiness of PR #2015's review record. Inference (marked inline): the guard's motivation beyond what the commit itself records; acceptance likelihoods; the operational severity of duplicate event streams; issue #838's contents (title only).
