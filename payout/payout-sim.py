#!/usr/bin/env python3
"""payout-sim — the generic sample payout-rail adapter.

Payout rails are pluggable: a melt destination written as `rail:destination`
routes the ticket to the adapter for that rail, and a deployment enables the
subset it operates (CDK_BRANCH_PROCESSOR_PAYOUT_RAILS on the processor).
This module is the reference adapter for the synthetic `sim` rail — replace
its transfer step with a real backend call (bank API, mobile payment
provider, wire service) and the loop is unchanged. Adapter contract:

  * claim ONLY tickets whose payout_rail is yours (wrong rail -> exit 5,
    no action taken);
  * abstain above your amount cap (exit 2, no action) so a human settles;
  * never act before the wallet's fund lock (mark-paid enforces it
    server-side, but waiting here avoids guaranteed refusals).

Usage:
  python3 payout-sim.py --base https://host/eur-console \
      --user admin --password "$PW" --code ABC123

Exit codes: 0 settled · 2 policy refusal · 3 fund-lock timeout ·
4 API error · 5 wrong rail. Prints exactly one JSON line on stdout.
"""
import argparse
import http.cookiejar
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

RAIL = "sim"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True,
                   help="console base URL, e.g. https://host/eur-console")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", required=True)
    p.add_argument("--code", required=True, help="6-char code from the wallet")
    p.add_argument("--max-amount", type=int, default=5000,
                   help="cents; above this the adapter abstains so a human can settle")
    p.add_argument("--settle-delay", type=float, default=1.0,
                   help="simulated transfer duration in seconds")
    p.add_argument("--timeout", type=float, default=90.0,
                   help="seconds to wait for the wallet's fund lock")
    a = p.parse_args()

    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def post(path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            a.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with op.open(req, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}

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
    destination = t.get("description")
    ticket_rail = t.get("payout_rail")

    if ticket_rail != RAIL:
        # Not ours to fulfill — a plain teller ticket or another adapter's
        # rail. Acting here would be exactly the routing bug the rail
        # envelope exists to prevent.
        return emit({"result": "wrong-rail", "id": tid,
                     "ticket_rail": ticket_rail, "adapter_rail": RAIL}, 5)

    if amount > a.max_amount:
        return emit({"result": "refused", "id": tid, "amount": amount,
                     "destination": destination,
                     "reason": f"amount {amount} exceeds adapter max {a.max_amount}"}, 2)

    deadline = time.time() + a.timeout
    while t.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        t = post("/api/quotes/match", {"code": a.code})
    if t.get("status") == "waiting":
        return emit({"result": "fund-lock-timeout", "id": tid}, 3)

    # Transfer step: this is the only rail-specific part. Simulated here.
    time.sleep(a.settle_delay)
    receipt = "SIM-{}".format(secrets.token_hex(4).upper())

    notes = f"payout rail {RAIL} (simulated transfer) receipt={receipt}"
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
                 "amount": amount, "destination": destination,
                 "receipt": receipt,
                 "unit": t.get("unit"), "status": "paid"}, 0)


if __name__ == "__main__":
    sys.exit(main())
