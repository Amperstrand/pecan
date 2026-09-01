#!/usr/bin/env python3
"""sim-teller — reference automated payout module for the pecan mint.

Payout fulfillment is pluggable over the teller API: match the code the
wallet displays, wait for the wallet's fund lock, run the module's payout
action, then mark the ticket paid. This module SIMULATES a transfer to the
phone recipient on the ticket (a configurable delay) — swap that step for a
real mobile-payment transfer and the rest of the loop is unchanged.

Usage:
  python3 sim-teller.py --base https://giftcard.cashu.exchange/eur-console \
      --user admin --password "$PW" --code ABC123

Exit codes: 0 settled · 2 policy refusal (no action taken) ·
3 fund-lock timeout (no action taken) · 4 API error.
Prints exactly one JSON line on stdout.
"""
import argparse
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True,
                   help="console base URL, e.g. https://host/eur-console")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", required=True)
    p.add_argument("--code", required=True, help="6-char teller code from the wallet")
    p.add_argument("--max-amount", type=int, default=5000,
                   help="cents; above this the module abstains so a human can settle")
    p.add_argument("--settle-delay", type=float, default=1.0,
                   help="simulated transfer duration in seconds")
    p.add_argument("--timeout", type=float, default=90.0,
                   help="seconds to wait for the wallet's fund lock")
    p.add_argument("--notes", default="phone payout (simulated)")
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
    recipient = t.get("description")

    if amount > a.max_amount:
        # Abstain WITHOUT acting on the ticket: a human teller can still
        # settle it from the console.
        return emit({"result": "refused", "id": tid, "amount": amount,
                     "recipient": recipient,
                     "reason": f"amount {amount} exceeds module max {a.max_amount}"}, 2)

    deadline = time.time() + a.timeout
    while t.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        t = post("/api/quotes/match", {"code": a.code})
    if t.get("status") == "waiting":
        return emit({"result": "fund-lock-timeout", "id": tid}, 3)

    # Payout action: a transfer to the recipient's phone. Simulated here.
    time.sleep(a.settle_delay)

    try:
        post(f"/api/tickets/{tid}/mark-paid", {"notes": a.notes})
    except urllib.error.HTTPError as e:
        return emit({"result": "api-error", "id": tid,
                     "stage": "mark-paid", "status": e.code}, 4)
    except urllib.error.URLError as e:
        return emit({"result": "api-error", "id": tid,
                     "stage": "mark-paid-transport",
                     "error": str(e.reason)}, 4)
    return emit({"result": "settled", "id": tid, "amount": amount,
                 "recipient": recipient,
                 "unit": t.get("unit"), "status": "paid"}, 0)


if __name__ == "__main__":
    sys.exit(main())
