#!/usr/bin/env python3
"""D4 negative control: the oracle must FAIL when one NAV in the export is changed by 0.1 percent (so a green oracle is not simply one that checks nothing).
    python scripts/nav2_rc/oracle_negative_control.py <export.json>
Writes a mutated copy next to the input, runs oracle_full.py on it and requires failures."""
import json
import subprocess
import sys

src = sys.argv[1]
d = json.load(open(src, encoding="utf-8"))
f = d["funds"][0]
i = len(f["nav"]) - 40
f["nav"][i]["nav"] = f["nav"][i]["nav"] * 1.001
out = src.replace(".json", "_mutated.json")
json.dump(d, open(out, "w", encoding="utf-8"))
r = subprocess.run([sys.executable, "-I", "scripts/nav2_rc/oracle_full.py", out], capture_output=True, text=True)
fails = [l for l in r.stdout.splitlines() if l.strip().startswith("FAIL")]
print(f"mutated one NAV (+0.1 percent, 40 observations before the end of {f['name']}): oracle exit {r.returncode}, {len(fails)} FAIL lines")
for l in fails[:8]:
    print(" ", l.strip()[:160])
sys.exit(0 if r.returncode == 1 and fails else 1)
