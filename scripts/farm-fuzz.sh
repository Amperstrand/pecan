#!/usr/bin/env bash
# farm-fuzz — the farm's exhaustive enumerated test run: the API-tier
# matrix (80 parametrized cases across the oracle, purchases, terms,
# mint/melt quotes, rails, and concurrency — ~15s, tiny sats) plus the
# suite's regression neighbors, all logged as JSONL for later analysis.
#
#   scripts/farm-fuzz.sh              # matrix + summary
#   scripts/farm-fuzz.sh --analyze    # summarize an existing JSONL only
#   RESULTS=custom.jsonl scripts/farm-fuzz.sh   (default: farm-matrix-results.jsonl)
#
# Disk guard: the matrices produce NO video; the guard below refuses to
# run under 2 GB free (this machine's disk pressure is a known flake
# source) and the JSONL is append-only but tiny.
set -eu

SERVER=root@46.224.104.12
URL=https://giftcard.cashu.exchange
cd "$(dirname "$0")/.."
RESULTS="${RESULTS:-web/e2e/.results/farm-matrix-results.jsonl}"

free_gb() { df -g /System/Volumes/Data | awk 'NR==2 {print $4}'; }
if [ "$(free_gb)" -lt 2 ]; then
  echo "!! only $(free_gb)GB free — refusing (disk pressure is a known flake source)" >&2
  exit 1
fi

if [ "${1:-}" = "--analyze" ]; then
  python3 scripts/farm-analyze.py "$RESULTS"
  exit 0
fi

echo "==> preflight: farm pair"
curl -fsS -m 10 "$URL/farm/v1/info" | grep -q '"32"' && echo "    NUT-32 advertised"
sh scripts/api-smoke.sh 2>&1 | tail -1

echo "==> fetch the farm admin password"
PW=$(ssh -o BatchMode=yes "$SERVER" 'cat /opt/pecan-farm-config/initial-admin-password.txt' | tail -1)
[ -n "$PW" ] || { echo "no farm admin password" >&2; exit 1; }

echo "==> run the API matrix (fresh JSONL per run)"
rm -f "$RESULTS"
cd web
PECAN_FARM_ADMIN_PASSWORD="$PW" ./node_modules/.bin/playwright test farm-matrix --reporter=line
cd ..

echo
echo "==> analysis"
python3 scripts/farm-analyze.py "$RESULTS"
