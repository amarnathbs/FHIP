# Negative-control harness: breaks one rule at a time in the source, runs the named test file(s), records which tests fail, and RESTORES the file.
# Run from anywhere: python scripts/india_mf_negative_controls.py   (needs node_modules; takes several minutes)
import subprocess, sys, re, json, os
W = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
os.chdir(W)

# (id, rule, file, old, new, test files)
M = [
 ('NC-01', 'F = A+B-C-D-E', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "const netInvestment = purchase + switchIn - switchOut - redemptionSwp - dividend;\n  const currentValue = sum",
  "const netInvestment = purchase + switchIn - switchOut - redemptionSwp + dividend;\n  const currentValue = sum",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-02', 'H = G-F', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "overallGain: currentValue - netInvestment,", "overallGain: currentValue + netInvestment,",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-03', 'joint-folio basis-point scaling', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "    units: p.units * f,\n", "    units: p.units,\n",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-04', 'entity sections stay separate from personal (entity treated as a member)', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "const key = r.ownerMemberId ? `member:${r.ownerMemberId}` : `entity:${r.ownerEntityId}`;",
  "const key = r.ownerMemberId ? `member:${r.ownerMemberId}` : `member:${r.ownerEntityId}`;",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-05', 'unallocated folios are surfaced, not dropped', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "if (rowsByOwner.has('unallocated')) {", "if (false && rowsByOwner.has('unallocated')) {",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-06', 'partial history shows a labelled value, never a blanket n/a', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "  if (flags.noTransactions) {\n    xirrOutcome = {", "  if (flags.noTransactions || partial) {\n    xirrOutcome = {",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-07', 'index values never invented', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "if (!close || !Number.isFinite(close.value) || close.value <= 0 || close.date > valuationDate) {",
  "if (!close) { return { status: 'ok', value: 20000, date: valuationDate, ageDays: 0, reason: null }; }\n  if (!Number.isFinite(close.value) || close.value <= 0 || close.date > valuationDate) {",
  ['tests/unit/indiaMfReport.test.ts']),
 ('NC-08', 'gate: no India MF holding -> no section', 'lib/engines/investment-intelligence/indiaMfReport.ts',
  "  return input.transactions.some((t) => hasRows(t.accountId, t.instrumentId)) || input.snapshots.some((s) => hasRows(s.accountId, s.instrumentId));",
  "  return true;",
  ['tests/unit/indiaMfReport.test.ts', 'tests/unit/indiaMfReportIntegration.test.ts']),
 ('NC-09', 'cross-user isolation (loader drops user_id on transactions)', 'lib/services/investment-intelligence/indiaMfReportData.ts',
  "        .select('id, account_id, instrument_id, transaction_type, transaction_date, units, price_per_unit, gross_amount, status, source_reference')\n        .eq('user_id', userId)\n",
  "        .select('id, account_id, instrument_id, transaction_type, transaction_date, units, price_per_unit, gross_amount, status, source_reference')\n",
  ['tests/unit/indiaMfReportIntegration.test.ts']),
 ('NC-10', 'AU-style home-country gate must NOT exist (loader gates on country)', 'lib/services/investment-intelligence/indiaMfReportData.ts',
  "  if (accounts.length === 0) return null;",
  "  if (accounts.length === 0) return null;\n  { const { data: p } = await supabase.from('user_profiles').select('country_of_residence').eq('user_id', userId).maybeSingle(); if ((p as { country_of_residence?: string } | null)?.country_of_residence !== 'IN') return null; }",
  ['tests/unit/indiaMfReportIntegration.test.ts']),
 ('NC-11', 'NAV pin keeps the wider window', 'lib/services/investment-intelligence/pc6/reportNavDependencyWriter.ts',
  "      } else if (basis !== 'rolling_return_window' && earliestTransactionDate && cur && earliestTransactionDate < cur) {",
  "      } else if (false) {",
  ['tests/unit/indiaMfReportIntegration.test.ts']),
 ('NC-12', 'upload: conflicting duplicate dates are rejected', 'lib/services/investment-intelligence/marketIndex/indexCsvParser.ts',
  "const allSame = closes.every((c) => Math.abs(c - closes[0]) < 1e-6);", "const allSame = true;",
  ['tests/unit/marketIndexParser.test.ts']),
 ('NC-13', 'upload: attestation required', 'lib/services/investment-intelligence/marketIndex/indexUploadService.ts',
  "if (input.attested !== true || input.attestationText.trim() !== ATTESTATION_TEXT) {", "if (false) {",
  ['tests/unit/marketIndexAdminRoute.test.ts']),
 ('NC-14', 'upload: an existing published value is never overwritten (conflict blocker removed)', 'lib/services/investment-intelligence/marketIndex/indexUploadService.ts',
  "    if (skipConflicts) {", "    if (true) {",
  ['tests/unit/marketIndexAdminRoute.test.ts']),
 ('NC-15', 'capability guard fails closed', 'lib/services/investment-intelligence/marketIndex/marketIndexAdmin.ts',
  "if (error || !adminRow || (adminRow as unknown as Record<string, unknown>)[MARKET_INDEX_ADMIN_CAPABILITY] !== true) {\n    return { user: null, forbidden: bad(",
  "if (error || !adminRow || (adminRow as unknown as Record<string, unknown>)[MARKET_INDEX_ADMIN_CAPABILITY] === false) {\n    return { user: null, forbidden: bad(",
  ['tests/unit/marketIndexAdminRoute.test.ts']),
 ('NC-16', 'nav: capability not implied by PC6/PC7', 'lib/admin/adminNav.ts',
  "...(capabilities.marketIndexDataUpload ? [{ label: 'Market Index Data'", "...((capabilities.marketIndexDataUpload || capabilities.referenceDataQuality) ? [{ label: 'Market Index Data'",
  ['tests/unit/marketIndexAdminRoute.test.ts']),
 ('NC-17', 'updater disabled by default', 'lib/services/investment-intelligence/marketIndex/dailyFeed.ts',
  "if (deps.env[MARKET_INDEX_FEED_ENV_FLAG] !== 'true') {", "if (deps.env[MARKET_INDEX_FEED_ENV_FLAG] === 'false') {",
  ['tests/unit/marketIndexDailyFeed.test.ts']),
 ('NC-18', 'updater never retries around a block (403 treated as retryable)', 'lib/services/investment-intelligence/marketIndex/dailyFeed.ts',
  "if (res.status >= 500) return { retryable: true, reason: `HTTP ${res.status}` };", "if (res.status >= 400) return { retryable: true, reason: `HTTP ${res.status}` };",
  ['tests/unit/marketIndexDailyFeed.test.ts']),
]

out = []
for (mid, rule, f, old, new, tests) in M:
    s = open(f, newline='', encoding='utf-8').read()
    crlf = '\r\n' in s
    o, n = (old.replace('\n', '\r\n'), new.replace('\n', '\r\n')) if crlf else (old, new)
    if s.count(o) != 1:
        out.append({'id': mid, 'rule': rule, 'result': 'MUTATION NOT APPLIED', 'detail': f'{s.count(o)} matches'}); print(mid, 'NOT APPLIED', s.count(o)); continue
    open(f, 'w', newline='', encoding='utf-8').write(s.replace(o, n))
    try:
        r = subprocess.run(['npx', 'vitest', 'run', *tests], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=280, shell=True)
        text = re.sub(r'\[[0-9;]*m', '', (r.stdout or '') + (r.stderr or ''))
        failed = sorted(set(re.findall(r'(?:×|✗)\s+(.+?)\s+\d+ms', text)))
        if not failed:
            failed = sorted(set(re.findall(r'FAIL\s+\S+\s+>\s+(.+)', text)))
        out.append({'id': mid, 'rule': rule, 'broken': f, 'failing': failed[:6], 'failingCount': len(failed), 'exit': r.returncode})
        print(mid, rule, '->', len(failed), 'failing;', failed[:2])
    finally:
        open(f, 'w', newline='', encoding='utf-8').write(s)
json.dump(out, open('docs/investment-intelligence/india-mf-report-example/negative_control_runs.json', 'w'), indent=1)
