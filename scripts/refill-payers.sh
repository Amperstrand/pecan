#!/bin/sh
# Cycle the mint's on-chain deposits back to the e2e payer nodes.
#
# Every on-chain deposit lands in cln-swap's wallet (the reservoir); the
# payers (cln-hub/vls/nostr) only spend. This closes the loop: when a
# payer drops below TARGET, top it up from the reservoir — never draining
# the reservoir below RESERVE. A full e2e run moves ~57k sat across the
# payers (EUR ~7.4k + USD ~50k on-chain minimums), so TARGET covers a run
# plus margin. Withdrawals need one signet block to become spendable —
# run this ahead of need (cron every 6h).
#
# Installed at /opt/pecan-tools/ (repo copy: scripts/refill-payers.sh).
#   17 */6 * * * /opt/pecan-tools/refill-payers.sh >> /var/log/pecan-refill.log 2>&1
set -eu
TARGET=80000
RESERVE=150000

free_sats() {
  # A dead or hung RPC reads as zero free — the payer is skipped for this
  # pass instead of hanging the whole refill loop (the vls signer outage
  # of 2026-09-03 stalled every cron pass for hours).
  timeout 20 docker exec "$1" lightning-cli --network=signet listfunds 2>/dev/null |
    python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(sum(o['amount_msat'] // 1000 for o in d['outputs']
              if o['status'] == 'confirmed' and not o.get('reserved')))
except Exception:
    print(0)
" 2>/dev/null || echo 0
}

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
reservoir=$(free_sats cln-swap-signet)
echo "$STAMP reservoir=$reservoir"

for payer in cln-hub-signet cln-vls-signet cln-nostr-signet; do
  free=$(free_sats "$payer")
  [ "$free" -ge "$TARGET" ] && { echo "  $payer ok ($free)"; continue; }
  need=$((TARGET - free))
  avail=$((reservoir - RESERVE))
  if [ "$avail" -le 10000 ]; then
    echo "  $payer needs $need but reservoir $reservoir keeps $RESERVE — skipping"
    continue
  fi
  amt=$need
  [ "$amt" -gt "$avail" ] && amt=$avail
  addr=$(timeout 20 docker exec "$payer" lightning-cli --network=signet newaddr bech32 |
    python3 -c "import sys,json; print(json.load(sys.stdin)['bech32'])" 2>/dev/null) || addr=""
  if [ -z "$addr" ]; then
    echo "  $payer: no address from RPC — skipping"
    continue
  fi
  # A failed withdraw (insufficient funds, RPC error) must skip the payer,
  # not abort the whole refill loop — the reservoir keeps its remaining
  # funds for the next cron pass.
  txout=$(timeout 60 docker exec cln-swap-signet lightning-cli --network=signet \
    withdraw "$addr" "${amt}sat" normal 2>&1) || txout=""
  txid=$(printf '%s' "$txout" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin)['txid'])
except Exception:
    print('')" 2>/dev/null)
  if [ -z "$txid" ]; then
    echo "  $payer: withdraw failed ($(printf '%s' "$txout" | head -c 160)) — skipping"
    continue
  fi
  echo "  topped $payer +${amt}sat (had $free) txid=$txid"
done
