#!/bin/sh
# Hourly reconciliation daemon over BOTH mint pairs. Installed at
# /opt/pecan-tools/ on inr2; driven by root's crontab:
#   0 * * * * /opt/pecan-tools/reconcile-server.sh >> /var/log/pecan-reconcile.log 2>&1
# All reads are sqlite-RO. Writes:
#   /opt/pecan-tools/reconcile-status.json — last run + per-pair verdict
#                                             (data source for the ops page)
#   /opt/pecan-tools/last-drift.txt        — timestamp of the latest drift
# Exit 1 on drift (cron logs it; details are in the log output above).
set -u
TOOLS=/opt/pecan-tools
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
drift=0
first=1
printf '{\n "last_run": "%s",\n "pairs": {\n' "$STAMP" > "$TOOLS/reconcile-status.json.tmp"
for pair in eur usd; do
  case $pair in
    eur) DB=/opt/giftcard-mint/data/cdk-mintd.sqlite;     T=/opt/pecan-data/tickets.json ;;
    usd) DB=/opt/giftcard-mint-usd/data/cdk-mintd.sqlite; T=/opt/pecan-usd-data/tickets.json ;;
  esac
  echo "--- $STAMP pair=$pair"
  if out=$(python3 "$TOOLS/reconcile-core.py" "$DB" "$T" 2>&1); then
    verdict=clean
  else
    verdict=DRIFT
    drift=1
  fi
  echo "$out"
  [ "$first" -eq 1 ] || printf ',\n' >> "$TOOLS/reconcile-status.json.tmp"
  printf '  "%s": "%s"' "$pair" "$verdict" >> "$TOOLS/reconcile-status.json.tmp"
  first=0
done
printf '\n },\n "drift": %s\n}\n' "$drift" >> "$TOOLS/reconcile-status.json.tmp"
mv "$TOOLS/reconcile-status.json.tmp" "$TOOLS/reconcile-status.json"
if [ "$drift" -eq 1 ]; then
  echo "$STAMP DRIFT — details above and in /var/log/pecan-reconcile.log" > "$TOOLS/last-drift.txt"
  exit 1
fi
rm -f "$TOOLS/last-drift.txt"
