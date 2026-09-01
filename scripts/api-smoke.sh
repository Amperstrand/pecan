#!/bin/sh
# Read-only HTTP invariants against prod — the cheap tier between unit
# tests and the browser e2e. Answers "is the deployment healthy and are
# the core invariants intact" in seconds, with no browser, no wallet
# state, and no sats: use it before any e2e cycle and after any deploy.
# Every check prints one ok/FAIL line; exit is non-zero on any failure.
# Usage: scripts/api-smoke.sh
set -u
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

for pair in eur usd; do
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

  check "wallet SPA served" 200 "$(code "$URL/$pair-console/wallet")"
  ct=$(curl -sk -m 10 -o /dev/null -w "%{http_code} %{content_type}" \
    "$URL/$pair-console/manifest.webmanifest")
  check "manifest served" "200 application/manifest+json" "$ct"
done

echo "== cross-pair =="

check "metrics need auth" 401 "$(code "$URL/ops/metrics/eur")"
check "ops page served" 200 "$(code "$URL/ops/")"

if curl -sk -m 10 "$URL/ops/reconcile-status.json" | \
  python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("drift") == 0 else 1)' 2>/dev/null; then
  echo "  ok   reconcile clean"
else
  echo "  FAIL reconcile drift (or status unreadable) — /var/log/pecan-reconcile.log"
  fail=$((fail + 1))
fi

if [ "$fail" -eq 0 ]; then
  echo "API-SMOKE VERDICT: PASS"
  exit 0
fi
echo "API-SMOKE VERDICT: FAIL ($fail check(s))"
exit 1
