#!/usr/bin/env python3
"""
NAV2 Stage 1 -- negative-control proof by MUTATION.

A green control is indistinguishable from one that never applied, so each named
negative control in tests/unit/nav2 is shown to FAIL when the rule it protects is
removed. This script applies ten one-line mutations to the NAV2 engine, one at a
time, runs the owning test file, reports which tests failed, and restores the file
(copy-back from a backup, also on error). Run from anywhere:

    python scripts/nav2_negative_control_mutations.py

Expected: every mutation reports exit=1 and at least one failing test.
"""
import os, subprocess, shutil, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

MUTATIONS = [
    ('M1 future-dated NAV no longer excluded', 'lib/engines/nav2/series.ts', "if (r.priceDate > args.asOfDate) {", "if (false) {", 'tests/unit/nav2/nav2SeriesPreparation.test.ts'),
    ('M2 risk-free staleness removed (weekly)', 'lib/engines/nav2/riskFree.ts', "const hit = resolveObservationAsOf(series, date, rule.maxStalenessDays);", "const hit = resolveObservationAsOf(series, date, 99999);", 'tests/unit/nav2/nav2RiskFreeDataset.test.ts'),
    ('M3 parser/AI disagreement publishes', 'lib/engines/nav2/riskFreeRefreshGate.ts', "      return review('parser_ai_disagree');", "      // mutated: carry on", 'tests/unit/nav2/nav2RiskFreeRefreshGate.test.ts'),
    ('M4 EMA seeded with the first price', 'lib/engines/nav2/schemeTrend.ts', "let prev = mean(obs.slice(0, period).map((o) => o.value));", "let prev = obs[0].value;", 'tests/unit/nav2/nav2TrendAndRanking.test.ts'),
    ('M5 rejected statement plans windows', 'lib/engines/nav2/requiredWindowPlanner.ts', "    case 'statement_not_accepted':\n      return { action: 'ignore',", "    case 'statement_not_accepted':\n      return { action: 'plan_held_windows', reason: 'x' } as unknown as TriggerAction; // mutated\n      return { action: 'ignore',", 'tests/unit/nav2/nav2WindowPlanner.test.ts'),
    ('M6 CAGR uses 365 not 365.2425', 'lib/engines/nav2/schemeReturns.ts', "cagr: cagrShown ? annualiseGrowth(ratio, actualDays, ctx.policy.daysPerYear) : null,", "cagr: cagrShown ? annualiseGrowth(ratio, actualDays, 365) : null,", 'tests/unit/nav2/nav2SchemeReturns.test.ts'),
    ('M7 missing benchmark gives beta 0', 'lib/engines/nav2/benchmarkGate.ts', "if (all.length === 0) return fail(", "if (all.length === 0 && false) return fail(", 'tests/unit/nav2/nav2SchemeRisk.test.ts'),
    ('M8 sample sd uses population (n) in correlation sd', 'lib/engines/nav2/schemeRisk.ts', "const sdx = sampleStdDev([...x]);", "const sdx = sampleStdDev([...x]) * Math.sqrt((x.length - 1) / x.length);", 'tests/unit/nav2/nav2SchemeRisk.test.ts'),
    ('M9 invalidation hits other schemes', 'lib/engines/nav2/cacheKeys.ts', "return e.instrumentId === event.instrumentId && (e.actualEnd === null || event.date <= e.actualEnd);", "return (e.actualEnd === null || event.date <= e.actualEnd);", 'tests/unit/nav2/nav2IdentityAndCache.test.ts'),
    ('M10 planner reaches back to inception', 'lib/engines/nav2/requiredWindowPlanner.ts', "requiredFrom: earliest < PLANNER_HISTORY_FLOOR ? PLANNER_HISTORY_FLOOR : earliest,", "requiredFrom: PLANNER_HISTORY_FLOOR,", 'tests/unit/nav2/nav2WindowPlanner.test.ts'),
]

results = []
for name, rel, old, new, test in MUTATIONS:
    path = os.path.join(ROOT, rel)
    src = open(path, encoding='utf-8', newline='').read()
    if old not in src:
        results.append((name, 'PATTERN NOT FOUND'))
        continue
    backup = path + '.mutbak'
    shutil.copyfile(path, backup)
    try:
        open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new, 1))
        r = subprocess.run(['npx', 'vitest', 'run', test], capture_output=True, text=True, encoding='utf-8', errors='replace', shell=True, cwd=ROOT)
        out = r.stdout + r.stderr
        failed = [l.strip() for l in out.splitlines() if l.strip().startswith('×')]
        results.append((name, f'exit={r.returncode}; failing tests: {len(failed)}' + (' -> ' + failed[0][:110] if failed else '')))
    finally:
        shutil.copyfile(backup, path)
        os.remove(backup)
for name, res in results:
    print(name, '::', res)
