#!/usr/bin/env bash
# Narrate a recorded Alice cut: reads e2e/.results-video/movie-timeline.json
# (emitted by the spec — every card's window + spoken line), synthesizes
# each line with macOS `say`, aligns it to its window (rate-scaled if the
# take outgrows the card), and mixes everything onto the silent recording
# → alice-final.mp4 next to the webm.
#
# Usage: scripts/movie-voice.sh            (run AFTER a recording)
#        VOICE=Daniel scripts/movie-voice.sh
set -eu
cd "$(dirname "$0")/.."

VOICE=${VOICE:-Samantha}
VID="web/e2e/.results-video/alice-remote/alice-video-Alice-at-the-charge-point-—-full-lifecycle-movie/video.webm"
TL="web/e2e/.results-video/movie-timeline.json"
OUT="web/e2e/.results-video/alice-remote/alice-final.mp4"
WORK=$(mktemp -d /tmp/alice-vo.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

[ -f "$VID" ] || { echo "no recording at $VID (record first)" >&2; exit 1; }
[ -f "$TL" ] || { echo "no timeline at $TL" >&2; exit 1; }

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID")
echo "==> cut: ${DUR}s, voice: $VOICE"

python3 - "$TL" > "$WORK/plan.txt" <<'PY'
import json, sys
tl = json.load(open(sys.argv[1]))
for e in tl["entries"]:
    if not e.get("say"):
        continue
    start = max(0, e["start"] - tl.get("t0_offset_hint_ms", 1500)) / 1000.0
    end = min(e.get("end", e["start"] + 4000), 10**9) / 1000.0
    window = max(1.0, end - start - 0.3)
    print(f"{start:.2f}\t{window:.2f}\t{e['say']}")
PY

n=0
inputs=()
while IFS=$'\t' read -r start window text; do
  n=$((n+1))
  say -o "$WORK/line$n.aiff" -v "$VOICE" "$text"
  rawdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/line$n.aiff")
  tempo=$(python3 -c "print(1.0 if $rawdur <= $window else round(min(1.45, $rawdur / $window), 3))")
  ffmpeg -y -v error -i "$WORK/line$n.aiff" \
    -filter:a "atempo=$tempo,apad" -t "$window" -ar 44100 -ac 2 "$WORK/line$n.wav"
  # remember the delay for the graph
  echo "$start" >> "$WORK/delays.txt"
done < "$WORK/plan.txt"
[ "$n" -gt 0 ] || { echo "no narrated lines in timeline" >&2; exit 1; }
echo "==> $n narrated lines"

# Graph: video (last -i) + one silent bed + every line adelayed to its
# window, all amixed. Built in python to keep the quoting sane.
python3 - "$VID" "$OUT" "$DUR" "$WORK" <<'PY'
import subprocess, sys
vid, out, dur, work = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
delays = [float(l) for l in open(f"{work}/delays.txt")]
n = len(delays)
# input order: n line wavs, then bed, then video
cmd = ["ffmpeg", "-y", "-v", "error"]
for i in range(n):
    cmd += ["-i", f"{work}/line{i+1}.wav"]
cmd += ["-f", "lavfi", "-t", str(dur), "-i", "anullsrc=r=44100:cl=stereo", "-i", vid]
bed = n  # input index of the bed
video = n + 1
parts = [f"[{bed}:a]anullsrc=r=44100:cl=stereo,atrim=0:{dur}[bed]".replace(f"[{bed}:a]", f"[{bed}:a]")]
# bed: anullsrc is already generated as input n — just label it
parts = [f"[{bed}:a]atrim=0:{dur}[bed]"]
for i, d in enumerate(delays):
    parts.append(f"[{i}:a]adelay={int(d*1000)}:all=1[d{i}]")
mix_in = "".join(f"[d{i}]" for i in range(n))
parts.append(f"{mix_in}[bed]amix=inputs={n+1}:duration=longest:normalize=0,volume=1.6[aout]")
fc = ";".join(parts)
cmd += ["-filter_complex", fc, "-map", f"{video}:v", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-c:a", "aac", "-b:a", "160k", out]
subprocess.run(cmd, check=True)
PY
echo "==> narrated cut: $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s)"
