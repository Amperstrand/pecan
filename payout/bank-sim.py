#!/usr/bin/env python3
"""bank-sim — simulated fiat payout rails for the pecan payout architecture.

Rail semantics lifted from real public schemes and the pleBank bill-payment
model: each rail below is a simulated adapter over the standard payout-module
loop, addressed by its own destination format and confirmed with the receipt
reference that scheme actually issues — the payout-proof analogue of a
Lightning preimage (revealed only at settlement, verifiable against the
rail's records). The receipt lands on the ticket and flows back to the
wallet as the melt's payment proof.

Rails:
  sepa          SEPA Credit Transfer. IBAN (mod-97 checked).
                Receipt: EndToEndId-style E2E-YYMMDD-XXXXXXXX.
  sepa-instant  SEPA Instant Credit Transfer. IBAN, no batch delay.
                Receipt: UETR (RFC 4122 UUID — the instant scheme id).
  swish         Nordic bank-app rail. Destination: Swedish MSISDN/alias.
                Receipt: Swish-style payment reference (UUID, no dashes).
  mobilepay     Nordic mobile wallet. Destination: DK/FI MSISDN.
                Receipt: transaction id (MP-XXXXXXXXXX).
  ideal         Dutch instant bank rail. Destination: NL IBAN.
                Receipt: transaction id (16 digits).
  bizum         Spanish mobile rail. Destination: ES MSISDN.
                Receipt: operation reference (BZ + 10 digits).

Adapter contract (docs/payout-modules.md): claim only tickets whose
payout_rail is in this registry, validate the destination before acting,
abstain (never void) on policy refusals, never act before the fund lock.

Usage:
  python3 bank-sim.py --base https://host/eur-console \
      --user admin --password "$PW" --code ABC123 [--rail sepa]

Exit codes: 0 settled · 2 refusal (cap / invalid destination) ·
3 fund-lock timeout · 4 API error · 5 wrong rail. One JSON line on stdout.
"""
import argparse
import http.cookiejar
import json
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid

MSISDN = re.compile(r"\+\d{6,15}")


def msisdn(*country_prefixes: str) -> callable:
    """Destination validator: E.164 within the given country prefixes."""
    def check(raw: str) -> bool:
        if not MSISDN.fullmatch(raw):
            return False
        return raw.startswith(country_prefixes)
    return check


RAILS = {
    "sepa": {
        "valid": lambda d: valid_iban_pub(d),
        "settle_delay": 1.5,
        "receipt": lambda: "E2E-{}-{}".format(
            time.strftime("%y%m%d"), secrets.token_hex(4).upper()
        ),
        "label": "SEPA credit transfer",
    },
    "sepa-instant": {
        "valid": lambda d: valid_iban_pub(d),
        "settle_delay": 0.2,
        "receipt": lambda: str(uuid.uuid4()),
        "label": "SEPA instant credit transfer",
    },
    "swish": {
        "valid": msisdn("+46"),
        "settle_delay": 0.5,
        "receipt": lambda: uuid.uuid4().hex,
        "label": "Swish transfer",
    },
    "mobilepay": {
        "valid": msisdn("+45", "+358"),
        "settle_delay": 0.5,
        "receipt": lambda: "MP-{}".format(
            "".join(secrets.choice("0123456789") for _ in range(10))
        ),
        "label": "MobilePay transfer",
    },
    "ideal": {
        "valid": lambda d: valid_iban_pub(d) and d.replace(" ", "").upper().startswith("NL"),
        "settle_delay": 1.0,
        "receipt": lambda: "".join(
            secrets.choice("0123456789") for _ in range(16)
        ),
        "label": "iDEAL transfer",
    },
    "bizum": {
        "valid": msisdn("+34"),
        "settle_delay": 0.5,
        "receipt": lambda: "BZ{}".format(
            "".join(secrets.choice("0123456789") for _ in range(10))
        ),
        "label": "Bizum transfer",
    },
}

IBAN_RE = re.compile(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}")


def valid_iban_pub(raw: str) -> bool:
    """ISO 13616 mod-97 check (ISO 7064 MOD 97-10)."""
    iban = raw.replace(" ", "").upper()
    if not IBAN_RE.fullmatch(iban):
        return False
    rearranged = iban[4:] + iban[:4]
    digits = "".join(str(int(ch, 36)) for ch in rearranged)
    return int(digits) % 97 == 1


valid_iban = valid_iban_pub


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True,
                   help="console base URL, e.g. https://host/eur-console")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", required=True)
    p.add_argument("--code", required=True, help="6-char code from the wallet")
    p.add_argument("--rail", choices=sorted(RAILS),
                   help="claim only this rail (default: any rail in the registry)")
    p.add_argument("--max-amount", type=int, default=5000,
                   help="cents; above this the adapter abstains so a human can settle")
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
    rail = t.get("payout_rail")

    claimable = sorted(RAILS) if a.rail is None else [a.rail]
    if rail not in claimable:
        # Not ours to fulfill — a plain teller ticket, the sim rail, or
        # another adapter's. Acting here is the routing bug the payout
        # rail envelope exists to prevent.
        return emit({"result": "wrong-rail", "id": tid,
                     "ticket_rail": rail, "adapter_rails": claimable}, 5)

    if not RAILS[rail]["valid"](destination or ""):
        return emit({"result": "refused", "id": tid, "rail": rail,
                     "destination": destination,
                     "reason": f"destination is not valid for rail {rail}"}, 2)

    if amount > a.max_amount:
        return emit({"result": "refused", "id": tid, "rail": rail,
                     "amount": amount,
                     "reason": f"amount {amount} exceeds adapter max {a.max_amount}"}, 2)

    deadline = time.time() + a.timeout
    while t.get("status") == "waiting" and time.time() < deadline:
        time.sleep(1.0)
        t = post("/api/quotes/match", {"code": a.code})
    if t.get("status") == "waiting":
        return emit({"result": "fund-lock-timeout", "id": tid}, 3)

    # Transfer step — simulated. This is where a real rail adapter would
    # submit the payment and capture the rail's receipt reference.
    time.sleep(RAILS[rail]["settle_delay"])
    receipt = RAILS[rail]["receipt"]()

    notes = (f"payout rail {rail} (simulated {RAILS[rail]['label']}) "
             f"receipt={receipt} destination={destination}")
    try:
        post(f"/api/tickets/{tid}/mark-paid", {"notes": notes, "receipt": receipt})
    except urllib.error.HTTPError as e:
        return emit({"result": "api-error", "id": tid,
                     "stage": "mark-paid", "status": e.code}, 4)
    except urllib.error.URLError as e:
        return emit({"result": "api-error", "id": tid,
                     "stage": "mark-paid-transport",
                     "error": str(e.reason)}, 4)
    return emit({"result": "settled", "id": tid, "rail": rail,
                 "destination": destination, "receipt": receipt,
                 "amount": amount, "unit": t.get("unit"),
                 "status": "paid"}, 0)


if __name__ == "__main__":
    sys.exit(main())
