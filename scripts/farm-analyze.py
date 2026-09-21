#!/usr/bin/env python3
"""Summarize farm matrix JSONL results: pass/fail per group and per
case, latency stats, and a compact table for eyeballing sweeps. Reads
one JSON object per line as emitted by web/e2e/helpers/farm-matrix-log.

Usage: scripts/farm-analyze.py [results.jsonl]
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "web/e2e/.results/farm-matrix-results.jsonl")
rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]

by_group: dict[str, list[dict]] = defaultdict(list)
for r in rows:
    by_group[f"{r['suite']}/{r['group']}"].append(r)

print(f"{'group':40} {'cases':>5} {'pass':>5} {'fail':>5} {'p50ms':>7} {'maxms':>7}")
print("-" * 76)
total_pass = total_fail = 0
for group in sorted(by_group):
    cases = by_group[group]
    npass = sum(1 for c in cases if c["outcome"] == "pass")
    nfail = len(cases) - npass
    total_pass += npass
    total_fail += nfail
    lat = sorted(c["ms"] for c in cases)
    p50 = lat[len(lat) // 2]
    print(f"{group:40} {len(cases):>5} {npass:>5} {nfail:>5} {p50:>7} {lat[-1]:>7}")
print("-" * 76)
print(f"{'TOTAL':40} {len(rows):>5} {total_pass:>5} {total_fail:>5}")

fails = [r for r in rows if r["outcome"] == "fail"]
if fails:
    print(f"\nfailures ({len(fails)}):")
    for r in fails:
        print(f"  [{r['run']}] {r['suite']}/{r['group']}/{r['case']} :: {r.get('detail', '')[:120]}")

# Parametrized dimensions worth eyeballing: latency by dimension value.
print("\nlatency by param (top values):")
for dim in ("date", "qty", "amount", "rail", "kind", "era", "offset", "parallel"):
    seen = defaultdict(list)
    for r in rows:
        v = (r.get("params") or {}).get(dim)
        if v is not None:
            seen[str(v)].append(r["ms"])
    if seen:
        parts = [f"{k}: n={len(v)} p50={sorted(v)[len(v)//2]}ms" for k, v in sorted(seen.items(), key=lambda kv: kv[0])]
        print(f"  {dim:8} " + " · ".join(parts))
