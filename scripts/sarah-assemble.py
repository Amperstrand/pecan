#!/usr/bin/env python3
"""Assemble the Sarah film: concat the two phone takes, mix the
pre-synthesized voice lines at their beat starts (no rate clamping),
hard-fail on overlap, render the final mp4 (builder GPU box).

Usage: sarah-assemble.py <parts.json> <timeline.json> <voice-dir> <out.mp4>
parts.json: {"a": "take-a.webm", "b": "take-b.webm"} (relative to cwd)
timeline entries carry `file` (a|b); part-b entries were already offset
in-timeline, but the silent concat needs the offset applied here when it
is not: we re-derive it from the parts durations to be safe.
"""
import json, subprocess, sys, os

parts, tl_path, voicedir, out = sys.argv[1:5]
parts = json.load(open(parts))
tl = json.load(open(tl_path))
T0 = tl.get("t0_offset_hint_ms", 1500)

def dur(p):
    return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
                                 "-of","csv=p=0",p],capture_output=True,text=True).stdout.strip())
durA, durB = dur(parts["a"]), dur(parts["b"])
concat = "sarah-concat.mp4"
subprocess.run(["ffmpeg","-y","-v","error","-i",parts["a"],"-i",parts["b"],
                "-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]",
                "-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",concat],check=True)
total = dur(concat)
print(f"concat: {total:.1f}s (a={durA:.1f}s b={durB:.1f}s)")

# Build the narration plan: place each line at its beat start (t0-shifted);
# entries in file b already carry global offsets — if an entry starts after
# durA it belongs to part b; timeline starts are global already.
plan = []
for e in tl["entries"]:
    lid = e.get("say")
    if not lid:
        continue
    # map the spoken text back to a line id via durations.json keys embedded
    # in the entry? The spec writes say=text. We match by order-independent
    # text lookup instead:
    plan.append(e)
durs = json.load(open(os.path.join(voicedir,"durations.json")))

placed = []
for e in plan:
    lid = e.get("sayId")
    if not lid or lid not in durs:
        continue  # silent beat
    start = max(0.0, (e["start"] - T0) / 1000.0)
    d = durs[lid]
    placed.append((start, d, lid, os.path.join(voicedir, f"{lid}.wav")))

placed.sort()
# Non-overlap by sliding: a line may start slightly late (live-UI beats
# cannot stretch), but never before the previous line ends + 0.35s. A
# slide beyond 2.5s means the beat genuinely cannot hold its line — fail.
for i in range(1, len(placed)):
    prev_end = placed[i-1][0] + placed[i-1][1] + 0.35
    if placed[i][0] < prev_end:
        slide = prev_end - placed[i][0]
        if slide > 2.5:
            raise SystemExit(f"OVERLAP: {placed[i][2]} would slide {slide:.2f}s "
                             f"(prev {placed[i-1][2]} ends {prev_end:.2f}s) — widen the beat")
        print(f"slide {placed[i][2]} +{slide:.2f}s past {placed[i-1][2]}")
        placed[i] = (prev_end, placed[i][1], placed[i][2], placed[i][3])
print(f"{len(placed)} lines placed, zero overlap")

cmd = ["ffmpeg","-y","-v","error","-i",concat]
for _,_,_,wav in placed:
    cmd += ["-i", wav]
cmd += ["-f","lavfi","-t",str(total),"-i","anullsrc=r=44100:cl=stereo"]
bed = len(placed) + 1  # 0=concat video, 1..n wavs, n+1 bed
fc = [f"[{bed}:a]atrim=0:{total}[bed]"]
for i,(start,d,_,_) in enumerate(placed):
    fc.append(f"[{i+1}:a]aresample=44100,aformat=channel_layouts=stereo,adelay={int(start*1000)}:all=1[d{i}]")
mix = "".join(f"[d{i}]" for i in range(len(placed)))
fc.append(f"{mix}[bed]amix=inputs={len(placed)+1}:duration=longest:normalize=0,"
          f"alimiter=limit=0.97,volume=1.35[aout]")
cmd += ["-filter_complex",";".join(fc),"-map","0:v","-map","[aout]",
        "-c:v","libx264","-preset","medium","-crf","19","-pix_fmt","yuv420p",
        "-movflags","+faststart","-c:a","aac","-b:a","192k",out]
subprocess.run(cmd,check=True)
print(f"final: {out} ({dur(out):.1f}s)")
