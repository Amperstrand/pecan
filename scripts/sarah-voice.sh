#!/bin/sh
# Narrate the Sarah film: synthesizes each timeline line with macOS `say`,
# rate-fits it into its window, and mixes it over the silent cut
# → web/e2e/.results-video/sarah-final.mp4.
#
# Canonical generic version: the film knowledge base (~/src/test-films)
# vendors tools/narrate-film.sh — keep this copy aligned with it.
#
# Usage: scripts/sarah-voice.sh          (after scripts/sarah-movie.sh)
#        VOICE=Daniel scripts/sarah-voice.sh
set -eu
cd "$(dirname "$0")/.."

VOICE=${VOICE:-Samantha}
VID="web/e2e/.results-video/sarah-film-silent.mp4"
TL="web/e2e/.results-video/sarah-timeline.json"
OUT="web/e2e/.results-video/sarah-final.mp4"
WORK=$(mktemp -d /tmp/sarah-vo.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

[ -f "$VID" ] || { echo "no silent cut at $VID (record first)" >&2; exit 1; }
[ -f "$TL" ] || { echo "no timeline at $TL" >&2; exit 1; }

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID")
echo "==> film: ${DUR}s · voice: $VOICE"

python3 - "$TL" > "$WORK/plan.txt" <<'PY'
import json, sys
tl = json.load(open(sys.argv[1]))
for e in tl["entries"]:
    if not e.get("say"):
        continue
    start = max(0, e["start"] - tl.get("t0_offset_hint_ms", 1500)) / 1000.0
    end = min(e.get("end", e["start"] + 4000), 10**9) / 1000.0
    window = max(1.0, end - start - 0.3)
    print(f"{start:.3f}\t{window:.3f}\t{e['say']}")
PY

n=0
while IFS=$'\t' read -r start window text; do
  n=$((n+1))
  say -o "$WORK/line$n.aiff" -v "$VOICE" "$text"
  rawdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/line$n.aiff")
  tempo=$(python3 -c "print(1.0 if $rawdur <= $window else round(min(1.45, $rawdur / $window), 3))")
  ffmpeg -y -v error -i "$WORK/line$n.aiff" \
    -filter:a "atempo=$tempo,apad" -t "$window" -ar 44100 -ac 2 "$WORK/line$n.wav"
  echo "$start" >> "$WORK/delays.txt"
done < "$WORK/plan.txt"
[ "$n" -gt 0 ] || { echo "no narrated lines in timeline" >&2; exit 1; }
echo "==> $n narrated lines"

python3 - "$VID" "$OUT" "$DUR" "$WORK" <<'PY'
import subprocess, sys
vid, out, dur, work = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
delays = [float(l) for l in open(f"{work}/delays.txt")]
n = len(delays)
cmd = ["ffmpeg", "-y", "-v", "error"]
for i in range(n):
    cmd += ["-i", f"{work}/line{i+1}.wav"]
cmd += ["-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=44100:cl=stereo", "-i", vid]
bed, video = n, n + 1
parts = [f"[{bed}:a]atrim=0:{dur}[bed]"]
for i, d in enumerate(delays):
    parts.append(f"[{i}:a]adelay={int(d*1000)}:all=1[d{i}]")
mix_in = "".join(f"[d{i}]" for i in range(n))
parts.append(f"{mix_in}[bed]amix=inputs={n+1}:duration=longest:normalize=0,volume=1.6[aout]")
cmd += ["-filter_complex", ";".join(parts),
        "-map", f"{video}:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", out]
subprocess.run(cmd, check=True)
PY
echo "==> narrated cut: $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s)"
