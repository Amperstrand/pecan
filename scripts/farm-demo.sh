#!/usr/bin/env bash
# One-command live EGG demo on the Mac screen: preflight the farm pair,
# fetch the farm admin password, then run the visible browser
# orchestration (web/e2e/demo/farm-demo.mjs) — buy today's eggs (autopay
# settles the signet invoice), redeem at the counter, settle as the
# operator, receipt. Works any time of day: the vending machine has no
# time gate.
#
# Usage: make farm-demo   (or scripts/farm-demo.sh)
# PECAN_DEMO_EGGS=2 sets how many eggs to buy.
set -eu

SERVER=root@46.224.104.12
URL=https://giftcard.cashu.exchange
cd "$(dirname "$0")/.."

echo "==> preflight: farm pair"
curl -fsS -m 10 "$URL/farm/v1/keys" >/dev/null && echo "    mint keys ok"
curl -fsS -m 10 "$URL/farm-console/healthz" >/dev/null && echo "    console health ok"
FREE=$(curl -fsS -m 10 "$URL/farm-console/api/farm" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(max((s["available"] for s in d["series"] if s["date"] >= __import__("datetime").date.today().isoformat()), default=0))')
[ "$FREE" -gt 0 ] && echo "    today's eggs: $FREE free" || {
  echo "!! no free eggs today — raise capacity or wait for the reservation sweep" >&2
  exit 1
}

echo "==> fetch farm admin password"
PW=$(ssh "$SERVER" 'cat /opt/pecan-farm-config/initial-admin-password.txt')
if [ -z "$PW" ]; then
  echo "no farm admin password on the server" >&2
  exit 1
fi

echo "==> run the egg demo (Ctrl+C ends it and closes the browser)"
cd web
exec env PECAN_DEMO_ADMIN_PASSWORD="$PW" node e2e/demo/farm-demo.mjs
