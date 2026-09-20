#!/bin/sh
# Record + narrate "The egg vending machine" movie, three passes:
#
#   1. VOICE  — synthesize every manuscript line on ai-legion-small's GPU
#               (Kokoro-82M, neural voice) unless the wavs are fresh.
#   2. CAMERA — run web/e2e/portal-video.spec.ts under the video config;
#               every beat holds at least its line's real audio length.
#               No admin password: virtual delivery needs no operator.
#   3. CUT    — concat the takes, mix the voice at beat starts, render
#               on the builder (sarah-assemble.py is parameterized).
#
#   scripts/portal-movie.sh [--headed] [--fresh-voice]
# Out: web/e2e/.results-video/portal-final.mp4
set -eu

SERVER=root@46.224.104.12
BUILDER=ai-legion-small
URL=https://giftcard.cashu.exchange
SSH_BUILDER="ssh -o ControlMaster=no -o ControlPath=none"
cd "$(dirname "$0")/.."

MODE=headless
FRESH_VOICE=0
REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --headed) MODE=headed ;;
    --fresh-voice) FRESH_VOICE=1 ;;
    --remote) REMOTE=1 ;;
    *) echo "unknown flag: $arg (use --headed | --remote | --fresh-voice)" >&2; exit 2 ;;
  esac
done

VOICE_DIR="web/e2e/portal-voice"

echo "==> pass 1: voice (builder GPU)"
if [ "$FRESH_VOICE" = "1" ] || [ ! -f "$VOICE_DIR/durations.json" ]; then
  rsync -q web/e2e/portal-manuscript.json "$BUILDER":/tmp/portal-manuscript.json
  $SSH_BUILDER "$BUILDER" '~/tts-venv/bin/python ~/tts-synth.py /tmp/portal-manuscript.json /tmp/portal-voice' >/dev/null 2>&1
  rm -rf "$VOICE_DIR" && mkdir -p "$VOICE_DIR"
  rsync -r "$BUILDER":/tmp/portal-voice/ "$VOICE_DIR"/
fi
python3 -c "
import json
d = json.load(open('$VOICE_DIR/durations.json'))
print(f'    {len(d)} lines, {sum(d.values()):.1f}s narration')"

echo "==> preflight: farm pair"
curl -fsS -m 10 "$URL/farm/v1/info" | grep -q '"32"' && echo "    NUT-32 advertised"
FREE=$(curl -fsS -m 10 "$URL/farm-console/api/farm" | python3 -c \
  'import json,sys,datetime; t=datetime.date.today().isoformat(); print(next((s["available"] for s in json.load(sys.stdin)["series"] if s["date"]==t), 0))')
[ "$FREE" -ge 2 ] || { echo "!! today's eggs are sold out ($FREE free) — wait for the reservation sweep" >&2; exit 1; }
echo "    today's eggs: $FREE free"
curl -fsS -m 10 -o /dev/null "$URL/redeem" && echo "    claims portal serves at /redeem"

echo "==> preflight: autopay timer (the hands-free payment)"
AUTOPAY=$(ssh -o BatchMode=yes "$SERVER" 'systemctl is-active farm-autopay.timer' 2>/dev/null || echo inactive)
echo "    farm-autopay.timer: $AUTOPAY"
[ "$AUTOPAY" = "active" ] || { echo "!! autopay is off — the film's hands-free payment needs it" >&2; exit 1; }

echo "==> pass 2: camera ($MODE$( [ "$REMOTE" = "1" ] && echo , remote))"
if [ "$REMOTE" = "1" ]; then
  # The Mac's headless-shell video encoder wedged intermittently
  # (main thread stuck in the media pipeline); the builder records
  # cleanly — alice's movie.sh --remote established the pattern.
  REMOTE_DIR=/tmp/portal-movie
  ssh "$BUILDER" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
  rsync -az --exclude node_modules --exclude .git --exclude dist ./ "$BUILDER:$REMOTE_DIR/"
  ssh "$BUILDER" "cd $REMOTE_DIR/web && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx playwright install chromium >/dev/null 2>&1; echo '    builder ready'"
  # keep /tmp/portal-film-* profiles + warm marker across runs: the
  # first cold cycle takes ~30 minutes; retakes skip it
  set +e
  ssh "$BUILDER" "cd $REMOTE_DIR/web && PECAN_VIDEO=1 PECAN_HEADLESS=1 ./node_modules/.bin/playwright test portal-warm --config playwright.video.config.ts --reporter=line"
  ssh "$BUILDER" "cd $REMOTE_DIR/web && PECAN_VIDEO=1 PECAN_HEADLESS=1 ./node_modules/.bin/playwright test portal-video --config playwright.video.config.ts --reporter=line"
  st=$?
  set -e
  mkdir -p web/e2e/.results-video
  rsync -az --include 'portal-take/***' --include 'portal-timeline.json' \
    --include 'portal-parts.json' --exclude '*' \
    "$BUILDER:$REMOTE_DIR/web/e2e/.results-video/" web/e2e/.results-video/
  [ "$st" -eq 0 ] || { echo "!! remote camera pass failed ($st)" >&2; exit "$st"; }
else
  rm -rf web/e2e/.results-video/portal-take
  set +e
  cd web
  PECAN_VIDEO=1 PECAN_HEADLESS="$([ "$MODE" = "headless" ] && echo 1 || echo 0)" \
    ./node_modules/.bin/playwright test portal-video --config playwright.video.config.ts
  st=$?
  set -e
  cd ..
  [ "$st" -eq 0 ] || { echo "!! camera pass failed ($st)" >&2; exit "$st"; }
fi

echo "==> pass 3: cut (builder)"
$SSH_BUILDER "$BUILDER" 'rm -rf /tmp/portal-film && mkdir -p /tmp/portal-film && cp /home/ubuntu/sarah-assemble.py /tmp/portal-film/' 2>/dev/null
rsync -q web/e2e/.results-video/portal-parts.json "$BUILDER":/tmp/portal-film/
rsync -q web/e2e/.results-video/portal-timeline.json "$BUILDER":/tmp/portal-film/
rsync -r web/e2e/.results-video/portal-take/ "$BUILDER":/tmp/portal-film/take/
python3 - <<'PYEOF'
import json, os
parts = json.load(open("web/e2e/.results-video/portal-parts.json"))
json.dump({"a": "take/" + os.path.basename(parts["a"]),
           "b": "take/" + os.path.basename(parts["b"])},
          open("/tmp/portal-parts-remote.json", "w"))
PYEOF
rsync -q /tmp/portal-parts-remote.json "$BUILDER":/tmp/portal-film/parts.json
rsync -r "$VOICE_DIR"/ "$BUILDER":/tmp/portal-film/voice/
$SSH_BUILDER "$BUILDER" 'cd /tmp/portal-film && python3 sarah-assemble.py parts.json portal-timeline.json voice portal-final.mp4' 2>&1 | grep -v muxclient
rsync -q "$BUILDER":/tmp/portal-film/portal-final.mp4 web/e2e/.results-video/portal-final.mp4
echo "==> final: web/e2e/.results-video/portal-final.mp4 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 web/e2e/.results-video/portal-final.mp4)s)"
