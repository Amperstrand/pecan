#!/bin/sh
# Reconciliation daemon over EVERY mint pair, every 5 minutes. Lives in
# the repo (scripts/); deploy.sh rsyncs it with reconcile-core.py and
# pairs.sh to /opt/pecan-tools/ on inr2, driven by root's crontab:
#   */5 * * * * /opt/pecan-tools/reconcile-server.sh >> /var/log/pecan-reconcile.log 2>&1
# All reads are sqlite-RO; two passes cost <0.5s — cadence is limited only
# by log noise, so clean runs log ONE line and drift logs the full report.
# Writes:
#   /opt/pecan-tools/reconcile-status.json — last run + per-pair verdict
#                                             (data source for the ops page)
#   /opt/pecan-tools/last-drift.txt        — timestamp of the latest drift
# Exit 1 on drift (cron logs it; details are in the log output above).
set -u
TOOLS=/opt/pecan-tools
. "$TOOLS/pairs.sh"
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
drift=0
first=1
printf '{\n "last_run": "%s",\n "pairs": {\n' "$STAMP" > "$TOOLS/reconcile-status.json.tmp"
for pair in $PAIRS; do
  DB=$(pair_field "$pair" mint_dir)/data/cdk-mintd.sqlite
  T=$(pair_field "$pair" server_dir)-data/tickets.json
  if out=$(python3 "$TOOLS/reconcile-core.py" "$DB" "$T" 2>&1); then
    verdict=clean
  else
    verdict=DRIFT
    drift=1
  fi
  if [ "$verdict" = DRIFT ]; then
    echo "--- $STAMP pair=$pair DRIFT"
    echo "$out"
  else
    notes=$(printf '%s\n' "$out" | grep -c '^  note:' || true)
    echo "$STAMP pair=$pair clean ($notes notes)"
  fi
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
