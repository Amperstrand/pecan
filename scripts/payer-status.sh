#!/bin/sh
# Payer liquidity snapshot for the /ops page. Installed at /opt/pecan-tools/
# (repo copy: scripts/payer-status.sh); root's crontab:
#   */10 * * * * /opt/pecan-tools/payer-status.sh >> /var/log/pecan-payers.log 2>&1
# The e2e on-chain payers (cln-hub/vls/nostr) only spend; cln-swap-signet is
# the reservoir that receives every on-chain deposit. refill-payers.sh tops
# the payers up from it (TARGET 80k, RESERVE 150k — same numbers here).
# Writes /opt/pecan-tools/payer-status.json. Node read failures surface as
# -1 so the ops page can show "unreachable" instead of lying with a zero.
set -u
TOOLS=/opt/pecan-tools
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

funds() {
  docker exec "$1" lightning-cli --network=signet listfunds 2>/dev/null |
    python3 -c '
import sys, json
try:
    outs = json.load(sys.stdin).get("outputs", [])
    free = sum(o["amount_msat"] // 1000 for o in outs
               if o["status"] == "confirmed" and not o.get("reserved"))
    res = sum(o["amount_msat"] // 1000 for o in outs
              if o["status"] == "confirmed" and o.get("reserved"))
    print(free, res)
except Exception:
    print(-1, -1)
'
}

RESERVOIR=$(funds cln-swap-signet | cut -d" " -f1)
printf '{\n "last_run": "%s",\n "reservoir": %s,\n "payers": [\n' \
  "$STAMP" "${RESERVOIR:-0}" > "$TOOLS/payer-status.json.tmp"
first=1
for payer in cln-hub-signet cln-vls-signet cln-nostr-signet; do
  set -- $(funds "$payer")
  [ "$first" -eq 1 ] || printf ',\n' >> "$TOOLS/payer-status.json.tmp"
  printf '  {"name": "%s", "free": %s, "reserved": %s}' \
    "$payer" "${1:-0}" "${2:-0}" >> "$TOOLS/payer-status.json.tmp"
  first=0
done
printf '\n ]\n}\n' >> "$TOOLS/payer-status.json.tmp"
mv "$TOOLS/payer-status.json.tmp" "$TOOLS/payer-status.json"
echo "$STAMP reservoir=$RESERVOIR"
