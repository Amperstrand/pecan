#!/usr/bin/env bash
# Runs ON inr2 (fed via stdin by scripts/ln-rebalance.sh): pushes AMOUNT
# sat from node B to node A over their direct channel, using an
# amountless invoice on A paid by B (routes direct; BOLT12 blinded paths
# would route around it — see ln-rebalance.sh header).
set -eu
A=$1 B=$2 AMOUNT_SAT=$3
BOLT=$(docker exec "$A" lightning-cli --network=signet invoice any "rebalance-$RANDOM" reb \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["bolt11"])')
# CLN's pay prepends a "# ->node: Success" comment line — strip it.
docker exec "$B" lightning-cli --network=signet pay -- "$BOLT" "${AMOUNT_SAT}sat" \
  | sed '/^#/d' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("paid:", "payment_preimage" in d)'
