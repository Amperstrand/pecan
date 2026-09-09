#!/usr/bin/env bash
# Compose the wallet recording + the charger-sim mirror recording into
# one picture-in-picture video. The sim rides the top-right corner,
# exactly where a human would tape a phone over the real device.
set -euo pipefail
WALLET=$1
SIM=$2
# ms between the wallet video's start and the sim video's start
OFFSET_MS=${3:-0}
OUT=${4:-/tmp/ev-pip/charger-c-mirror.mp4}
mkdir -p "$(dirname "$OUT")"

ffmpeg -y -hide_banner -loglevel error \
  -i "$WALLET" -i "$SIM" \
  -filter_complex "\
[1:v]scale=210:-1,setpts=PTS+${OFFSET_MS}/TB[sim];\
[0:v][sim]overlay=x=main_w-214:y=6:eof_action=repeat" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT"
echo "composed: $OUT"
