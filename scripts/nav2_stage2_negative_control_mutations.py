#!/usr/bin/env python3
"""
NAV2 Stage 2 -- negative-control proof by MUTATION (the Stage 2 counterpart of nav2_negative_control_mutations.py).

A green control is indistinguishable from one that never applied, so each named negative control added in Stage 2 is shown to
FAIL when the rule it protects is removed. Each mutation is a one-line change to the production code, applied one at a time; the
owning test file is run; the file is restored (copy-back from a backup, also on error). Run from the repository root:

    python scripts/nav2_stage2_negative_control_mutations.py

Expected: every mutation reports exit=1 and at least one failing test; a "PATTERN NOT FOUND" or exit=0 is a defect in the control.
"""
import os, subprocess, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

N = 'lib/services/investment-intelligence/nav2/'
T = 'tests/unit/nav2/'
MUTATIONS = [
    ('S1 RBI release figure read from the LEFT edge instead of aligned right', N + 'rbiHtml.ts', "row[row.length - nCols + k] : undefined", "row[k] : undefined", T + 'nav2RbiHtmlReaders.test.ts'),
    ('S2 fetcher page budget not enforced', N + 'rbiFetcher.ts', "if (this.pageRequests >= this.policy.maxRequestsPerRun) throw", "if (false) throw", T + 'nav2RbiFetcher.test.ts'),
    ('S3 fetcher spacing not enforced', N + 'rbiFetcher.ts', "if (wait > 0) await this.deps.sleep(wait);", "if (false) await this.deps.sleep(wait);", T + 'nav2RbiFetcher.test.ts'),
    ('S4 fetcher treats 403/429 as an ordinary error (no hard stop)', N + 'rbiFetcher.ts', "if (res.status === 403 || res.status === 429) throw", "if (false) throw", T + 'nav2RbiFetcher.test.ts'),
    ('S5 shared cache key ignores the NAV series checksum', 'lib/engines/nav2/fundAnalyticsReport.ts', "navSeriesChecksum: h.series.checksum,", "navSeriesChecksum: 'constant',", T + 'nav2FundAnalyticsService.test.ts'),
    ('S6 report generation skips the Premium check', N + 'fundAnalyticsReportService.ts', "if (!(await deps.isPremium(args.userId, admin))) return", "if (false) return", T + 'nav2FundAnalyticsService.test.ts'),
    ('S7 risk-free upload no longer blocks on a conflicting published value', N + 'riskFreeUploadService.ts', "  if (conflicts.length > 0) {", "  if (false) {", T + 'nav2RiskFreeCsvAndUpload.test.ts'),
    ('S8 refresh job writes during a dry run', N + 'riskFreeRefreshJob.ts', "if (!plan.mayWrite) return report; // dry run: decisions only", "// mutated: dry run still writes", T + 'nav2RiskFreeRefreshJob.test.ts'),
    ('S9 refresh job ignores the kill switch', N + 'riskFreeRefreshJob.ts', "if (plan.mode === 'skipped_kill_switch') return report;", "// mutated: kill switch ignored", T + 'nav2RiskFreeRefreshJob.test.ts'),
    ('S10 risk-free API guard lets either capability do anything', N + 'riskFreeAdmin.ts', "const allowed = kind === 'any' ? flags.upload || flags.switch : flags[kind];", "const allowed = flags.upload || flags.switch;", T + 'nav2RiskFreeAdminRoutes.test.ts'),
    ('S11 trigger runner ignores the planner switch', N + 'nav2TriggerRunner.ts', "if (!(await d.isPlannerOn())) return d.legacy(userId);", "if (false) return d.legacy(userId);", T + 'nav2TriggerRunner.test.ts'),
    ('S12 an unavailable result is shown as a figure', 'lib/engines/nav2/presentation.ts', "return { available: false, text: headline, headline,", "return { available: false, text: '0%', headline,", T + 'nav2ReportPresentation.test.ts'),
    ('S13 entity-only funds are not counted as excluded', N + 'fundAnalyticsLoader.ts', ".filter((id) => !personalIds.has(id)));", ".filter(() => false));", T + 'nav2FundAnalyticsLoader.test.ts'),
    ('S14 manifest checksum ignores the manifest', 'lib/engines/nav2/fundAnalyticsReport.ts', "createHash('sha256').update(JSON.stringify(canon(manifest)), 'utf8')", "createHash('sha256').update('constant', 'utf8')", T + 'nav2FundAnalyticsReport.test.ts'),
    ('S15 a switch read error counts as ON', N + 'nav2Flags.ts', "if (error) return false;", "if (error) return true;", T + 'nav2FundAnalyticsService.test.ts'),
    ('S16 correction worker: no event is ever marked processed', N + 'nav2ResultCacheStore.ts', ".update({ processed_at: nowIso, entries_invalidated: invalidated })", ".update({ entries_invalidated: invalidated })", T + 'nav2CacheWorkerAndRiskFreeLoader.test.ts'),
    ('S17 risk-free dataset version ignores the observations', N + 'riskFreeDatasetLoader.ts', "obs: obs.map((o) => [o.observationDate, o.kind, o.yieldPercent, o.gapReason])", "obs: 0", T + 'nav2CacheWorkerAndRiskFreeLoader.test.ts'),
    ('S19 a rate carries across an UNDOCUMENTED hole', 'lib/engines/nav2/riskFree.ts', "if (fullyDocumented) return", "if (true) return", T + 'nav2RiskFreeGapCarry.test.ts'),
    ('S20 the 35-day carry limit is not enforced', 'lib/engines/nav2/riskFree.ts', "age <= rule.gapCarry.maxCarryDays", "age <= 99999", T + 'nav2RiskFreeGapCarry.test.ts'),
    ('S21 the 95% window-coverage rule is not enforced', 'lib/engines/nav2/riskFree.ts', "share < gaps.minWindowCoverageShare", "share < 0", T + 'nav2RiskFreeGapCarry.test.ts'),
    ('S22 one date without a rate drops the whole window again (old rule)', 'lib/engines/nav2/riskFree.ts', "periodic.length === 0 || share < gaps.minWindowCoverageShare", "periodic.length === 0 || excluded.length > 0", T + 'nav2RiskFreeGapCarry.test.ts'),
    ('S23 the confirmed editor-breaking string is put back into 0260 (events into fund analytics)', 'supabase/migrations/0260_nav2_risk_free_governed_dataset.sql', "processes ii_reference_corrections events for fund analytics cache invalidation", "processes ii_reference_corrections events into fund analytics cache invalidation", T + 'nav2MigrationPartsAndEditorSafety.test.ts'),
    ('S18 print route opens the report for the session user, not the token user', 'app/(print)/reports/fund-analytics/print/page.tsx', "getFundAnalyticsReport(admin as never, resolved.userId, resolved.reportId)", "getFundAnalyticsReport(admin as never, 'someone-else', resolved.reportId)", T + 'nav2FundAnalyticsRoutes.test.ts'),
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
