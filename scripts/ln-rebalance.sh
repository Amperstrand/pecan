#!/usr/bin/env bash
# Rebalance a direct channel between two lab CLN nodes — the drained
# side's peer pays an amountless invoice over the direct channel (the
# v26 successor to keysend for this purpose: BOLT12 offers' blinded
# paths route AROUND the direct channel, which defeats a rebalance —
# measured 2026-09-16; plain invoices route direct). Reads the channel's balance from
# node A's view; if A's side is below TARGET sat, node B keysends
# (TARGET - A_side) back to A, pushing liquidity to the drained side.
#
# Built after the 2026-09-16 movie-outage: repeated demo payments
# drained the cln-hub→cln-swap channel's hub side to ~5k sat, CLN's
# pay then failed 205 with a misleading dead-channel attribution
# (lightning-playground#243) until the balance was pushed back.
#
# Usage:
#   scripts/ln-rebalance.sh <nodeA> <nodeB> [target-sat=50000]
#   scripts/ln-rebalance.sh cln-hub-signet cln-swap-signet   # keep the hub side fat
set -eu

SERVER=root@46.224.104.12
A=${1:?nodeA required (e.g. cln-hub-signet)}
B=${2:?nodeB required (e.g. cln-swap-signet)}
TARGET=${3:-50000}

read -r A_SIDE B_ID STATUS < <(ssh "$SERVER" "
  B_ID=\$(docker exec $B lightning-cli --network=signet getinfo | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"id\"])')
  docker exec $A lightning-cli --network=signet listpeerchannels 2>/dev/null | B_ID=\$B_ID python3 -c '
import json, sys, os
want = os.environ[\"B_ID\"]
best = None
for c in json.load(sys.stdin).get(\"channels\", []):
    if c.get(\"peer_id\") == want and c.get(\"state\") == \"CHANNELD_NORMAL\":
        # the largest healthy channel wins if several exist
        total = int(c.get(\"total_msat\", 0))
        if best is None or total > best[1]:
            best = (int(c.get(\"to_us_msat\", 0)), total)
if best:
    print(best[0] // 1000, want, \"ok\")
else:
    print(-1, want, \"no-channel\")
'")
if [ "$STATUS" != "ok" ]; then
  echo "!! no CHANNELD_NORMAL direct channel $A ↔ $B" >&2
  exit 1
fi
TOTAL=$((TARGET > 0 ? TARGET : 0))
echo "$A side: ${A_SIDE} sat (target ≥ ${TARGET})"
if [ "$A_SIDE" -ge "$TARGET" ]; then
  echo "already balanced — nothing to do"
  exit 0
fi
AMOUNT=$((TARGET - A_SIDE))
echo "pushing ${AMOUNT} sat: $B → $A (amountless invoice, direct channel)"
scp -q "$(dirname "$0")/ln-rebalance-remote.sh" "$SERVER:/tmp/ln-rebalance-remote.sh"
ssh "$SERVER" "bash /tmp/ln-rebalance-remote.sh $A $B $AMOUNT"
ssh "$SERVER" "docker exec $A lightning-cli --network=signet listpeerchannels 2>/dev/null" | B_ID="$B_ID" python3 -c '
import json, sys, os
want = os.environ["B_ID"]
for c in json.load(sys.stdin).get("channels", []):
    if c.get("peer_id") == want and c.get("state") == "CHANNELD_NORMAL":
        print("after:", int(c["to_us_msat"]) // 1000, "sat on the $A side")
'
