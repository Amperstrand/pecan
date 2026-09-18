#!/usr/bin/env bash
# Runs ON inr2 (timer: farm-autopay.timer, 60s). The farm demo's
# "it just pays" behavior: self-pay every PENDING (authorized) purchase
# invoice on the ISSUING node (the mint's own CLN) — local settle, no
# routing, no channel dependency. Expired purchases are left for the
# processor's own expiry sweep.
#
# Demo-sized purchases only (FARM_AUTOPAY_MAX_EGGS, default 20): a
# capacity-test grab or any accident must NOT be paid into the 24h
# paid-claim window — that once "sold out" a whole day.
set -u
STATE=/opt/pecan-farm-data/farm.json
MAX_EGGS="${FARM_AUTOPAY_MAX_EGGS:-20}"
[ -f "$STATE" ] || exit 0
exec python3 - "$STATE" "$MAX_EGGS" <<'PY'
import json, subprocess, sys, time

state = json.load(open(sys.argv[1]))
max_eggs = int(sys.argv[2])
purchases = state.get("purchases", {})
items = purchases.items() if isinstance(purchases, dict) else [("", p) for p in purchases]
now = time.time()
for pid, v in items:
    # Open = invoice issued, waiting for signet payment; that is the
    # payable state (authorized/paid = already settled).
    if v.get("state") != "open":
        continue
    if v.get("quantity", 0) > max_eggs:
        continue
    if v.get("invoice_expires_at", 0) < now:
        continue
    inv = v.get("bolt11", "")
    if not inv.startswith("lntb"):
        continue
    r = subprocess.run(
        ["docker", "exec", "cln-swap-signet",
         "lightning-cli", "--network=signet", "pay", inv],
        capture_output=True, text=True, timeout=60)
    out = r.stdout + r.stderr
    if "payment_preimage" in out:
        print(f"farm-autopay: paid {pid} ({inv[:20]}...)", flush=True)
    elif "doesn't know invoice" in out or "Already paid" in out or "WIRE_INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS" in out:
        # Settled earlier (manual pay or a prior tick) — the mint's own
        # poll marks it paid; not an error.
        print(f"farm-autopay: already settled {pid}", flush=True)
    else:
        msg = next((l for l in out.splitlines() if "message" in l), out.splitlines()[:1])
        print(f"farm-autopay: FAILED {pid}: {msg}", flush=True)
PY
