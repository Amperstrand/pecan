#!/bin/sh
# Record + narrate the "Sarah buys egg futures" movie, three passes:
#
#   1. VOICE  — synthesize every manuscript line on ai-legion-small's GPU
#               (Kokoro-82M, neural voice) unless the wavs are fresh.
#   2. CAMERA — run web/e2e/sarah-video.spec.ts under the video config;
#               every beat holds at least its line's real audio length.
#   3. CUT    — concat the takes, mix the voice at beat starts (NO rate
#               clamping, hard overlap check), render on the builder.
#
#   scripts/sarah-movie.sh [--headed] [--fresh-voice]
# Out: web/e2e/.results-video/sarah-final.mp4
set -eu

SERVER=root@46.224.104.12
BUILDER=ai-legion-small
URL=https://giftcard.cashu.exchange
SSH_BUILDER="ssh -o ControlMaster=no -o ControlPath=none"
cd "$(dirname "$0")/.."

MODE=headless
FRESH_VOICE=0
for arg in "$@"; do
  case "$arg" in
    --headed) MODE=headed ;;
    --fresh-voice) FRESH_VOICE=1 ;;
    *) echo "unknown flag: $arg (use --headed | --fresh-voice)" >&2; exit 2 ;;
  esac
done

# OUTSIDE playwright's outputDir — the runner wipes .results-video at
# every test start, which ate the first voice cache mid-pipeline.
VOICE_DIR="web/e2e/sarah-voice"

echo "==> pass 1: voice (builder GPU)"
if [ "$FRESH_VOICE" = "1" ] || [ ! -f "$VOICE_DIR/durations.json" ]; then
  rsync -q web/e2e/sarah-manuscript.json "$BUILDER":/tmp/sarah-manuscript.json
  $SSH_BUILDER "$BUILDER" '~/tts-venv/bin/python ~/tts-synth.py /tmp/sarah-manuscript.json /tmp/sarah-voice' >/dev/null 2>&1
  rm -rf "$VOICE_DIR" && mkdir -p "$VOICE_DIR"
  rsync -r "$BUILDER":/tmp/sarah-voice/ "$VOICE_DIR"/
fi
python3 -c "
import json
d = json.load(open('$VOICE_DIR/durations.json'))
print(f'    {len(d)} lines, {sum(d.values()):.1f}s narration')"

echo "==> preflight: farm pair"
curl -fsS -m 10 "$URL/farm/v1/info" | grep -q '"32"' && echo "    NUT-32 advertised"
FREE=$(curl -fsS -m 10 "$URL/farm-console/api/farm" | python3 -c \
  'import json,sys; print(sum(1 for s in json.load(sys.stdin)["series"] if not s["matured"] and s["available"] >= 5))')
[ "$FREE" -ge 1 ] || { echo "!! no series with 5+ free eggs" >&2; exit 1; }
echo "    $FREE series with 5+ free eggs"

echo "==> preflight: payer liquidity toward the farm node"
$SSH_BUILDER "$SERVER" '
INV=$(docker exec cln-hub-signet lightning-cli --network=signet invoice 30000000msat sarah-movie-reb film-$$ 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[\"bolt11\"])")
timeout 120 docker exec cln-swap-signet lightning-cli --network=signet pay "$INV" >/dev/null 2>&1 && echo "    rebalance ok" || echo "    (rebalance skipped — routes may still work)"' 2>&1 | grep -v muxclient || true

echo "==> fetch the farm admin password (redemption leg)"
PW=$($SSH_BUILDER "$SERVER" 'cat /opt/pecan-farm-config/initial-admin-password.txt' 2>/dev/null | tail -1)
[ -n "$PW" ] || { echo "!! no farm admin password on the server" >&2; exit 1; }

# Pass 2 with self-healing: a concurrent deployer on the network
# intermittently reverts the wallet to a farm-less bundle; the spec's
# preflight fails fast when that happens — redeploy and retry the take
# (up to 3 rounds) instead of losing the session.
run_camera() {
  rm -rf web/e2e/.results-video/sarah-take web/e2e/.results-video/sarah-video-* 2>/dev/null || true
  cd web
  set +e
  PECAN_VIDEO=1 \
  PECAN_FARM_ADMIN_PASSWORD="$PW" \
  PECAN_HEADLESS="$([ "$MODE" = "headless" ] && echo 1 || echo 0)" \
    npx playwright test sarah-video --config playwright.video.config.ts --reporter=line
  local st=$?
  set -e
  cd ..
  return $st
}
TAKE=0
while :; do
  TAKE=$((TAKE + 1))
  echo "==> pass 2: camera ($MODE, take $TAKE)"
  if run_camera; then
    break
  fi
  if [ "$TAKE" -ge 3 ]; then
    echo "!! three takes failed — giving up" >&2
    exit 1
  fi
  echo "==> take $TAKE failed; checking whether a concurrent deploy reverted the wallet"
  JS=$(curl -s -m 10 "$URL/wallet" | grep -oE 'assets/index-[^"]*\.js' | head -1)
  if curl -s -m 10 "$URL/$JS" | grep -q FARM; then
    echo "    wallet still farm-tabbed (crash failure, not a revert) — retrying anyway"
  else
    echo "    wallet reverted by a concurrent deploy — redeploying before the retry"
    sh scripts/deploy.sh >/dev/null || { echo "!! redeploy failed" >&2; exit 1; }
  fi
done

echo "==> pass 3: cut (builder)"
$SSH_BUILDER "$BUILDER" 'rm -rf /tmp/sarah-film && mkdir -p /tmp/sarah-film' 2>/dev/null
rsync -q web/e2e/.results-video/sarah-parts.json "$BUILDER":/tmp/sarah-film/
rsync -q web/e2e/.results-video/sarah-timeline.json "$BUILDER":/tmp/sarah-film/
rsync -r web/e2e/.results-video/sarah-take/ "$BUILDER":/tmp/sarah-film/take/
python3 - <<'PYEOF'
import json, os
parts = json.load(open("web/e2e/.results-video/sarah-parts.json"))
json.dump({"a": "take/" + os.path.basename(parts["a"]),
           "b": "take/" + os.path.basename(parts["b"])},
          open("/tmp/sarah-parts-remote.json", "w"))
PYEOF
rsync -q /tmp/sarah-parts-remote.json "$BUILDER":/tmp/sarah-film/parts.json
rsync -r "$VOICE_DIR"/ "$BUILDER":/tmp/sarah-film/voice/
$SSH_BUILDER "$BUILDER" 'cd /tmp/sarah-film && python3 sarah-assemble.py parts.json sarah-timeline.json voice sarah-final.mp4' 2>&1 | grep -v muxclient
rsync -q "$BUILDER":/tmp/sarah-film/sarah-final.mp4 web/e2e/.results-video/sarah-final.mp4
echo "==> final: web/e2e/.results-video/sarah-final.mp4 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 web/e2e/.results-video/sarah-final.mp4)s)"
