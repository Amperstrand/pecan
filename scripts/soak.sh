#!/bin/sh
# Soak: run the full e2e suite back-to-back N times (default 3), guarding
# payer liquidity and reconcile health between runs.
#
# Why the guards: each full run moves ~57k sat across the e2e payers
# (EUR ~7.4k + USD ~50k on-chain minimums) and the cln-swap reservoir
# only refills payers above its 150k reserve. Before every run the soak
# reads /opt/pecan-tools/payer-status.json (10min cron snapshot); any
# payer under MIN_FREE triggers refill-payers.sh, which re-checks live
# balances and tops up what the reservoir can cover. If a payer is still
# low afterwards, the soak stops instead of burning a doomed run — the
# same for reconcile drift (a drifted pair means the previous run left
# inconsistent state, not that this run should retry).
#
# Usage: scripts/soak.sh [runs]
set -eu
RUNS=${1:-3}
MIN_FREE=40000
SERVER=root@46.224.104.12
TOOLS=/opt/pecan-tools

payers_low() {
  ssh "$SERVER" "cat $TOOLS/payer-status.json" 2>/dev/null |
    python3 -c "
import json, sys
try:
    st = json.load(sys.stdin)
except Exception:
    sys.exit(1)
# Pending = refill top-ups waiting on a signet block; they count towards
# run-readiness (spendable within one block, ~5 min).
low = [p['name'] for p in st.get('payers', [])
       if 0 <= p['free'] + p.get('pending', 0) < $MIN_FREE]
if low:
    print(' '.join(low))
" || echo "status-unavailable"
}

reconcile_drifted() {
  status=$(ssh "$SERVER" "cat $TOOLS/reconcile-status.json" 2>/dev/null || echo "{}")
  printf '%s' "$status" |
    python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('drift', 0))
except Exception:
    print(1)
"
}

i=1
while [ "$i" -le "$RUNS" ]; do
  echo "=== soak run $i/$RUNS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

  low=$(payers_low)
  if [ "$low" = "status-unavailable" ]; then
    echo "  payer status unavailable — continuing (refill cron owns it)"
  elif [ -n "$low" ]; then
    echo "  payers low: $low — topping up from reservoir"
    ssh "$SERVER" "$TOOLS/refill-payers.sh" || true
    # The status snapshot is up to 10 min stale (cron) — regenerate it
    # before re-checking, or the refill just made still reads as low.
    ssh "$SERVER" "$TOOLS/payer-status.sh" >/dev/null 2>&1 || true
    still_low=$(payers_low)
    if [ "$still_low" != "status-unavailable" ] && [ -n "$still_low" ]; then
      echo "  reservoir cannot cover: $still_low still low — stopping"
      exit 1
    fi
  fi

  if [ "$(reconcile_drifted)" != "0" ]; then
    echo "  reconcile drift — stopping (details: /var/log/pecan-reconcile.log)"
    exit 1
  fi

  if bash "$(dirname "$0")/e2e.sh" > "/tmp/pecan-soak-run-$i.log" 2>&1; then
    echo "  ok — $(grep -oE '[0-9]+ passed \([0-9.]+m\)' /tmp/pecan-soak-run-$i.log | tail -1)"
  else
    echo "  FAILED — tail of /tmp/pecan-soak-run-$i.log:"
    tail -30 "/tmp/pecan-soak-run-$i.log"
    exit 1
  fi
  i=$((i + 1))
done
echo "soak complete: $RUNS/$RUNS runs green (logs: /tmp/pecan-soak-run-*.log)"
