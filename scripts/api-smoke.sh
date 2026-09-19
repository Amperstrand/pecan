#!/bin/sh
# Read-only HTTP invariants against prod — the cheap tier between unit
# tests and the browser e2e. Answers "is the deployment healthy and are
# the core invariants intact" in seconds, with no browser, no wallet
# state, and no sats: use it before any e2e cycle and after any deploy.
# Every check prints one ok/FAIL line; exit is non-zero on any failure.
# Usage: scripts/api-smoke.sh
set -u
. "$(dirname "$0")/pairs.sh"
URL=${PECAN_URL:-https://giftcard.cashu.exchange}
fail=0

code() { curl -sk -o /dev/null -m 10 -w "%{http_code}" "$1"; }

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 ($3)"
  else
    echo "  FAIL $1 — expected $2, got $3"
    fail=$((fail + 1))
  fi
}

# Every pair from the manifest — a pair missing here is a pair the
# post-deploy health gate silently ignores (NOK was, 2026-09-14→15).
for pair in $PAIRS; do
  echo "== $pair pair =="

  k=$(code "$URL/$pair/v1/keys")
  check "mint /v1/keys" 200 "$k"
  if [ "$k" = "200" ]; then
    n=$(curl -sk -m 10 "$URL/$pair/v1/keys" | python3 -c \
      'import json,sys; d=json.load(sys.stdin); print(len(d.get("keysets",[])))' 2>/dev/null || echo 0)
    check "mint keysets present" yes "$([ "$n" -gt 0 ] 2>/dev/null && echo yes || echo no)"
  fi

  check "mint /v1/info" 200 "$(code "$URL/$pair/v1/info")"
  check "console /healthz" 200 "$(code "$URL/$pair-console/healthz")"

  # One-way mint: ln/btc melt quotes must be refused — state-free 4xx.
  for rail in ln btc; do
    status=$(curl -sk -m 10 -o /dev/null -w "%{http_code}" \
      -X POST "$URL/$pair/v1/melt/quote/$rail" \
      -H "Content-Type: application/json" \
      -d "{\"unit\": \"$pair\", \"amount\": 500, \"request\": \"lntbs1test\", \"rail\": \"$rail\"}")
    if [ "$status" -ge 400 ] 2>/dev/null; then
      echo "  ok   melt/$rail refused ($status)"
    else
      echo "  FAIL melt/$rail — expected 4xx, got $status"
      fail=$((fail + 1))
    fi
  done

  # Payout-rail gate: an envelope naming a rail the deployment does not
  # operate must refuse at quote time — state-free, no ticket can exist.
  status=$(curl -sk -m 10 -o /dev/null -w "%{http_code}" \
    -X POST "$URL/$pair/v1/melt/quote/branch" \
    -H "Content-Type: application/json" \
    -d "{\"unit\": \"$pair\", \"amount\": 500, \"request\": \"nonexistent-probe:x\", \"method\": \"branch\"}")
  if [ "$status" -ge 400 ] 2>/dev/null; then
    echo "  ok   unoperated payout rail refused ($status)"
  else
    echo "  FAIL unoperated payout rail — expected 4xx, got $status"
    fail=$((fail + 1))
  fi

  check "wallet SPA served" 200 "$(code "$URL/$pair-console/wallet")"
  ct=$(curl -sk -m 10 -o /dev/null -w "%{http_code} %{content_type}" \
    "$URL/$pair-console/manifest.webmanifest")
  check "manifest served" "200 application/manifest+json" "$ct"
done

# Farm pair extras (NUT-32 spike): capability advert, series oracle,
# content-addressed terms immutability.
echo "== farm futures (NUT-32) =="
if curl -sk -m 10 "$URL/farm/v1/info" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("nuts", {}).get("32", {}).get("supported") else 1)
' 2>/dev/null; then
  echo "  ok   NUT-32 advertised by the farm mint"
else
  echo "  FAIL NUT-32 capability missing from /farm/v1/info"
  fail=$((fail + 1))
fi

FARM_SERIES=$(curl -sk -m 10 "$URL/farm-console/api/farm")
if echo "$FARM_SERIES" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
s = d.get("series", [])
sys.exit(0 if s and all(x.get("unit", "").startswith("future:") for x in s[:3]) else 1)
' 2>/dev/null; then
  echo "  ok   farm series served with future units"
else
  echo "  FAIL farm overview missing or units are not future:*"
  fail=$((fail + 1))
fi

TERMS_URI=$(echo "$FARM_SERIES" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d["series"][0]["terms_uri"])' 2>/dev/null || echo "")
if [ -n "$TERMS_URI" ]; then
  t1=$(curl -sk -m 10 "$TERMS_URI")
  t2=$(curl -sk -m 10 "$TERMS_URI")
  if [ -n "$t1" ] && [ "$t1" = "$t2" ]; then
    echo "  ok   terms blob serves identical bytes (content-addressed)"
  else
    echo "  FAIL terms blob unstable at $TERMS_URI"
    fail=$((fail + 1))
  fi
else
  echo "  FAIL no terms URI in the farm overview"
  fail=$((fail + 1))
fi

echo "== cross-pair =="

check "metrics need auth" 401 "$(code "$URL/ops/metrics/eur")"
check "ops page served" 200 "$(code "$URL/ops/")"

# The sat pair rides on an EXTERNAL mint — a dead signut must surface
# here, not as a mystery wallet failure hours later.
SIGNUT_INFO=$(curl -s -m 10 https://signut.cashu.exchange/v1/info)
if echo "$SIGNUT_INFO" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
m = [x for x in d.get("nuts", {}).get("4", {}).get("methods", [])
     if x.get("unit") == "sat"]
sys.exit(0 if m else 1)
' 2>/dev/null; then
  echo "  ok   signut reachable, sat minting live"
else
  echo "  FAIL signut unreachable or sat unit missing — the SAT wallet tab is degraded"
  fail=$((fail + 1))
fi

if curl -sk -m 10 "$URL/ops/reconcile-status.json" | \
  python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("drift") == 0 else 1)' 2>/dev/null; then
  echo "  ok   reconcile clean"
else
  echo "  FAIL reconcile drift (or status unreadable) — /var/log/pecan-reconcile.log"
  fail=$((fail + 1))
fi

# The wallet bundle must still be OURS: a concurrent deployer on the
# network has reverted it to stale/farm-less builds twice (2026-09-17,
# 2026-09-19 14:12 UTC). Catch it loudly instead of debugging ghosts.
JS=$(curl -s -m 10 "$URL/wallet" | grep -oE 'assets/index-[^"]*\.js' | head -1)
if [ -n "$JS" ] && curl -s -m 10 "$URL/$JS" | grep -q "Transfer ownership"; then
  echo "  ok   wallet bundle carries the farm panel"
else
  echo "  FAIL wallet bundle lacks the farm panel — concurrent deployer reverted it? (deploy/Caddyfile.giftcard is the routing reference)" >&2
  fail=$((fail + 1))
fi

if [ "$fail" -eq 0 ]; then
  echo "API-SMOKE VERDICT: PASS"
  exit 0
fi
echo "API-SMOKE VERDICT: FAIL ($fail check(s))"
exit 1
