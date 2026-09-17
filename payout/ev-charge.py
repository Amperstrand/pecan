#!/usr/bin/env python3
"""ev-charge — the EV charging payout-rail adapter.

A melt destination written as `ev:<device-slug>` buys metered energy on
that charger: the ecash is locked (burned inputs, held by the mint) before
any energy flows, the charger runs a tariff-derived energy budget
(--eur-per-kwh: the melt's cents become a kW·s budget), and the settled
ticket's receipt is the session record — the OCPP analogue is exact
(StartTransaction's meterStart → MeterValues → StopTransaction's
meterStop; the device meter IS the billed quantity, #30 layer A+B).

Two modes:

  single-shot (default): --code ABC123 settles one wallet melt. Used by
    operators and the e2e suite.

  --watch: daemon mode — poll GET /api/tickets/open?rail=ev on the
    console, settle each new ticket as it appears. This is the self-serve
    demo path: a customer melts `ev:atomA` in the wallet and the charger
    fires with nobody running anything. A state file records every
    triggered ticket so a restart never double-delivers energy: a ticket
    marked triggered-but-unsettled is left for an operator, never
    re-triggered. A deposit melt that expires without EVER triggering
    the device is auto-refunded (issue #13): the ticket is mark-failed,
    the mint's PaymentFailed rollback releases the burned proofs, and
    the wallet reclaims them on its next poll/reload. Triggered
    sessions are never auto-refunded.

Device gateway contract (any backend may implement it; evmap's
atom-gateway implements it over HiveMQ, ev-device-fake.py for tests).
The trigger's `seconds` field is the session's REQUESTED BUDGET in kW·s
(metered devices cap at it; meterless ones run it as a 1 kW window):

  POST /device/{id}/trigger  {"seconds": N}   X-API-Key: <key>
       -> 200 {"triggered": true, "session": "<id>"}   energy starts
       -> 4xx {"triggered": false, "reason": "..."}    device refused
  GET  /device/{id}/status
       -> 200 {"state": "idle"|"running"|"done", "session": "<id>",
               "seconds": N}   (delivered kW·s once done)

Usage:
  python3 ev-charge.py --base https://host/eur-console \
      --password "$PW" --code ABC123 \
      --gateway http://127.0.0.1:8899 --eur-per-kwh 100

Exit codes (single-shot): 0 settled · 2 policy refusal · 3 fund-lock
timeout · 4 API error · 5 wrong rail · 6 device timeout (ticket left
open — a human can still settle it). Single-shot prints exactly one JSON
line on stdout; the daemon logs one JSON line per event.
"""
import argparse
import http.cookiejar
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canonical_events

RAIL = "ev"

# ---------------------------------------------------------------------------
# Energy pricing (#30 layer B): the tariff is CURRENCY UNITS PER kWh and
# the billed quantity is the METERED kW·s (1 kWh = 3600 kW·s).
#
#   budget_kws(cents, P) = cents * 36 / P        (what a melt buys)
#   bill_cents(kws, P)   = kws   * P / 36        (what delivery costs)
#
# Both directions round-half-away-from-zero in Python; P=100 (the demo
# value on every pair) makes the denominator 9, so no exact .5 cases
# exist and the wallet's JS Math.round agrees cent-for-cent.
#
# WHY 0.50 units/kWh (real-world AC tariff, 2026-09-17 round): the
# gateway now treats a session budget as METERED kW·s (cap 10M), the
# simulated car ramps 3->7->22 kW, and e2e lanes shrink the ramp
# stages (virtual-charger.sh stages) plus STOP mid-session — so the
# old blockers (3600-cap rejections, 12-40 min natural caps) are gone.
# Refunds stay above the mint's 1-unit minimum for any deposit >= 2
# units; a 1-unit melt spends at most cents on a stopped session.
# ---------------------------------------------------------------------------


def budget_kws(amount_cents: int, eur_per_kwh: float) -> int:
    """Metered-energy budget (kW·s) a melted amount buys."""
    return max(1, round(amount_cents * 36.0 / eur_per_kwh))


def bill_cents(kws: int, eur_per_kwh: float) -> int:
    """Cost in cents of delivered metered kW·s (>= 1 cent once energy
    flowed — the daemon's accounting floor)."""
    return max(1, round(kws * eur_per_kwh / 36.0))


# The device gateway refuses trigger budgets above this (its window
# contract); refusing locally names the cause instead of a bare 400.
# The gateway validates 1..10,000,000 kW·s (a metered-energy budget,
# not wall time — realistic tariffs authorize thousands of kW·s per
# unit; the meter caps delivery at the authorization).
GATEWAY_MAX_KWS = 10_000_000


class Console:
    def __init__(self, base: str, user: str, password: str):
        self.base = base
        self.user = user
        self.password = password
        jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar))
        self._login()

    def _login(self) -> None:
        req = urllib.request.Request(
            self.base + "/api/login",
            data=json.dumps({"username": self.user,
                             "password": self.password}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.op.open(req, timeout=30) as r:
            r.read()

    def _request(self, method: str, path: str, payload=None):
        # Every pecan deploy recreates the processor and kills the
        # session cookie — a one-shot login 401s forever after. Re-auth
        # once and retry on exactly that condition.
        def build():
            headers = {"Content-Type": "application/json"}
            data = (json.dumps(payload).encode()
                    if payload is not None else None)
            if data is None:
                headers = {}
            return urllib.request.Request(self.base + path, data=data,
                                          headers=headers, method=method)
        try:
            with self.op.open(build(), timeout=30) as r:
                body = r.read().decode()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            self._login()
            with self.op.open(build(), timeout=30) as r:
                body = r.read().decode()
                return json.loads(body) if body else {}

    def post(self, path: str, payload: dict) -> dict:
        return self._request("POST", path, payload)

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def open_tickets(self) -> list:
        tickets = self.get(f"/api/tickets/open?rail={RAIL}")
        return tickets if isinstance(tickets, list) else []


class Gateway:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/")
        self.key = key

    def _req(self, method: str, path: str, payload=None):
        headers = {"X-API-Key": self.key}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.base + path, data=data, headers=headers, method=method)
        with urllib.request.build_opener().open(req, timeout=30) as r:
            return json.loads(r.read().decode() or "{}")

    def trigger(self, device: str, seconds: int, session_ref=None) -> dict:
        payload = {"seconds": seconds}
        if session_ref:
            payload["session_ref"] = session_ref
        return self._req("POST", f"/device/{device}/trigger", payload)

    def status(self, device: str) -> dict:
        return self._req("GET", f"/device/{device}/status")


from canonical_events import journal as canonical_journal


def _canonical(a):
    return getattr(a, "canonical", None) or canonical_events.NullJournal()


def log(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def deliver_energy(a, gateway: Gateway, tid: str, amount: int,
                   slug: str, device_map: dict, session_ref=None) -> tuple:
    """Trigger the charger, await the window, mark the ticket paid.

    Returns (exit_code, result). Never called before the wallet's fund
    lock, and never twice for one ticket (the daemon's state file guards
    that; single-shot runs once by construction).
    """
    device = device_map.get(slug, slug)
    seconds = budget_kws(amount, a.eur_per_kwh)
    if seconds > GATEWAY_MAX_KWS:
        _canonical(a).terminal(tid, "failed", 0, 0, 0, receipt="",
                               legacy="budget-over-gateway-cap")
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device, "seconds": seconds,
                   "reason": f"budget {seconds} kW·s exceeds the device "
                             f"gateway's {GATEWAY_MAX_KWS} kW·s window — "
                             f"lower the amount or the tariff"}
    try:
        trig = gateway.trigger(device, seconds, session_ref=session_ref)
    except urllib.error.HTTPError as e:
        _canonical(a).terminal(tid, "failed", 0, 0, 0, receipt="",
                               legacy=f"gateway-rejected-{e.code}")
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device, "seconds": seconds,
                   "reason": f"device gateway rejected: {e.code}"}
    except urllib.error.URLError as e:
        _canonical(a).terminal(tid, "failed", 0, 0, 0, receipt="",
                               legacy=f"gateway-unreachable")
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device,
                   "reason": f"device gateway unreachable: {e.reason}"}
    if not trig.get("triggered"):
        _canonical(a).terminal(tid, "failed", 0, 0, 0,
                               receipt="",
                               legacy="trigger-declined")
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device, "seconds": seconds,
                   "reason": trig.get("reason", "trigger declined")}
    _canonical(a).grant(tid, seconds, amount * 10, device,
                        session_ref=session_ref)

    # Tariff snapshot: bill at the rate the session was priced at, not
    # whatever the daemon currently runs with (a restart with a changed
    # --eur-per-kwh mid-session must not reprice delivered energy).
    # Looked up BEFORE any settle path — the timeout receipt needs it
    # too (an unbound-variable crash here was caught by unit test).
    tariff = getattr(a, "_tariffs", {}).get(tid, a.eur_per_kwh)

    started = time.time()
    done_by = started + seconds + a.settle_grace
    state = None
    while time.time() < done_by:
        try:
            state = gateway.status(device)
        except (urllib.error.URLError, urllib.error.HTTPError):
            state = None  # transient poll failure — keep waiting
        if state and state.get("state") == "done":
            break
        elapsed = min(int(time.time() - started), seconds)
        _canonical(a).progress(
            tid, 0, elapsed, bill_cents(elapsed, tariff) * 10)
        time.sleep(1.0)
    if not (state and state.get("state") == "done"):
        # Metering lost: the window was granted (the relay was commanded
        # for its full length) but completion was never confirmed.
        # Settle the GRANTED window with a TIMEOUT receipt rather than
        # leaving the ticket open — an expired open ticket burns the
        # whole deposit with no accounting at all (the drift class of
        # 2026-09-03). If the relay never physically fired the operator
        # can refund against this audit trail.
        receipt = "EV-{}-{}s-{}-TIMEOUT".format(
            device, seconds, secrets.token_hex(4).upper())
        cents = bill_cents(seconds, tariff)
        _canonical(a).terminal(tid, "lease_expired", 0, seconds,
                               seconds * 1000, receipt=receipt,
                               legacy="device-timeout-settled")
        notes = (f"payout rail {RAIL} (charge session, metering lost) "
                 f"receipt={receipt}")
        try:
            console.post(f"/api/tickets/{tid}/mark-paid",
                         {"notes": notes, "receipt": receipt,
                          "delivered": cents})
        except (urllib.error.HTTPError, urllib.error.URLError):
            return 6, {"result": "device-timeout-settle-failed", "id": tid}
        _canonical(a).settle(tid, cents * 10)
        return 6, {"result": "device-timeout-settled", "id": tid,
                   "destination": slug, "device": device,
                   "seconds": seconds, "receipt": receipt}

    # The device's stop button aborts mid-window: delivered < requested
    # and the status carries stopped=true. The receipt states the
    # delivered seconds and ends with STOPPED. `delivered` rides the
    # settle as rail metadata (the mint settles at the FULL quote — cdk
    # rejects total_spent below the quote amount); the deposit-pattern
    # wallet claims the difference as a refund mint quote.
    delivered = int(state.get("seconds", seconds))
    was_stopped = bool(state.get("stopped"))
    suffix = "-STOPPED" if was_stopped else ""
    receipt = "EV-{}-{}s-{}{}".format(device, delivered,
                                      secrets.token_hex(4).upper(), suffix)
    cents = bill_cents(delivered, tariff)
    _canonical(a).terminal(
        tid, "completed" if was_stopped else "cap_seconds", 0, delivered,
        delivered * 1000, receipt=receipt,
        legacy="stopped" if was_stopped else "full-window")

    notes = f"payout rail {RAIL} (charge session) receipt={receipt}"
    # `delivered` rides along as rail metadata — the mint settles the melt
    # at the FULL quote either way (cdk rejects total_spent < amount), so
    # partial delivery is accounted by the streaming wallet, not here.
    try:
        console.post(f"/api/tickets/{tid}/mark-paid",
                     {"notes": notes, "receipt": receipt,
                      "delivered": cents})
    except urllib.error.HTTPError as e:
        return 4, {"result": "api-error", "id": tid,
                   "stage": "mark-paid", "status": e.code}
    except urllib.error.URLError as e:
        return 4, {"result": "api-error", "id": tid,
                   "stage": "mark-paid-transport", "error": str(e.reason)}
    _canonical(a).settle(tid, cents * 10)
    return 0, {"result": "settled", "id": tid, "rail": RAIL,
               "amount": amount, "destination": slug, "device": device,
               "seconds": delivered, "stopped": was_stopped,
               "delivered_cents": cents,
               "receipt": receipt, "status": "paid"}


def load_state(path):
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def save_state(path, state):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def tid_of_record(state, quote_id):
    for tid, r in state.items():
        if r.get("quote_id") == quote_id:
            return tid
    return quote_id


def settle_refunds(a, console, state):
    """Deposit-pattern refunds: the wallet claims the un-consumed part of
    a settled deposit melt by creating a branch mint quote whose
    description is `refund:<melt-quote-id>`. Validate it against the
    delivery ledger — the claimed amount may not exceed what the session
    actually left unconsumed, and each melt refunds at most once — then
    settle it like any deposit. Money returns through the standard
    mint-quote machinery; no melt is ever settled below its amount."""
    try:
        tickets = console.get("/api/tickets/open?kind=incoming")
    except (urllib.error.URLError, urllib.error.HTTPError) as e:
        log({"result": "api-error", "stage": "refund-scan", "error": str(e)})
        return
    for t in tickets if isinstance(tickets, list) else []:
        desc = t.get("description") or ""
        if not desc.startswith("refund:"):
            continue
        quote_id = desc.split(":", 1)[1]
        # find the delivery record for that melt quote
        rec = next((r for r in state.values()
                    if r.get("quote_id") == quote_id
                    and r.get("status") == "settled"), None)
        if rec is None:
            continue  # not ours, or not settled — leave for an operator
        if rec.get("refunded"):
            continue  # one refund per melt, ever
        overpay = max(0, int(rec.get("amount_cents", 0))
                      - int(rec.get("delivered_cents", 0)))
        claimed = int(t.get("amount", 0))
        if claimed < 1 or claimed > overpay:
            log({"result": "refund-refused", "id": t.get("id"),
                 "quote_id": quote_id, "claimed": claimed,
                 "overpay": overpay})
            continue
        receipt = "REFUND-{}".format(secrets.token_hex(4).upper())
        try:
            console.post(f"/api/tickets/{t['id']}/mark-paid",
                         {"notes": f"ev deposit refund for {quote_id} "
                                   f"({claimed}c of {overpay}c overpay) "
                                   f"receipt={receipt}",
                          "receipt": receipt})
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            log({"result": "api-error", "stage": "refund-mark-paid",
                 "error": str(e)})
            continue
        rec["refunded"] = True
        save_state(a.state_file, state)
        _canonical(a).refund(tid_of_record(state, quote_id), claimed * 10)
        log({"result": "refund-settled", "quote_id": quote_id,
             "amount": claimed, "receipt": receipt})


def wait_fund_lock(console, tid, ticket, timeout):
    """Poll the open-tickets list until our ticket leaves `waiting`."""
    deadline = time.time() + timeout
    while ticket.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        by_id = {t.get("id"): t for t in console.open_tickets()}
        ticket = by_id.get(tid, ticket)
    return ticket


# Ledger states proving the trigger path RAN — energy may have flowed,
# so these tickets are terminal for the daemon (at-most-once delivery)
# and are NEVER auto-refunded, whatever their quote state.
ENERGY_ATTEMPTED = ("triggered", "settled", "open")
EXPIRY_MARGIN_S = 5.0


def expired_action(t, rec, now, margin=EXPIRY_MARGIN_S):
    """Pure predicate: (ticket state, trigger record) -> refund|close|None.

    Issue #13: distinguish a deposit melt that EXPIRED WITHOUT EVER
    TRIGGERING the device from one that delivered (partially or fully).

    "refund" — the quote is at/past expiry (minus a margin), no energy
      was ever attempted (no ledger record, or a record whose trigger
      was REFUSED before any delivery — gateway declined/unreachable),
      and the wallet's fund lock happened (ticket left `waiting`, so
      the mint is holding burned proofs). The refund itself is the
      mint's own compensation: mark-failed pushes PaymentFailed, cdk's
      melt saga rolls the setup back, the proofs become spendable
      again, and the wallet reclaims them (op rollback on its next
      poll/reload). Deliberately NOT a fresh mint issuance: the
      processor refuses mark-paid on expired quotes ("the mint may
      already have refunded the customer's ecash"), so the stop-path
      refund quote cannot be driven here — and on top of a rollback it
      would double-pay (restored proofs AND new ecash).
    "close" — expired before the fund lock: nothing was ever burned,
      the quote just dies unpaid; the ticket is failed so it leaves the
      open list and reconcile's stale-pending notes.
    None — not expired yet, no expiry known, or the ledger proves the
      trigger ran (triggered/settled/open: energy may have flowed).
    """
    expires = t.get("expires_at")
    if not expires:
        return None
    if now <= float(expires) - margin:
        return None
    if rec.get("status") in ENERGY_ATTEMPTED:
        return None
    return "refund" if t.get("status") != "waiting" else "close"


def resolve_expired_ticket(a, console, state, t, action):
    """Apply an expired_action() decision (issue #13).

    mark-failed FIRST, ledger second: a failed POST leaves the record
    untouched so the next poll retries (re-marking a Failed ticket is a
    processor no-op and cannot re-fire PaymentFailed — that event only
    leaves an Outgoing+Pending ticket, i.e. the first call's job).
    """
    tid = t.get("id", "")
    now = int(time.time())
    amount = int(t.get("amount", 0))
    if action == "refund":
        notes = ("expired before the charger fired — nothing delivered. "
                 "AUTO-REFUND (issue #13): the mint rolls the melt back "
                 "and the deposit proofs are spendable in the customer's "
                 "wallet again. Do NOT pay out manually — that would "
                 "double-pay.")
    else:
        notes = ("expired waiting for the wallet's fund lock — nothing "
                 "burned, nothing due")
    try:
        console.post(f"/api/tickets/{tid}/mark-failed", {"notes": notes})
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        log({"result": "api-error", "stage": "expire-mark-failed",
             "id": tid, "error": str(e)})
        return
    if action == "refund":
        rec = {"status": "open", "at": now,
               "result": "expired-before-trigger",
               "refund_via": "mint-rollback",
               "refunded": True,
               "delivered_cents": 0}
        if t.get("quote_id"):
            rec["quote_id"] = t.get("quote_id")
            rec["amount_cents"] = amount
        if state.get(tid):
            rec["prior_result"] = state[tid].get("result")
        state[tid] = rec
        save_state(a.state_file, state)
        _canonical(a).terminal(tid, "lease_expired", 0, 0, 0,
                               receipt="",
                               legacy="expired-before-trigger")
        # The rollback IS the refund — journal it like settle_refunds
        # does so canonical consumers see the money returning.
        _canonical(a).refund(tid, amount * 10)
        log({"result": "refund-issued", "id": tid,
             "amount_cents": amount, "via": "mint-rollback",
             "reason": "quote expired before the charger fired"})
    else:
        state[tid] = {"status": "open", "at": now,
                      "result": "expired-waiting-fund-lock",
                      "refund_due_cents": 0}
        save_state(a.state_file, state)
        _canonical(a).terminal(tid, "lease_expired", 0, 0, 0,
                               receipt="",
                               legacy="expired-waiting-fund-lock")
        log({"result": "closed", "id": tid,
             "reason": "quote expired before the fund lock"})


def watch(a, console, gateway, device_map):
    state = load_state(a.state_file)
    while True:
        try:
            tickets = console.open_tickets()
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            log({"result": "api-error", "stage": "open-tickets",
                 "error": str(e)})
            time.sleep(a.poll_interval)
            continue
        for t in tickets:
            tid = t.get("id", "")
            rec = state.get(tid, {})
            # Expiry first, and it must see every record that does not
            # prove energy was attempted — including `refused` (trigger
            # declined/unreachable: no delivery ever happened). Before
            # issue #13 a refused ticket was skipped past the expiry
            # guard and lingered funded-and-expired forever: exactly
            # the deposit-burn drift class of 2026-09-03.
            action = expired_action(t, rec, time.time())
            if action:
                resolve_expired_ticket(a, console, state, t, action)
                continue
            # Every post-trigger state is terminal for the daemon: energy
            # may have flowed, so a ticket is triggered AT MOST once per
            # state file, whatever happened after.
            if rec.get("status") in ("triggered", "settled", "refused",
                                     "open"):
                continue
            t = wait_fund_lock(console, tid, t, a.timeout)
            if t.get("status") == "waiting":
                log({"result": "fund-lock-timeout", "id": tid})
                continue
            # Re-check after the (up to --timeout) fund-lock wait: the
            # ticket may have funded just before its quote expired.
            action = expired_action(t, rec, time.time())
            if action:
                resolve_expired_ticket(a, console, state, t, action)
                continue
            # Claim BEFORE triggering: a crash between here and settle
            # must not lead to a second energy delivery. The tariff is
            # snapshotted into the record — settle bills at the priced
            # rate even if the daemon restarts with a different flag.
            state[tid] = {"status": "triggered", "at": int(time.time()),
                          "tariff_eur_per_kwh": a.eur_per_kwh}
            if not hasattr(a, "_tariffs"):
                a._tariffs = {}
            a._tariffs[tid] = a.eur_per_kwh
            save_state(a.state_file, state)
            quote_id = t.get("quote_id")
            code, result = deliver_energy(
                a, gateway, tid, int(t.get("amount", 0)),
                t.get("description") or "", device_map,
                session_ref=quote_id)
            rec = {"status": "settled" if code == 0 else
                   "refused" if code == 2 else "open",
                   "at": int(time.time()), "result": result["result"]}
            if code == 0 and quote_id:
                # Refund ledger entry for the deposit pattern: what the
                # melt paid vs what the session actually delivered. The
                # wallet claims the difference with a refund:<quote-id>
                # mint quote that settle_refunds validates against this.
                rec["quote_id"] = quote_id
                rec["amount_cents"] = int(t.get("amount", 0))
                rec["delivered_cents"] = result.get("delivered_cents",
                                                    int(t.get("amount", 0)))
                rec["refunded"] = False
            state[tid] = rec
            save_state(a.state_file, state)
            log(result)
        settle_refunds(a, console, state)
        time.sleep(a.poll_interval)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True,
                   help="console base URL, e.g. https://host/eur-console")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", required=True)
    p.add_argument("--code", help="6-char code from the wallet (omit with --watch)")
    p.add_argument("--watch", action="store_true",
                   help="daemon: poll open ev tickets and settle each")
    p.add_argument("--gateway", required=True,
                   help="device gateway base URL, e.g. http://127.0.0.1:8899")
    p.add_argument("--gateway-key", default="",
                   help="X-API-Key for the device gateway, if it requires one")
    p.add_argument("--device-map", default="{}",
                   help="JSON (or @file) mapping ticket destination slug -> "
                        "gateway device id; unmapped slugs pass through as-is")
    p.add_argument("--eur-per-kwh", type=float, default=100.0,
                   help="tariff: currency units per kWh of METERED energy "
                        "(the pair's unit — €, $, kr). 100 units/kWh is the "
                        "demo value: 1 unit = 36 kW·s. A real-world price "
                        "(~0.50) needs sub-unit melts first — see #30")
    p.add_argument("--max-amount", type=int, default=10000,
                   help="cents; above this the adapter abstains so a human settles")
    p.add_argument("--timeout", type=float, default=90.0,
                   help="seconds to wait for the wallet's fund lock")
    p.add_argument("--settle-grace", type=float, default=30.0,
                   help="extra seconds beyond the charge window for the "
                        "device to report done")
    p.add_argument("--poll-interval", type=float, default=3.0,
                   help="--watch: seconds between open-ticket polls")
    p.add_argument("--canonical-events", default="",
                   help="append canonical grant/progress/terminal/settle/"
                        "refund events as JSONL to this path (glossary-"
                        "aligned; empty disables)")
    p.add_argument("--state-file", default="",
                   help="--watch: JSON file of per-ticket delivery state "
                        "(crash-safe: a ticket is claimed before trigger)")
    a = p.parse_args()
    a.canonical = canonical_journal(a.canonical_events)

    raw_map = a.device_map.lstrip("@")
    if a.device_map.startswith("@"):
        with open(raw_map) as f:
            device_map = json.load(f)
    else:
        device_map = json.loads(raw_map)

    global console
    console = Console(a.base, a.user, a.password)
    gateway = Gateway(a.gateway, a.gateway_key)

    if a.watch:
        return watch(a, console, gateway, device_map)

    if not a.code:
        p.error("--code is required unless --watch")

    try:
        t = console.post("/api/quotes/match", {"code": a.code})
    except urllib.error.HTTPError as e:
        log({"result": "api-error", "path": e.url, "status": e.code})
        return 4
    except urllib.error.URLError as e:
        log({"result": "api-error", "stage": "transport",
             "error": str(e.reason)})
        return 4

    if not t.get("id"):
        log({"result": "match-failed", "code": a.code})
        return 4
    tid, amount = t["id"], int(t.get("amount", 0))
    slug = t.get("description")

    if t.get("payout_rail") != RAIL:
        log({"result": "wrong-rail", "id": tid,
             "ticket_rail": t.get("payout_rail"), "adapter_rail": RAIL})
        return 5

    if amount > a.max_amount:
        log({"result": "refused", "id": tid, "amount": amount,
             "destination": slug,
             "reason": f"amount {amount} exceeds adapter max {a.max_amount}"})
        return 2

    deadline = time.time() + a.timeout
    while t.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        t = console.post("/api/quotes/match", {"code": a.code})
    if t.get("status") == "waiting":
        log({"result": "fund-lock-timeout", "id": tid})
        return 3

    if not hasattr(a, "_tariffs"):
        a._tariffs = {}
    a._tariffs[tid] = a.eur_per_kwh
    code, result = deliver_energy(a, gateway, tid, amount, slug or "",
                                  device_map)
    log(result)
    return code


console = None  # set in main(); deliver_energy marks paid through it


if __name__ == "__main__":
    sys.exit(main())
