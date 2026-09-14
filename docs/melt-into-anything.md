# Melt into anything — pecan as the settlement rail for real-world goods

*Vision note + integration spec, written 2026-09-13. Grounded in two
live-verified provider APIs (Bil i Oslo municipal parking/charging, EasyPark)
captured in `phoneautomation/mobile_phone_automation/{bilioslo,parking}/api/`.*

## The idea

Pecan already proves the **deposit pattern** on the charger fleet (the
"commercial charger shape"): melt a budget → deliver live (slider, delivered
↑ / remaining ↓) → Stop → STOPPED receipt with actual delivered → refund the
un-melted remainder as a locked mint quote validated against the delivery
ledger. See `partial-delivery.md` for the Cashu mechanics and `status.md` for
the e2e state.

The generalization: **any good with an open-ended final price** can ride the
same contract. Parking and public charging are the first two real-world
adapters where we control BOTH ends: the ecash side (pecan mint) and the
fiat/service side (mapped municipal APIs). Pecan becomes "melt into anything":
reserve a deposit → the good is delivered (a parking session runs, kWh flows)
→ settle at actuals → change comes back as ecash.

## The generic contract (unchanged from the charger shape)

| Phase | Pecan side | Real-world side (adapter) |
|---|---|---|
| Reserve | melt budget B (exact-amount pre-swap first) | quote the session: B = max_estimate(actual) |
| Deliver | delivery ledger accrues as ticks arrive | session runs; poll cost/energy |
| Stop | Stop from browser/device → STOPPED receipt | stop command → final receipt (actual cost A) |
| Settle | burn exactly A from the melt | adapter pays A via the provider's card on file (float) |
| Change | refund B−A as locked mint quote | n/a — ecash-side only |

Failure taxonomy (all refund-full unless partially delivered): start refused,
plug/arrive timeout, provider error pre-delivery.

## Adapter 1 — Bil i Oslo (municipal, Oslo kommune)

Auth: 30-day JWT (`POST /api/Token` email+password). Card on file = the
bridge's float card (currently ****6678, recurring-capable, all others deleted).

### Parking (street/zone) — `POST /api/Parking`
| Parameter | Type | Notes |
|---|---|---|
| `PlateNumber` | str | the license plate, e.g. `DP76510` |
| `PriceGroup` | int | the zone id (tariff group), e.g. `2300`; from zone search/polygons |
| `EndTime` | iso-str or null | null = auto (free-window extension); explicit for capped sessions |
| `VehiclePriceGroup` | int | 0 default (fossil/EV pricing classes) |
| `PaymentCardId` | int | float card id, e.g. `1357056` |
| `HasHcCard` | bool | disability permit holder |
- Response: `result.id` = **parkingId**, `fee`, `startTime`, `endTime`, `maxEndTime`.
- **Stop**: `PUT /api/Parking/{parkingId}/EndTime/Now` → final `fee` = settle amount A.
- **Deposit sizing**: `GET /api/Parking/Fee?PriceGroup={z}&EndTime={iso}` quotes
  any window exactly — B = quote for the requested (or max) window. Free
  windows (nights/Sunday) quote 0 → no melt needed, straight start.

### Charging (+ parking) — `POST /api/Ocpi/Commands/Start`
| Parameter | Type | Notes |
|---|---|---|
| `LocationId` | str | charger site id, e.g. `53876475ab9cad87f80038208b73` |
| `EvseUid` | str | the specific plug, e.g. `8e77245a5de44ea78de76e90` |
| `ParkingRequest` | obj | same fields as parking above (`PlateNumber`, `PriceGroup`, …) |
| `DeviceToken` / `Platform` | str | push token (`GCM`) — bridge supplies its own |
- Response: `parkingChargingSession {id, sessionStatus: PENDING, timeout: 210, kwh}`.
  **210 s plug window**: no plug → auto-expire, kwh 0.0, cost 0 → full refund path.
- Final cost = kWh × tariff + parking time; `kwh` accrues in session polls.
- **Stop**: not yet observed (session expired first) — capture on first real
  charge; OCPP mapping says stop = session stop command.

## Adapter 2 — EasyPark (commercial zones, e.g. 949 Kolbotn)

Auth: 24 h SSO idToken via `x-authorization` + cookie (harvest from emulator
login; OTP SMS). Same DDR shape:

| Parameter | Type | Notes |
|---|---|---|
| `parkingAreaNo` / `parkingAreaId` | str / int | zone number (949) / internal id (54912) |
| `carLicenseNumber` + country | str | plate |
| `startDate` / `endDate` | epoch-ms | the window |
| `parkingUserId` | int | account user id |
| `lat` / `lon` | float | zone coordinates (not validated server-side) |
- **`POST /parking/prestart` returns the exact price before commit** — the
  cleanest deposit estimator of the two providers. Free zones quote 0.
- Start: `POST /android/api/parking/start` → parkingId. Stop:
  `POST /android/api/parking/{id}/stop`.

## Bridge service shape (the "good deliverer")

One service, provider-agnostic core + thin provider adapters:

```
wallet → melt(B) → bridge → provider.start(params)
                 ← session_id, quote
poll: provider.session(id) → delivered so far → pecan delivery ledger (slider)
wallet Stop → bridge → provider.stop(id) → final A
        pecan settles: burn A, refund B−A as locked quote
```

- **Float**: bridge owns ONE recurring-capable card per provider; fund
  manually; cap concurrent sessions to float size.
- **Idempotency**: session ids are provider-issued; keep melt-id ↔ session-id
  mapping; retries must not double-start.
- **Pricing knob**: melt denominated in NOK at 1:1 initially (mint unit =
  NOK); margin later via quote multiplier.
- **Safety**: free-tier/0-kr sessions must also ride the contract (B=0 melt
  or bypass flag) so accounting stays uniform.

## Integration order

1. evmap provider adapters (read-only) — `evmap/docs/bymoslo-provider-plan.md` M1–M2.
2. bilioslo + easypark SDKs (phoneautomation) — M2.
3. evmap start-action with confirm — M3.
4. **pecan bridge (this doc)** — swap the fiat-confirm surface for a melt:
   evmap "Pay & park / Pay & charge" → melt budget → DDR → change back.
   Start with bymøslo charging (kWh metering maps 1:1 to the charger fleet's
   delivered-slider) then parking (time-based ticks).

## Relationship to TollGate (tollgate-rs)

Same vision, different meter ownership. Three layers:

| | TollGate (tollgate-rs) | Pecan deposit pattern | Melt-into-anything adapters |
|---|---|---|---|
| Who meters | **You** — the node gates + meters delivery itself (bytes via forwarding, kWh via your own relay fleet) | Pecan's delivery ledger | **Third party** — Oslo kommune/EasyPark meter; we can only poll |
| Who settles | Device-to-device, Spilman channels, 5 s metering ticks | Mint + locked refund quote | Bridge fronts fiat (float card), converts ecash→service |
| Parameters | **None by design** — resource-agnostic `ResourceAdapter` trait; "bytes, watt-hours, milliliters" | charger fleet slugs | zone/plate/EVSE tables (this doc) — these ARE the missing adapters |

tollgate-rs has no provider parameter mappings because its core is deliberately
resource-agnostic: `tollgate-core` takes a `Wallet` + `ResourceAdapter` via
traits, and the only shipped adapter today is network forwarding (tollgate-net).

**Convergence path**: the municipal bridge can be wrapped as a TollGate
`ResourceAdapter` — "parking minutes at zone 2300" and "kWh at EVSE X" become
native TollGate resources where the metering tick = provider poll. Caveats:
the provider cannot co-sign Spilman updates, so the channel terminates at the
BRIDGE (bridge = TollGate server, holds float risk, settles at the mint);
clients effectively use bootstrap-token or bridge-channel payment. That would
make any TollGate client — not just evmap — able to buy real-world parking
and charging autonomously.

## Open questions (later)

- Melt denominated vs provider currency drift (NOK only at first).
- Multi-tenant: NO — single-family credential, personal use (detection
  posture documented in the RE playbook).
- Refund rounding: Cashu denomination granularity vs øre-level costs
  (pre-swap already handles exact amounts).
