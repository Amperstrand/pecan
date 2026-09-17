#!/usr/bin/env bash
# ev-charge-deploy.sh — ship the payout daemon + its systemd tariff flags.
#
# deploy.sh covers pecan (processor + web) but NOT /opt/pecan-tools, where
# the three ev-charge daemons live (EUR/USD/NOK pairs, one unit each).
# This script closes that gap so a tariff or adapter change is one
# command instead of an untracked procedure:
#
#   1. rsync payout/ev-charge.py + canonical_events.py to inr2:/opt/pecan-tools
#   2. rewrite each unit's ExecStart tariff flag (--eur-per-kwh)
#   3. systemctl daemon-reload + restart the three daemons
#
# Usage: scripts/ev-charge-deploy.sh [price-per-kwh]   (default 100)
# In-flight sessions: tickets already "triggered" in a state file are
# skipped by the restarted daemon (at-most-once delivery) — settle or
# expire them before deploying if the ledger matters to a demo.
set -eu

SERVER=root@46.224.104.12
PRICE="${1:-100}"
TOOLS=/opt/pecan-tools
UNITS=(ev-charge.service ev-charge-usd.service ev-charge-nok.service)
cd "$(dirname "$0")/.."

for u in "${UNITS[@]}"; do
  ssh "$SERVER" "systemctl is-active --quiet $u" \
    || { echo "!! $u is not running on $SERVER — refusing to touch it" >&2; exit 1; }
done

echo "==> rsync adapter to $SERVER:$TOOLS"
rsync -av payout/ev-charge.py payout/canonical_events.py "$SERVER:$TOOLS/"
ssh "$SERVER" "python3 -m py_compile $TOOLS/ev-charge.py && echo '    syntax ok'"

echo "==> set tariff --eur-per-kwh $PRICE on ${UNITS[*]}"
ssh "$SERVER" "
set -e
for u in ${UNITS[*]}; do
  f=/etc/systemd/system/\$u
  grep -q '^ExecStart=' \$f || { echo \"!! no ExecStart in \$f\" >&2; exit 1; }
  if grep -q -- '--secs-per-eur' \$f; then
    # Refresh the password too: units bake it at creation and a console
    # password rotation silently wedges every daemon (open-ticket polls
    # 401 forever, melts sit PENDING, wallets hang) — earned 2026-09-17.
    PW=\$(cat \$PWD_FILE)
    sed -i \"s/--password [A-Za-z0-9]*/--password \$PW/; s/--secs-per-eur [0-9.]*//; s/--eur-per-kwh [0-9..]*//\" \$f
    sed -i \"s|^\\(ExecStart=.*\\)\$|\\1 --eur-per-kwh $PRICE|\" \$f
  elif ! grep -q -- '--eur-per-kwh' \$f; then
    sed -i \"s|^\\(ExecStart=.*\\)\$|\\1 --eur-per-kwh $PRICE|\" \$f
  else
    sed -i \"s/--eur-per-kwh [0-9.]*/--eur-per-kwh $PRICE/\" \$f
  fi
  grep '^ExecStart=' \$f
done
systemctl daemon-reload
"

echo "==> restart daemons"
ssh "$SERVER" "systemctl restart ${UNITS[*]} && sleep 2 && systemctl --no-pager -l status ${UNITS[*]} | grep -E 'Active:|●' | head -8"

echo "==> done. Verify: scripts/api-smoke.sh, then scripts/e2e.sh --smoke"
