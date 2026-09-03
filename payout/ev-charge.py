#!/usr/bin/env python3
"""ev-charge — the EV charging payout-rail adapter.

A melt destination written as `ev:<device-slug>` buys a charge window on
that charger: the ecash is locked (burned inputs, held by the mint) before
any energy flows, the charger runs a tariff-derived window, and the
settled ticket's receipt is the session record — the OCPP analogue is
exact (StartTransaction's meterStart → MeterValues → StopTransaction's
meterStop; here the window IS the metered energy on the demo fleet).

Two modes:

  single-shot (default): --code ABC123 settles one wallet melt. Used by
    operators and the e2e suite.

  --watch: daemon mode — poll GET /api/tickets/open?rail=ev on the
    console, settle each new ticket as it appears. This is the self-serve
    demo path: a customer melts `ev:atomA` in the wallet and the charger
    fires with nobody running anything. A state file records every
    triggered ticket so a restart never double-delivers energy: a ticket
    marked triggered-but-unsettled is left for an operator, never
    re-triggered.

Device gateway contract (any backend may implement it; evmap's
atom-gateway implements it over HiveMQ, ev-device-fake.py for tests):

  POST /device/{id}/trigger  {"seconds": N}   X-API-Key: <key>
       -> 200 {"triggered": true, "session": "<id>"}   energy starts
       -> 4xx {"triggered": false, "reason": "..."}    device refused
  GET  /device/{id}/status
       -> 200 {"state": "idle"|"running"|"done", "session": "<id>",
               "seconds": N}

Usage:
  python3 ev-charge.py --base https://host/eur-console \
      --password "$PW" --code ABC123 \
      --gateway http://127.0.0.1:8899 --secs-per-eur 1

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

RAIL = "ev"


class Console:
    def __init__(self, base: str, user: str, password: str):
        self.base = base
        jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar))
        self.post("/api/login", {"username": user, "password": password})

    def post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.op.open(req, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}

    def get(self, path: str) -> dict:
        with self.op.open(self.base + path, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}

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

    def trigger(self, device: str, seconds: int) -> dict:
        return self._req("POST", f"/device/{device}/trigger",
                         {"seconds": seconds})

    def status(self, device: str) -> dict:
        return self._req("GET", f"/device/{device}/status")


def log(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def deliver_energy(a, gateway: Gateway, tid: str, amount: int,
                   slug: str, device_map: dict) -> tuple:
    """Trigger the charger, await the window, mark the ticket paid.

    Returns (exit_code, result). Never called before the wallet's fund
    lock, and never twice for one ticket (the daemon's state file guards
    that; single-shot runs once by construction).
    """
    device = device_map.get(slug, slug)
    seconds = max(1, round(amount / 100.0 * a.secs_per_eur))
    try:
        trig = gateway.trigger(device, seconds)
    except urllib.error.HTTPError as e:
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device, "seconds": seconds,
                   "reason": f"device gateway rejected: {e.code}"}
    except urllib.error.URLError as e:
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device,
                   "reason": f"device gateway unreachable: {e.reason}"}
    if not trig.get("triggered"):
        return 2, {"result": "refused", "id": tid, "destination": slug,
                   "device": device, "seconds": seconds,
                   "reason": trig.get("reason", "trigger declined")}

    done_by = time.time() + seconds + a.settle_grace
    state = None
    while time.time() < done_by:
        try:
            state = gateway.status(device)
        except (urllib.error.URLError, urllib.error.HTTPError):
            state = None  # transient poll failure — keep waiting
        if state and state.get("state") == "done":
            break
        time.sleep(1.0)
    if not (state and state.get("state") == "done"):
        # The window ran but the device never confirmed; the ticket stays
        # open for an operator decision — do NOT auto-settle on doubt.
        return 6, {"result": "device-timeout", "id": tid,
                   "destination": slug, "device": device,
                   "seconds": seconds}

    # The device's stop button aborts mid-window: delivered < requested
    # and the status carries stopped=true. The receipt states the
    # delivered seconds and ends with STOPPED — the wallet's stream
    # reads that and stops melting further chunks. `delivered` settles
    # the melt for what was actually used: the mint returns the
    # difference to the wallet's change outputs (design C).
    delivered = int(state.get("seconds", seconds))
    was_stopped = bool(state.get("stopped"))
    suffix = "-STOPPED" if was_stopped else ""
    receipt = "EV-{}-{}s-{}{}".format(device, delivered,
                                      secrets.token_hex(4).upper(), suffix)
    cents = max(1, round(delivered * 100.0 / a.secs_per_eur))

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
    return 0, {"result": "settled", "id": tid, "rail": RAIL,
               "amount": amount, "destination": slug, "device": device,
               "seconds": delivered, "stopped": was_stopped,
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


def wait_fund_lock(console, tid, ticket, timeout):
    """Poll the open-tickets list until our ticket leaves `waiting`."""
    deadline = time.time() + timeout
    while ticket.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        by_id = {t.get("id"): t for t in console.open_tickets()}
        ticket = by_id.get(tid, ticket)
    return ticket


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
            # Every post-trigger state is terminal for the daemon: energy
            # may have flowed, so a ticket is triggered AT MOST once per
            # state file, whatever happened after.
            if rec.get("status") in ("triggered", "settled", "refused",
                                     "open"):
                continue
            # Never trigger energy for a quote that is about to expire —
            # an unpayable ticket means the window cannot be settled and
            # the customer's ecash burns (reconcile DRIFT).
            expires = t.get("expires_at")
            if expires and time.time() > float(expires) - 5:
                state[tid] = {"status": "open", "at": int(time.time()),
                              "result": "expired-before-trigger"}
                save_state(a.state_file, state)
                log({"result": "operator-needed", "id": tid,
                     "reason": "quote expired before the charger could fire; settle or write off manually"})
                continue
            t = wait_fund_lock(console, tid, t, a.timeout)
            if t.get("status") == "waiting":
                log({"result": "fund-lock-timeout", "id": tid})
                continue
            expires = t.get("expires_at")
            if expires and time.time() > float(expires) - 5:
                state[tid] = {"status": "open", "at": int(time.time()),
                              "result": "expired-before-trigger"}
                save_state(a.state_file, state)
                log({"result": "operator-needed", "id": tid,
                     "reason": "quote expired while waiting for the fund lock"})
                continue
            # Claim BEFORE triggering: a crash between here and settle
            # must not lead to a second energy delivery.
            state[tid] = {"status": "triggered", "at": int(time.time())}
            save_state(a.state_file, state)
            code, result = deliver_energy(
                a, gateway, tid, int(t.get("amount", 0)),
                t.get("description") or "", device_map)
            state[tid] = {"status": "settled" if code == 0 else
                          "refused" if code == 2 else "open",
                          "at": int(time.time()), "result": result["result"]}
            save_state(a.state_file, state)
            log(result)
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
    p.add_argument("--secs-per-eur", type=float, default=1.0,
                   help="tariff: seconds of charge per euro. The demo fleet "
                        "delivers 1 kW, so 1 s/EUR is the 1 €/kW · 1 kW/s "
                        "demo pricing")
    p.add_argument("--max-amount", type=int, default=10000,
                   help="cents; above this the adapter abstains so a human settles")
    p.add_argument("--timeout", type=float, default=90.0,
                   help="seconds to wait for the wallet's fund lock")
    p.add_argument("--settle-grace", type=float, default=30.0,
                   help="extra seconds beyond the charge window for the "
                        "device to report done")
    p.add_argument("--poll-interval", type=float, default=3.0,
                   help="--watch: seconds between open-ticket polls")
    p.add_argument("--state-file", default="",
                   help="--watch: JSON file of per-ticket delivery state "
                        "(crash-safe: a ticket is claimed before trigger)")
    a = p.parse_args()

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

    code, result = deliver_energy(a, gateway, tid, amount, slug or "",
                                  device_map)
    log(result)
    return code


console = None  # set in main(); deliver_energy marks paid through it


if __name__ == "__main__":
    sys.exit(main())
