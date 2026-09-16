#!/usr/bin/env bash
# Record the "Alice at the charge point" movie: preflight the EUR pair
# and the SIM CHARGER, then run web/e2e/alice-video.spec.ts under the
# video config. Output lands in web/e2e/.results-video/ (.webm + stills).
#
# Recording is HEADLESS by default (stable frames, no window jitter);
# pass --headed to watch it run locally.
#
# Usage:
#   scripts/movie.sh              # record on THIS machine, headless
#   scripts/movie.sh --headed     # record locally, visible browser
#   scripts/movie.sh --remote     # record on ai-legion-small (faster
#                                 # box; artifacts pulled back here)
set -eu

SERVER=root@46.224.104.12
URL=https://giftcard.cashu.exchange
BUILDER=ai-legion-small
REMOTE_DIR=/tmp/pecan-movie
cd "$(dirname "$0")/.."

MODE=headless
for arg in "$@"; do
  case "$arg" in
    --headed) MODE=headed ;;
    --remote) MODE=remote ;;
    *) echo "unknown flag: $arg (use --headed | --remote)" >&2; exit 2 ;;
  esac
done

echo "==> preflight: EUR pair"
curl -fsS -m 10 "$URL/eur/v1/keys" >/dev/null && echo "    mint keys ok"
curl -fsS -m 10 "$URL/eur-console/healthz" >/dev/null && echo "    console health ok"

echo "==> preflight: SIM CHARGER (atomV)"
online=$(ssh "$SERVER" "systemctl is-active ev-virtual-charger" 2>/dev/null || echo inactive)
echo "    ev-virtual-charger.service: $online"
if [ "$online" != "active" ]; then
  echo "!! the SIM CHARGER is not running — start it: scripts/virtual-charger.sh start" >&2
  exit 1
fi
# MQTT creds feed the companion strip's live kW graph (car meter topic).
EV_ENV=$(ssh "$SERVER" \
  "grep -E '^(MQTT_URL|MQTT_USER|MQTT_PASS)=' /opt/atom-bridge/.env" 2>/dev/null || true)
MQTT_URL="$(printf '%s\n' "$EV_ENV" | grep MQTT_URL | cut -d= -f2)"
MQTT_USER="$(printf '%s\n' "$EV_ENV" | grep MQTT_USER | cut -d= -f2)"
MQTT_PASS="$(printf '%s\n' "$EV_ENV" | grep MQTT_PASS | cut -d= -f2)" 

if [ "$MODE" = "remote" ]; then
  echo "==> rsync source to ${BUILDER}:${REMOTE_DIR}"
  ssh "$BUILDER" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
  rsync -az --exclude node_modules --exclude target --exclude .git --exclude dist \
    ./ "$BUILDER:$REMOTE_DIR/"
  echo "==> install web deps + chromium on $BUILDER (first run takes a few minutes)"
  ssh "$BUILDER" "cd $REMOTE_DIR/web && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx playwright install chromium >/dev/null 2>&1; echo ready"
  echo "==> roll camera on $BUILDER (headless)"
  status=0
  ssh "$BUILDER" "cd $REMOTE_DIR/web && PECAN_VIDEO=1 PECAN_HEADLESS=1 PECAN_EV_MQTT_URL='$MQTT_URL' PECAN_EV_MQTT_USER='$MQTT_USER' PECAN_EV_MQTT_PASS='$MQTT_PASS' npx playwright test alice-video --config playwright.video.config.ts" || status=$?
  echo "==> pull artifacts"
  mkdir -p web/e2e/.results-video/alice-remote
  rsync -az \
    --include 'alice-video-*/***' --include 'alice-stills/***' --exclude '*' \
    "$BUILDER:$REMOTE_DIR/web/e2e/.results-video/" web/e2e/.results-video/alice-remote/ || true
  find web/e2e/.results-video/alice-remote -name '*.webm' -exec \
    sh -c 'echo "movie: {} ($(ffprobe -v error -show_entries format=duration -of csv=p=0 {} 2>/dev/null || echo ?)s)"' \; 2>/dev/null || true
  exit "$status"
fi

echo "==> roll camera on this Mac ($MODE)"
cd web
exec env PECAN_VIDEO=1 \
  PECAN_EV_MQTT_URL="$MQTT_URL" PECAN_EV_MQTT_USER="$MQTT_USER" PECAN_EV_MQTT_PASS="$MQTT_PASS" \
  PECAN_HEADLESS="$([ "$MODE" = "headless" ] && echo 1 || echo 0)" \
  npx playwright test alice-video --config playwright.video.config.ts
