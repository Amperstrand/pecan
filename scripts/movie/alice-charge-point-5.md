# ALICE AT THE CHARGE POINT — demo movie script (v3 = as shipped)

**v3 (visual round):** the charger's on-screen presence is the
**companion strip** — a landscape, bottom-pinned, pointer-transparent
status bar showing ONE charger (SIM CHARGER), live kW·s + remaining
euros read from the wallet's own DOM. It replaces the wasm firmware
mirror in the movie (that mirror shows the atom box's A+B chargers and
cannot see atomV sessions at all — the previous cut's "charger" stayed
idle the whole story; its portrait shape also covered half the UI: the
"jumping" first cut). Settle waits are bridged by animated cards (no
dead air on the invoice), the charging segment stays on screen ≥ 6 s
past 30 kW·s, and the movie ends deliberately: end card → fade to
black. Poster stills land in e2e/.results-video/alice-stills/. The
real firmware-display path (landscape + single-charger profiles) is
tracked as #29.

**v5 (realistic-session round, 2026-09-17):** the tariff is a
real-world **€0.50/kWh** and the car **ramps like a real EV — 3 kW
for the first 30 s, 7 kW for the next 30, then 22 kW** (no random
walk; a deterministic negotiation curve). The €50 deposit authorizes
100 kWh; a stopped session spends cents-to-a-euro and refunds the
rest — real charger behavior. Enablers shipped this round: the
gateway/daemon treat the session budget as metered kW·s (the legacy
3600 wall-cap rejected realistic budgets); the wallet shows kWh at
realistic scales; the strip/pole graphs scale 0-25 kW with stage
bands at 3/7/22; specs stop mid-session (natural caps take minutes
at the unit minimum — selftest covers the cap); e2e lanes shrink
ramp stages and movie.sh pins the realistic 30/30.

**v1 decisions resolved in review:** the charge point is the **Sim
Charger** (atomV — the name says it: simulated, no hardware) · **EUR
pair** on giftcard.cashu.exchange (reusing the proven deployment; no
new endpoint) · **€50 Lightning deposit, ~30 kW·s used, the rest
refunded** · recording is **headless** by default (stable frames) and
**runs on ai-legion-small** via `scripts/movie.sh --remote` (faster
box, artifacts pulled back). Re-record any time:
`scripts/movie.sh --remote`.

A public always-on web view of the sim charger (live state without
operator credentials) is tracked as a follow-up — needs a cred-free
data path (public gateway route or read-only broker token).

**Logline:** Alice is done with proprietary EV apps, credit-card updates,
and chargers that leak her history. She plugs in, pays a Lightning
invoice, and her car charges — ecash in, kilowatt-seconds out. No
account, no card on file, no trail.

**Runtime target:** ~2½ minutes. **Format:** single continuous phone
viewport (420×900) recording, charger display as live corner PiP.
Text cards baked in (voiceover can be layered in post).

**The stack behind every frame (all real, zero hardware):**
wallet at giftcard.cashu.exchange (NOK pair) · real signet bolt11 paid
by our CLN node · ev-charge daemon · atom-gateway · **Charger 5 =
atomV**, the virtual charge point (ev-virtual-charger.service) · the
charger's own display mirrored live via the charger-sim wasm (atom
board), fed by the same MQTT stream a real pole would receive.

---

## SCENE 1 — MEET ALICE (~25 s)

**Visual:** dark card stack over a soft background (DOM overlays, no
wallet yet).

Cards (one at a time, ~4 s each):

1. "Meet Alice."
2. "Alice drives an electric car." (small EV icon)
3. "Her phone has an app for every charging network." — mock app grid
   blurs in: *eChargeGo · Voltly · PowerPort · kWh! · Chargr · eFlow*
4. "Every few months: re-enter the credit card. Everywhere."
5. "Last spring, one network leaked its users' charging history —
   home addresses, habits, overnight stops — onto the darknet."
6. "Alice just wants to plug in, pay, and drive."
7. "Pay over Lightning. Like cash."

**Tech:** styled full-screen divs injected via `page.evaluate`; timed
dissolves; no page navigation.

---

## SCENE 2 — THE CHARGE POINT (~15 s)

**Visual:** cut to a rendered "pole card" — a sticker graphic:

> ⚡ **CHARGE POINT 5**
> Cashu Charge Co.
> [QR CODE]  ← encodes the wallet deep link
> "Scan to charge · Pay with Lightning"

**On-screen text:** "A public charge point. No screen to trust, no
card reader — just a QR that opens the wallet."

**Tech:** the QR is generated for real (the `qrcode` lib is already a
dependency) encoding
`https://giftcard.cashu.exchange/nok-console/wallet?charger=atomV`.
Rendered as an overlay card. *(Needs the deep-link feature — see
"Features to build".)*

---

## SCENE 3 — ALICE OPENS THE WALLET (~10 s)

**Visual:** the wallet loads in the phone frame (fresh profile =
Alice's first visit). Balance 0.00 kr. Charger-5 display PiP mounts
top-right, showing an idle charger.

**On-screen text:** "No app store. No sign-up. A web page holding
bearer ecash — cash for kilowatts."

**Tech:** fresh persistent profile `/tmp/alice-movie-profile`; NOK
currency; mount the atom-board charger-sim PiP (existing
`mountSimPip`), which shows idle until a session starts.

---

## SCENE 4 — TOP UP OVER LIGHTNING (~30 s)

**Action:** Alice taps **Lightning**, enters **NOK 100**, creates the
invoice.

**Visual:** real bolt11 QR + "Pay this lightning invoice (signet)".
Cutaway card: "Alice pays from her Lightning wallet ⚡". The invoice
is paid FOR REAL by our signet CLN node (`payLightningInvoice`).
Balance animates 0.00 → 100.00 kr.

**On-screen text:** "A real Lightning invoice. Paid. The mint issues
Alice 100 kr as ecash — no name, no card, no account attached."

**Tech:** reuse the proven charger-d-nok flow (Lightning deposit →
`readBalance` poll). The cutaway card masks the ~5–20 s payment
settle wait. Signet sats, NOK denominational ecash — exactly the
deployed rail.

---

## SCENE 5 — SCAN THE CHARGE POINT (~12 s)

**Visual:** the pole card from Scene 2 slides back in; the phone
"scans" the QR (brief camera-shutter flourish); the wallet re-opens
with **Charger 5 preselected** in the withdraw card.

**On-screen text:** "The QR is just a link — it hands the wallet the
charge point. Nothing else leaves Alice's phone."

**Tech:** navigate to the deep link from Scene 2; the wallet
preselects Charger 5. *(deep-link feature — see below.)* PiP shows
the charger still idle.

---

## SCENE 6 — CHARGE (~35 s)

**Action:** budget **NOK 20** (720 kW·s at 100 kr/kWh — billed by the car's meter) → **Start charging**.

**Visual:** "⚡ Charging at Charger 5" · slider counts delivered
kW·s · **the PiP comes alive — the charge point's own display runs
its countdown**, relay-state and all.

**On-screen text:** "Twenty kr of energy. Metered by the charge
point, settled second by second. Alice's car drinks; her wallet
spends."

**Mid-scene beat:** at ~12 kW·s delivered, **Alice presses Stop**.
The charger display winds down; receipt appears:
`EV-atomV-12s-XXXXXXXX`.

**Tech:** the virtual charger walks the draw 3-10 kW (real cadence); energy is billed per kWh by the meter,
remote Stop = the deployed gateway path; the PiP mirrors the same
MQTT stream the pole would show.

---

## SCENE 7 — RECEIPT & CLOSE (~20 s)

**Visual:** receipt card; balance 100.00 → 88.00 kr; the 8 unspent
kr refund lands (balance ticks up as the refund claim settles).

**On-screen text (closing cards):**

1. "Alice paid for 12 kilowatt-seconds. The other 8 kr came back —
   automatically."
2. "No app. No card on file. No charging history — ecash is cash."
3. "Pay for energy the way you pay for anything else: Lightning in,
   kilowatt-seconds out."
4. End card: **pecan · Cashu · Lightning** — "chargepoint.cashu.exchange"

**Tech:** balance-math assertion behind the scenes (100 − 12 + refund
timing; final == 88.00 ± fee-free exactness). Video artifact saved
with the receipt screenshot.

---

## RECORDING PLAN

New spec `web/e2e/alice-video.spec.ts` (gated `PECAN_VIDEO=1`, like
the existing video lane) + `scripts/movie.sh` runner:

1. Preflight: nok pair health, atomV online, virtual-charger service
   up; fresh Alice profile; charger-sim local https server up
   (existing `sim-https-server.js`).
2. Run the story top-to-bottom under `playwright.video.config.ts`
   (420×900, video on). Pacing: generous holds after every card so
   text is readable (~reading speed ≈ 3 words/sec).
3. Output: `web/e2e/.results-video/alice-charge-point-5.webm` (+ per-
   scene PNGs). Optional ffmpeg pass to add a title card, fades, and
   an audio track later.

## FEATURES TO BUILD (small, story-true — pending your OK)

- **F1 · Charger deep-link** (~20 lines in wallet.tsx): honor
  `?charger=atomV` on boot by preselecting that withdraw tab. This is
  what the pole's QR encodes — and it works with a real sticker on a
  real pole later.
- **F2 · Rename the wallet tab** "Charger V" → **"Charger 5"** (id
  stays `atomV`; hint: "Virtual charge point — always on, no
  hardware"). Alternative: keep "Charger V" and say "Charger V" in
  the narration. **Recommend F2 as written — you asked for Charger 5.**
- **F3 · Scene cards + pole-card + QR prop** as reusable overlay
  helpers in the spec (movie chrome, not app code).

## OPEN QUESTIONS FOR REVIEW

1. Charger naming: rename to "Charger 5" (F2) — yes/no?
2. Deep-link (F1): build it, or fake the scan with a cut?
3. Voiceover: bake text-only now and dub later, or skip cards and go
  pure UI with captions?
4. Currency/amounts: NOK 100 top-up, 20 kr budget, stop at 12 — good?
5. The "darknet leak" card (Scene 1.5): keep the edge, or soften to
   "sold and leaked her charging history"?
6. End-card domain: chargepoint.cashu.exchange (doesn't exist yet) or
   giftcard.cashu.exchange?
