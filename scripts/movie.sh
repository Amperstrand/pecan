#!/usr/bin/env bash
# Record the "Alice at the charge point" movie: preflight the EUR pair
# and the SIM CHARGER, fetch the MQTT creds the display mirror needs,
# then run web/e2e/alice-video.spec.ts under the video config. Output
# lands in web/e2e/.results-video/ (.webm + scene PNGs).
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
EV_ENV=$(ssh "$SERVER" \
  "grep -E '^(BRIDGE_KEY|MQTT_URL|MQTT_USER|MQTT_PASS)=' /opt/atom-bridge/.env" 2>/dev/null)
MQTT_URL="$(printf '%s\n' "$EV_ENV" | grep MQTT_URL | cut -d= -f2)"
MQTT_USER="$(printf '%s\n' "$EV_ENV" | grep MQTT_USER | cut -d= -f2)"
MQTT_PASS="$(printf '%s\n' "$EV_ENV" | grep MQTT_PASS | cut -d= -f2)"
online=$(ssh "$SERVER" "systemctl is-active ev-virtual-charger" 2>/dev/null || echo inactive)
echo "    ev-virtual-charger.service: $online"
if [ "$online" != "active" ]; then
  echo "!! the SIM CHARGER is not running — start it: scripts/virtual-charger.sh start" >&2
  exit 1
fi

RUN_ENV="PECAN_VIDEO=1 PECAN_SIM_BOARD=atom PECAN_EV_MQTT_URL=$MQTT_URL PECAN_EV_MQTT_USER=$MQTT_USER PECAN_EV_MQTT_PASS=$MQTT_PASS"

if [ "$MODE" = "remote" ]; then
  echo "==> rsync source to ${BUILDER}:${REMOTE_DIR}"
  ssh "$BUILDER" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
  rsync -az --exclude node_modules --exclude target --exclude .git --exclude dist \
    ./ "$BUILDER:$REMOTE_DIR/"
  echo "==> install web deps + chromium on $BUILDER (first run takes a few minutes)"
  ssh "$BUILDER" "cd $REMOTE_DIR/web && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx playwright install chromium >/dev/null 2>&1; echo ready"
  echo "==> roll camera on $BUILDER (headless)"
  status=0
  ssh "$BUILDER" "cd $REMOTE_DIR/web && env $RUN_ENV PECAN_HEADLESS=1 npx playwright test alice-video --config playwright.video.config.ts" || status=$?
  echo "==> pull artifacts"
  mkdir -p web/e2e/.results-video/alice-remote
  rsync -az \
    --include 'alice-video-*/***' --exclude '*' \
    "$BUILDER:$REMOTE_DIR/web/e2e/.results-video/" web/e2e/.results-video/alice-remote/ || true
  exit "$status"
fi

echo "==> roll camera on this Mac ($MODE)"
cd web
exec env $RUN_ENV \
  PECAN_HEADLESS="$([ "$MODE" = "headless" ] && echo 1 || echo 0)" \
  npx playwright test alice-video --config playwright.video.config.ts
