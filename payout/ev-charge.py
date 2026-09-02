#!/usr/bin/env python3
"""ev-charge — the EV charging payout-rail adapter (prototype).

A melt destination written as `ev:<device-slug>` buys a charge window on
that charger: the ecash is locked (burned inputs, held by the mint) before
any energy flows, the charger runs for a tariff-derived window, and the
settled ticket's receipt is the session record — the OCPP analogue is
exact (StartTransaction's meterStart → MeterValues → StopTransaction's
meterStop; here the window IS the metered energy on the demo fleet).

Device gateway contract (any backend may implement it; the atom bridge
maps it onto hermes/MQTT, ev-device-fake.py implements it for testing):

  POST /device/{id}/trigger  {"seconds": N}   X-API-Key: <key>
       -> 200 {"triggered": true, "session": "<id>"}   energy starts
       -> 4xx {"triggered": false, "reason": "..."}    device refused
  GET  /device/{id}/status
       -> 200 {"state": "idle"|"running"|"done", "session": "<id>",
               "seconds": N}

Usage:
  python3 ev-charge.py --base https://host/eur-console \
      --password "$PW" --code ABC123 \
      --gateway http://127.0.0.1:8899 --secs-per-eur 25

Exit codes: 0 settled · 2 policy refusal · 3 fund-lock timeout ·
4 API error · 5 wrong rail · 6 device timeout (ticket left open — a
human can still settle it). Prints exactly one JSON line on stdout.
"""
import argparse
import http.cookiejar
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

RAIL = "ev"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True,
                   help="console base URL, e.g. https://host/eur-console")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", required=True)
    p.add_argument("--code", required=True, help="6-char code from the wallet")
    p.add_argument("--gateway", required=True,
                   help="device gateway base URL, e.g. http://127.0.0.1:8899")
    p.add_argument("--gateway-key", default="",
                   help="X-API-Key for the device gateway, if it requires one")
    p.add_argument("--device-map", default="{}",
                   help="JSON (or @file) mapping ticket destination slug -> "
                        "gateway device id; unmapped slugs pass through as-is")
    p.add_argument("--secs-per-eur", type=float, default=25.0,
                   help="tariff: seconds of charge per euro (demo fleet: "
                        "25s windows, one per euro)")
    p.add_argument("--max-amount", type=int, default=10000,
                   help="cents; above this the adapter abstains so a human settles")
    p.add_argument("--timeout", type=float, default=90.0,
                   help="seconds to wait for the wallet's fund lock")
    p.add_argument("--settle-grace", type=float, default=30.0,
                   help="extra seconds beyond the charge window for the "
                        "device to report done")
    a = p.parse_args()

    raw_map = a.device_map.lstrip("@")
    if a.device_map.startswith("@"):
        with open(raw_map) as f:
            device_map = json.load(f)
    else:
        device_map = json.loads(raw_map)

    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def post(path: str, payload: dict, base: str = "", key: str = "") -> dict:
        headers = {"Content-Type": "application/json"}
        if key:
            headers["X-API-Key"] = key
        req = urllib.request.Request(
            (base or a.base) + path,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        with op.open(req, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}

    def get(path: str, base: str = "", key: str = "") -> dict:
        req = urllib.request.Request((base or a.base) + path)
        if key:
            req.add_header("X-API-Key", key)
        with op.open(req, timeout=30) as r:
            return json.loads(r.read().decode())

    def emit(obj: dict, code: int) -> int:
        print(json.dumps(obj))
        return code

    try:
        post("/api/login", {"username": a.user, "password": a.password})
        t = post("/api/quotes/match", {"code": a.code})
    except urllib.error.HTTPError as e:
        return emit({"result": "api-error", "path": e.url,
                     "status": e.code}, 4)
    except urllib.error.URLError as e:
        return emit({"result": "api-error", "stage": "transport",
                     "error": str(e.reason)}, 4)

    if not t.get("id"):
        return emit({"result": "match-failed", "code": a.code}, 4)
    tid, amount = t["id"], t.get("amount", 0)
    slug = t.get("description")
    ticket_rail = t.get("payout_rail")

    if ticket_rail != RAIL:
        return emit({"result": "wrong-rail", "id": tid,
                     "ticket_rail": ticket_rail, "adapter_rail": RAIL}, 5)

    if amount > a.max_amount:
        return emit({"result": "refused", "id": tid, "amount": amount,
                     "destination": slug,
                     "reason": f"amount {amount} exceeds adapter max {a.max_amount}"}, 2)

    deadline = time.time() + a.timeout
    while t.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        t = post("/api/quotes/match", {"code": a.code})
    if t.get("status") == "waiting":
        return emit({"result": "fund-lock-timeout", "id": tid}, 3)

    # Energy step — the only rail-specific part. The tariff converts the
    # melted cents into a charge window; the device owns the metering
    # contract (relay seconds today, real Wh when a meter exists).
    device = device_map.get(slug, slug)
    seconds = max(1, round(amount / 100.0 * a.secs_per_eur))
    try:
        trig = post(f"/device/{device}/trigger", {"seconds": seconds},
                    base=a.gateway, key=a.gateway_key)
    except urllib.error.HTTPError as e:
        return emit({"result": "refused", "id": tid, "destination": slug,
                     "device": device, "seconds": seconds,
                     "reason": f"device gateway rejected: {e.code}"}, 2)
    except urllib.error.URLError as e:
        return emit({"result": "refused", "id": tid, "destination": slug,
                     "device": device,
                     "reason": f"device gateway unreachable: {e.reason}"}, 2)
    if not trig.get("triggered"):
        return emit({"result": "refused", "id": tid, "destination": slug,
                     "device": device, "seconds": seconds,
                     "reason": trig.get("reason", "trigger declined")}, 2)

    done_by = time.time() + seconds + a.settle_grace
    state = None
    while time.time() < done_by:
        try:
            state = get(f"/device/{device}/status",
                        base=a.gateway, key=a.gateway_key)
        except (urllib.error.URLError, urllib.error.HTTPError):
            state = None  # transient poll failure — keep waiting
        if state and state.get("state") == "done":
            break
        time.sleep(1.0)
    if not (state and state.get("state") == "done"):
        # The window ran but the device never confirmed; the ticket stays
        # open for an operator decision — do NOT auto-settle on doubt.
        return emit({"result": "device-timeout", "id": tid,
                     "destination": slug, "device": device,
                     "seconds": seconds}, 6)

    receipt = "EV-{}-{}s-{}".format(device, seconds,
                                    secrets.token_hex(4).upper())
    notes = f"payout rail {RAIL} (charge session) receipt={receipt}"
    try:
        post(f"/api/tickets/{tid}/mark-paid", {"notes": notes, "receipt": receipt})
    except urllib.error.HTTPError as e:
        return emit({"result": "api-error", "id": tid,
                     "stage": "mark-paid", "status": e.code}, 4)
    except urllib.error.URLError as e:
        return emit({"result": "api-error", "id": tid,
                     "stage": "mark-paid-transport",
                     "error": str(e.reason)}, 4)
    return emit({"result": "settled", "id": tid, "rail": RAIL,
                 "amount": amount, "destination": slug, "device": device,
                 "seconds": seconds, "receipt": receipt,
                 "unit": t.get("unit"), "status": "paid"}, 0)


if __name__ == "__main__":
    sys.exit(main())
