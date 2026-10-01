// BENCH-1 Phase 2 -- upload validator (pure). Every rule has a NEGATIVE CONTROL:
// the same scenario with the offending value fixed must NOT raise the code.
import { describe, it, expect } from 'vitest';
import {
  parseCsvText,
  csvToTable,
  validateUpload,
  VALIDATOR_VERSION,
  type CatalogueEntryLite,
  type UploadParams,
  type ValidationContext,
  type ValidationResult,
  type ValidationIssue,
} from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

const TODAY = '2026-10-01';
const TRI = 'IN_NIFTY_50_TRI';
const TRI2 = 'IN_SENSEX_TRI';
const PRI = 'IN_NIFTY_50_PRI';
const PRI2 = 'IN_NIFTY_NEXT_50_PRI';
const OFF = 'IN_OLD_TRI';
const USD = 'US_SPX_TRI';

const entry = (benchmarkKey: string, returnVariant: CatalogueEntryLite['returnVariant'], currencyCode = 'INR', isActive = true): CatalogueEntryLite => ({
  benchmarkKey,
  returnVariant,
  currencyCode,
  isActive,
});
const CATALOGUE = new Map<string, CatalogueEntryLite>([
  [TRI, entry(TRI, 'total_return')],
  [TRI2, entry(TRI2, 'total_return')],
  [PRI, entry(PRI, 'price')],
  [PRI2, entry(PRI2, 'price')],
  [OFF, entry(OFF, 'total_return', 'INR', false)],
  [USD, entry(USD, 'total_return', 'USD')],
]);

const params = (o: Partial<UploadParams> = {}): UploadParams => ({
  shape: 'single',
  mode: 'new_history',
  benchmarkKey: TRI,
  returnVariant: 'total_return',
  currencyCode: 'INR',
  historyClass: 'live',
  dateFormat: 'YYYY-MM-DD',
  numberLocale: 'plain',
  ...o,
});
const existingOf = (o: Record<string, Record<string, number>>): ValidationContext['existing'] =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Map(Object.entries(v))]));
const ctx = (o: Partial<ValidationContext> = {}): ValidationContext => ({
  todayIso: TODAY,
  catalogue: CATALOGUE,
  existing: new Map(),
  ...o,
});
const file = (...rows: string[]) => 'date,value\n' + rows.join('\n') + '\n';
const run = (text: string, p: Partial<UploadParams> = {}, c: Partial<ValidationContext> = {}): ValidationResult => {
  const full = params(p);
  return validateUpload(csvToTable(parseCsvText(text, { headerRow: full.headerRow }), full.headerRow ?? 1), full, ctx(c));
};
const find = (r: ValidationResult, code: string): ValidationIssue | undefined => r.issues.find((i) => i.code === code);
const errors = (r: ValidationResult) => r.issues.filter((i) => i.severity === 'error');

describe('happy paths', () => {
  it('a clean single-benchmark file stages every row as new, with a full disclosure', () => {
    const r = run(file('2024-01-01,1000.00', '2024-01-02,1001.50', '2024-01-03,1002.25', '2024-01-04,1003.00', '2024-01-05,1004.10'));
    expect(r.validatorVersion).toBe('bench1-file-validator-v1');
    expect(VALIDATOR_VERSION).toBe(r.validatorVersion);
    expect(r.hardErrorCount).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.rowsTotal).toBe(5);
    expect(r.rowsValid).toBe(5);
    expect(r.rowsInvalid).toBe(0);
    expect(r.staged.map((s) => [s.rowNumber, s.date, s.value, s.valueText, s.classification, s.existing])).toEqual([
      [2, '2024-01-01', 1000, '1000', 'new', null],
      [3, '2024-01-02', 1001.5, '1001.5', 'new', null],
      [4, '2024-01-03', 1002.25, '1002.25', 'new', null],
      [5, '2024-01-04', 1003, '1003', 'new', null],
      [6, '2024-01-05', 1004.1, '1004.1', 'new', null],
    ]);
    expect(r.staged.every((s) => s.benchmarkKey === TRI && s.flags.length === 0)).toBe(true);
    expect(r.requiredAcknowledgements).toEqual([]);
    expect(r.perBenchmark).toEqual([{ benchmarkKey: TRI, earliestDate: '2024-01-01', latestDate: '2024-01-05', newRows: 5, identicalRows: 0, correctionRows: 0, gaps: [] }]);
    expect(r.disclosure).toEqual({
      sheetProcessed: undefined,
      sheetsAvailable: undefined,
      hiddenRowsSkipped: undefined,
      hiddenRowsIncluded: undefined,
      otherSheetsNotProcessed: undefined,
      headerRow: 1,
      layoutId: 'single_date_value',
      columnMapping: { date: 'date', value: 'value' },
    });
  });

  it('a multi-benchmark file is staged sorted by (benchmarkKey, date) regardless of file order', () => {
    const text = `benchmark_key,date,value\n${TRI},2024-01-02,1001\n${TRI2},2024-01-01,500\n${TRI},2024-01-01,1000\n`;
    const r = run(text, { shape: 'multi', benchmarkKey: undefined });
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => `${s.benchmarkKey} ${s.date}`)).toEqual([`${TRI} 2024-01-01`, `${TRI} 2024-01-02`, `${TRI2} 2024-01-01`]);
    expect(r.perBenchmark.map((b) => b.benchmarkKey)).toEqual([TRI, TRI2]);
    expect(r.disclosure.layoutId).toBe('multi_key_date_value');
  });

  it('a registered provider export maps its columns and honours locale and date format', () => {
    const text = 'Date,Total Returns Index\n01 Jan 2024,"1,000.50"\n02 Jan 2024,"1,001.25"\n';
    const r = run(text, { shape: 'provider_export', providerLayoutId: 'nse_tri_export', dateFormat: 'DD MMM YYYY', numberLocale: 'en' });
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => [s.date, s.value])).toEqual([['2024-01-01', 1000.5], ['2024-01-02', 1001.25]]);
    expect(r.disclosure.layoutId).toBe('nse_tri_export');
    expect(r.disclosure.columnMapping).toEqual({ date: 'Date', value: 'Total Returns Index' });
  });
});

// ----------------------------------------------------------------------------
// Rule table. Each row: a GOOD scenario (must not raise the code, and for
// errors must have zero hard errors) and a BAD scenario (must raise the code).
// ----------------------------------------------------------------------------
interface Scenario {
  text?: string;
  p?: Partial<UploadParams>;
  c?: Partial<ValidationContext>;
}
interface RuleCase {
  rule: string;
  code: string;
  severity: 'error' | 'warning';
  row: number | null | undefined; // undefined: do not assert
  good: Scenario;
  bad: Scenario;
}

const GOOD_TEXT = file('2024-01-01,1000', '2024-01-02,1001', '2024-01-03,1002');

const RULES: RuleCase[] = [
  { rule: 'future date', code: 'DATE_FUTURE', severity: 'error', row: 3, good: { text: file('2026-09-30,1000', '2026-10-01,1001') }, bad: { text: file('2026-09-30,1000', '2026-10-02,1001') } },
  { rule: 'impossible calendar date', code: 'DATE_NOT_A_CALENDAR_DATE', severity: 'error', row: 2, good: { text: file('2024-02-29,1000') }, bad: { text: file('2023-02-29,1000') } },
  { rule: 'timestamp instead of date', code: 'DATE_IS_TIMESTAMP', severity: 'error', row: 3, good: { text: file('2024-01-01,1000', '2024-01-02,1001') }, bad: { text: file('2024-01-01,1000', '2024-01-02T00:00:00Z,1001') } },
  { rule: 'date does not match the selected format', code: 'DATE_FORMAT_INVALID', severity: 'error', row: 3, good: { text: GOOD_TEXT }, bad: { text: file('2024-01-01,1000', '02/01/2024,1001') } },
  { rule: 'empty date', code: 'DATE_EMPTY', severity: 'error', row: 2, good: { text: GOOD_TEXT }, bad: { text: file(',1000') } },
  {
    rule: 'date before entitlement scope start',
    code: 'DATE_OUTSIDE_ENTITLEMENT_SCOPE',
    severity: 'error',
    row: 2,
    good: { text: file('2024-01-02,1001', '2024-01-03,1002'), c: { entitlementDateScope: { from: '2024-01-02', to: '2024-01-03' } } },
    bad: { text: file('2024-01-01,1000', '2024-01-02,1001'), c: { entitlementDateScope: { from: '2024-01-02', to: '2024-01-03' } } },
  },
  {
    rule: 'date after entitlement scope end',
    code: 'DATE_OUTSIDE_ENTITLEMENT_SCOPE',
    severity: 'error',
    row: 3,
    good: { text: file('2024-01-02,1001', '2024-01-03,1002'), c: { entitlementDateScope: { to: '2024-01-03' } } },
    bad: { text: file('2024-01-02,1001', '2024-01-04,1003'), c: { entitlementDateScope: { to: '2024-01-03' } } },
  },
  { rule: 'date before 1900', code: 'DATE_OUTSIDE_ENTITLEMENT_SCOPE', severity: 'error', row: 2, good: { text: file('1900-01-02,1000') }, bad: { text: file('1899-12-29,1000') } },
  { rule: 'zero level', code: 'VALUE_NOT_POSITIVE', severity: 'error', row: 3, good: { text: file('2024-01-01,1000', '2024-01-02,0.01') }, bad: { text: file('2024-01-01,1000', '2024-01-02,0') } },
  { rule: 'negative level', code: 'VALUE_NOT_POSITIVE', severity: 'error', row: 3, good: { text: file('2024-01-01,1000', '2024-01-02,5') }, bad: { text: file('2024-01-01,1000', '2024-01-02,-5') } },
  { rule: 'NaN level', code: 'VALUE_NOT_FINITE', severity: 'error', row: 2, good: { text: file('2024-01-01,1000') }, bad: { text: file('2024-01-01,NaN') } },
  { rule: 'Infinity level', code: 'VALUE_NOT_FINITE', severity: 'error', row: 2, good: { text: file('2024-01-01,1000') }, bad: { text: file('2024-01-01,Infinity') } },
  { rule: 'percentage instead of level', code: 'VALUE_IS_PERCENT', severity: 'error', row: 2, good: { text: file('2024-01-01,1.2') }, bad: { text: file('2024-01-01,1.2%') } },
  { rule: 'placeholder N/A', code: 'VALUE_PLACEHOLDER', severity: 'error', row: 2, good: { text: file('2024-01-01,1000') }, bad: { text: file('2024-01-01,N/A') } },
  { rule: 'empty level', code: 'VALUE_EMPTY', severity: 'error', row: 2, good: { text: file('2024-01-01,1000') }, bad: { text: file('2024-01-01,') } },
  { rule: 'scientific notation', code: 'VALUE_SCIENTIFIC', severity: 'error', row: 2, good: { text: file('2024-01-01,100000') }, bad: { text: file('2024-01-01,1e5') } },
  { rule: 'more than 6 decimals', code: 'VALUE_TOO_PRECISE', severity: 'error', row: 2, good: { text: file('2024-01-01,1000.123456') }, bad: { text: file('2024-01-01,1000.1234567') } },
  { rule: 'currency symbol in level', code: 'VALUE_HAS_CURRENCY', severity: 'error', row: 2, good: { text: file('2024-01-01,1000') }, bad: { text: file('2024-01-01,₹1000') } },
  {
    rule: 'conflicting duplicate rows',
    code: 'DUPLICATE_CONFLICT',
    severity: 'error',
    row: 3,
    good: { text: file('2024-01-01,1000', '2024-01-02,1001', '2024-01-03,1002') },
    bad: { text: file('2024-01-01,1000', '2024-01-02,1001', '2024-01-02,1002') },
  },
  {
    rule: 'new-history upload conflicting with a published level',
    code: 'CONFLICT_WITH_PUBLISHED',
    severity: 'error',
    row: 2,
    good: { text: file('2024-01-01,1000'), c: { existing: existingOf({ [TRI]: { '2024-01-01': 1000 } }) } },
    bad: { text: file('2024-01-01,1000'), c: { existing: existingOf({ [TRI]: { '2024-01-01': 999 } }) } },
  },
  {
    rule: 'correction with nothing to correct',
    code: 'CORRECTION_TARGET_MISSING',
    severity: 'error',
    row: 2,
    good: { text: file('2024-01-01,1001'), p: { mode: 'correction' }, c: { existing: existingOf({ [TRI]: { '2024-01-01': 1000 } }) } },
    bad: { text: file('2024-01-01,1001'), p: { mode: 'correction' }, c: { existing: existingOf({ [TRI]: { '2024-01-02': 1000 } }) } },
  },
  { rule: 'unknown benchmark', code: 'BENCHMARK_UNKNOWN', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { benchmarkKey: 'IN_NOT_A_BENCHMARK' } } },
  { rule: 'inactive benchmark', code: 'BENCHMARK_INACTIVE', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { benchmarkKey: OFF } } },
  { rule: 'return variant differs from the catalogue', code: 'VARIANT_MISMATCH', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { returnVariant: 'price' } } },
  { rule: 'net total return declared for a TRI benchmark', code: 'VARIANT_MISMATCH', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { returnVariant: 'net_total_return' } } },
  { rule: 'currency differs from the catalogue', code: 'CURRENCY_MISMATCH', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { currencyCode: 'USD' } } },
  { rule: 'benchmark not chosen', code: 'BENCHMARK_REQUIRED', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { benchmarkKey: undefined } } },
  { rule: 'malformed currency code', code: 'CURRENCY_INVALID', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { currencyCode: 'inr' } } },
  { rule: 'unsupported mode', code: 'MODE_INVALID', severity: 'error', row: null, good: { text: GOOD_TEXT }, bad: { text: GOOD_TEXT, p: { mode: 'overwrite' as UploadParams['mode'] } } },
  { rule: 'identical duplicate collapsed', code: 'DUPLICATE_IDENTICAL_COLLAPSED', severity: 'warning', row: 4, good: { text: GOOD_TEXT }, bad: { text: file('2024-01-01,1000', '2024-01-02,1001', '2024-01-02,1001') } },
  { rule: 'weekend-dated row', code: 'WEEKEND_ROW', severity: 'warning', row: 3, good: { text: file('2024-01-05,1000', '2024-01-08,1001') }, bad: { text: file('2024-01-05,1000', '2024-01-06,1001', '2024-01-08,1002') } },
  { rule: 'large day-over-day move', code: 'LARGE_MOVE', severity: 'warning', row: 3, good: { text: file('2024-01-01,1000', '2024-01-02,1090') }, bad: { text: file('2024-01-01,1000', '2024-01-02,1120') } },
  { rule: 'suspected rebasing', code: 'SUSPECTED_SCALE_CHANGE', severity: 'warning', row: 3, good: { text: file('2024-01-01,1000', '2024-01-02,5000') }, bad: { text: file('2024-01-01,1000', '2024-01-02,5001') } },
  { rule: 'suspected rebasing downwards', code: 'SUSPECTED_SCALE_CHANGE', severity: 'warning', row: 3, good: { text: file('2024-01-01,1000', '2024-01-02,200') }, bad: { text: file('2024-01-01,1000', '2024-01-02,199') } },
  { rule: 'coverage gap of 4 weekdays', code: 'COVERAGE_GAP', severity: 'warning', row: null, good: { text: file('2024-01-01,1000', '2024-01-05,1001') }, bad: { text: file('2024-01-01,1000', '2024-01-08,1001') } },
];

describe('rule table with negative controls', () => {
  it.each(RULES.map((r) => [r.rule, r] as const))('%s', (_name, rule) => {
    const good = run(rule.good.text ?? GOOD_TEXT, rule.good.p, rule.good.c);
    expect(find(good, rule.code), `control must not raise ${rule.code}`).toBeUndefined();
    if (rule.severity === 'error') expect(good.hardErrorCount, 'control must be fully valid').toBe(0);

    const bad = run(rule.bad.text ?? GOOD_TEXT, rule.bad.p, rule.bad.c);
    const issue = find(bad, rule.code);
    expect(issue, `expected ${rule.code}`).toBeDefined();
    expect(issue?.severity).toBe(rule.severity);
    if (rule.row !== undefined) expect(issue?.rowNumber).toBe(rule.row);
    if (rule.severity === 'error') expect(bad.hardErrorCount).toBeGreaterThan(0);
    else expect(bad.hardErrorCount).toBe(0);
  });
});

describe('errors never leak into staging', () => {
  it('rows with errors are reported with their source row and are not staged; valid rows still are', () => {
    const r = run(file('2024-01-01,1000', '2024-01-02,N/A', '2024-01-03,1002', 'not-a-date,1003'));
    expect(r.staged.map((s) => s.rowNumber)).toEqual([2, 4]);
    expect(errors(r).map((i) => [i.rowNumber, i.code, i.column])).toEqual([
      [3, 'VALUE_PLACEHOLDER', 'value'],
      [5, 'DATE_FORMAT_INVALID', 'date'],
    ]);
    expect(r.rowsTotal).toBe(4);
    expect(r.rowsValid).toBe(2);
    expect(r.rowsInvalid).toBe(2);
    expect(r.hardErrorCount).toBe(2);
  });

  it('caps rawExcerpt at 120 characters', () => {
    const r = run(file(`2024-01-01,${'x'.repeat(300)}`));
    const issue = errors(r)[0];
    expect(issue.rawExcerpt).toBeDefined();
    expect(issue.rawExcerpt!.length).toBeLessThanOrEqual(120);
  });
});

describe('duplicates within the file', () => {
  it('identical duplicates are kept once and warned about', () => {
    const r = run(file('2024-01-01,1000', '2024-01-02,1001', '2024-01-02,1001.00', '2024-01-03,1002'));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => s.rowNumber)).toEqual([2, 3, 5]);
    expect(r.duplicatesCollapsed).toBe(1);
    expect(r.rowsValid).toBe(4);
    const w = r.issues.filter((i) => i.code === 'DUPLICATE_IDENTICAL_COLLAPSED');
    expect(w.map((i) => [i.rowNumber, i.severity])).toEqual([[4, 'warning']]);
  });

  it('conflicting duplicates error on BOTH rows and neither is staged', () => {
    const r = run(file('2024-01-01,1000', '2024-01-02,1001', '2024-01-02,1002', '2024-01-03,1003'));
    const dup = r.issues.filter((i) => i.code === 'DUPLICATE_CONFLICT');
    expect(dup.map((i) => i.rowNumber)).toEqual([3, 4]);
    expect(dup[0].message).toContain('rows 3, 4');
    expect(r.staged.map((s) => s.date)).toEqual(['2024-01-01', '2024-01-03']);
    expect(r.rowsInvalid).toBe(2);
  });

  it('three rows where only one differs are all conflicts', () => {
    const r = run(file('2024-01-02,1001', '2024-01-02,1001', '2024-01-02,1005'));
    expect(r.issues.filter((i) => i.code === 'DUPLICATE_CONFLICT')).toHaveLength(3);
    expect(r.staged).toEqual([]);
  });

  it('the same date under two different benchmarks is NOT a duplicate', () => {
    const text = `benchmark_key,date,value\n${TRI},2024-01-02,1001\n${TRI2},2024-01-02,500\n`;
    const r = run(text, { shape: 'multi', benchmarkKey: undefined });
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged).toHaveLength(2);
  });
});

describe('classification against published levels and the two modes', () => {
  const existing = existingOf({ [TRI]: { '2024-01-01': 1000, '2024-01-02': 1001.5000004 } });

  it('new_history: identical within 1e-6 is skipped-as-identical, new is new, different is a conflict', () => {
    const r = run(file('2024-01-01,1000', '2024-01-02,1001.5', '2024-01-03,1002', '2024-01-02,1001.5'), {}, { existing });
    expect(r.staged.map((s) => [s.date, s.classification, s.existing])).toEqual([
      ['2024-01-01', 'identical', 1000],
      ['2024-01-02', 'identical', 1001.5000004],
      ['2024-01-03', 'new', null],
    ]);
    expect(r.hardErrorCount).toBe(0);
    expect(r.perBenchmark[0]).toMatchObject({ newRows: 1, identicalRows: 2, correctionRows: 0 });
    const conflict = run(file('2024-01-01,1000', '2024-01-02,1002'), {}, { existing });
    expect(find(conflict, 'CONFLICT_WITH_PUBLISHED')?.message).toContain('correction mode');
    expect(conflict.staged.map((s) => s.date)).toEqual(['2024-01-01']);
  });

  it('correction: a different level becomes a correction with the before value; missing targets are errors', () => {
    const r = run(file('2024-01-01,1000', '2024-01-02,1002', '2024-01-03,1003'), { mode: 'correction' }, { existing });
    expect(r.staged.map((s) => [s.date, s.classification, s.existing])).toEqual([
      ['2024-01-01', 'identical', 1000],
      ['2024-01-02', 'correction', 1001.5000004],
    ]);
    const missing = find(r, 'CORRECTION_TARGET_MISSING');
    expect(missing?.rowNumber).toBe(4);
    expect(r.perBenchmark[0]).toMatchObject({ newRows: 0, identicalRows: 1, correctionRows: 1 });
    expect(r.hardErrorCount).toBe(1);
  });
});

describe('review flags: kept, flagged, acknowledged -- never rejected or dropped', () => {
  it('weekend rows stay in staging with a flag and require an acknowledgement', () => {
    const r = run(file('2024-01-05,1000', '2024-01-06,1001', '2024-01-07,1002', '2024-01-08,1003'));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged).toHaveLength(4);
    expect(r.staged.map((s) => s.flags)).toEqual([[], ['weekend'], ['weekend'], []]);
    const w = r.issues.filter((i) => i.code === 'WEEKEND_ROW');
    expect(w).toHaveLength(1); // aggregated
    expect(w[0].message).toContain('2 row(s)');
    expect(r.requiredAcknowledgements).toEqual(['weekend_rows']);
  });

  it('large moves up and down are warnings only (the rows stay staged)', () => {
    const r = run(file('2024-01-01,1000', '2024-01-02,1150', '2024-01-03,980'));
    expect(r.hardErrorCount).toBe(0);
    expect(r.issues.filter((i) => i.code === 'LARGE_MOVE').map((i) => i.rowNumber)).toEqual([3, 4]);
    expect(r.staged.map((s) => s.flags)).toEqual([[], ['large_move'], ['large_move']]);
    expect(r.requiredAcknowledgements).toEqual(['large_moves']);
  });

  it('a 10% move exactly is not flagged; a 5x jump is a scale change (not a large move)', () => {
    expect(find(run(file('2024-01-01,1000', '2024-01-02,1100')), 'LARGE_MOVE')).toBeUndefined();
    const s = run(file('2024-01-01,1000', '2024-01-02,10000'));
    expect(find(s, 'SUSPECTED_SCALE_CHANGE')?.rowNumber).toBe(3);
    expect(find(s, 'LARGE_MOVE')).toBeUndefined();
    expect(s.hardErrorCount).toBe(0);
    expect(s.staged).toHaveLength(2);
    expect(s.requiredAcknowledgements).toEqual(['scale_change']);
    // exactly 5x is a large move, not (yet) a scale change
    const five = run(file('2024-01-01,1000', '2024-01-02,5000'));
    expect(find(five, 'SUSPECTED_SCALE_CHANGE')).toBeUndefined();
    expect(find(five, 'LARGE_MOVE')).toBeDefined();
  });

  it('compares the first and last incoming level with the nearest published neighbour', () => {
    const before = run(file('2024-01-01,210', '2024-01-02,211'), {}, { existing: existingOf({ [TRI]: { '2023-12-29': 21000 } }) });
    const issue = find(before, 'SUSPECTED_SCALE_CHANGE');
    expect(issue?.rowNumber).toBe(2);
    expect(issue?.message).toContain('published level 21000');
    expect(before.hardErrorCount).toBe(0);
    const after = run(file('2024-01-01,1000', '2024-01-02,1001'), {}, { existing: existingOf({ [TRI]: { '2024-01-10': 100 } }) });
    expect(after.issues.filter((i) => i.code === 'SUSPECTED_SCALE_CHANGE').map((i) => i.rowNumber)).toEqual([2, 3]);
    // control: a consistent neighbour raises nothing
    const fine = run(file('2024-01-01,21050', '2024-01-02,21060'), {}, { existing: existingOf({ [TRI]: { '2023-12-29': 21000 } }) });
    expect(find(fine, 'SUSPECTED_SCALE_CHANGE')).toBeUndefined();
  });

  it('coverage gaps need MORE than 3 consecutive missing weekdays and are never filled in', () => {
    const three = run(file('2024-01-01,1000', '2024-01-05,1001'));
    expect(three.perBenchmark[0].gaps).toEqual([]);
    expect(three.requiredAcknowledgements).toEqual([]);
    const four = run(file('2024-01-01,1000', '2024-01-08,1001', '2024-01-09,1002'));
    expect(four.perBenchmark[0].gaps).toEqual([{ from: '2024-01-02', to: '2024-01-05', weekdaysMissing: 4 }]);
    expect(four.requiredAcknowledgements).toEqual(['coverage_gaps']);
    expect(four.hardErrorCount).toBe(0);
    // nothing synthesised or interpolated: exactly the incoming dates are staged
    expect(four.staged.map((s) => s.date)).toEqual(['2024-01-01', '2024-01-08', '2024-01-09']);
  });

  it('weekdays already published inside the range are not gaps', () => {
    const text = file('2024-01-01,1000', '2024-01-10,1001');
    const filled = run(text, { mode: 'new_history' }, { existing: existingOf({ [TRI]: { '2024-01-04': 1003, '2024-01-08': 1004 } }) });
    expect(filled.perBenchmark[0].gaps).toEqual([]);
    const bare = run(text);
    expect(bare.perBenchmark[0].gaps).toHaveLength(1);
  });

  it('acknowledgements come back in a stable order', () => {
    const text = file('2024-01-01,1000', '2024-01-02,1200', '2024-01-06,1201', '2024-01-20,12010');
    const r = run(text);
    expect(r.requiredAcknowledgements).toEqual(['scale_change', 'large_moves', 'weekend_rows', 'coverage_gaps']);
  });
});

describe('multi-benchmark files: identity is validated on every row', () => {
  const mk = (...rows: string[]) => `benchmark_key,date,value\n${rows.join('\n')}\n`;
  const multi = (text: string, c: Partial<ValidationContext> = {}) => run(text, { shape: 'multi', benchmarkKey: undefined }, c);

  it('empty and unknown keys are errors on their own row; other rows are unaffected', () => {
    const r = multi(mk(`${TRI},2024-01-01,1000`, `,2024-01-01,5`, `IN_NOPE,2024-01-01,5`, `${TRI2},2024-01-01,500`));
    expect(find(r, 'BENCHMARK_KEY_EMPTY')?.rowNumber).toBe(3);
    expect(find(r, 'BENCHMARK_UNKNOWN')?.rowNumber).toBe(4);
    expect(r.staged.map((s) => s.benchmarkKey)).toEqual([TRI, TRI2]);
    expect(r.rowsInvalid).toBe(2);
  });

  it('variant, currency and inactive checks apply to EVERY row of a multi file', () => {
    const r = multi(mk(`${TRI},2024-01-01,1000`, `${PRI},2024-01-01,22000`, `${USD},2024-01-01,5000`, `${OFF},2024-01-01,1`));
    expect(find(r, 'VARIANT_MISMATCH')?.rowNumber).toBe(3);
    expect(find(r, 'CURRENCY_MISMATCH')?.rowNumber).toBe(4);
    expect(find(r, 'BENCHMARK_INACTIVE')?.rowNumber).toBe(5);
    expect(r.staged.map((s) => s.benchmarkKey)).toEqual([TRI]);
    expect(r.hardErrorCount).toBe(3);
  });

  it('a key-level problem is reported once with the number of rows it affects', () => {
    const r = multi(mk(`${PRI},2024-01-01,22000`, `${PRI},2024-01-02,22010`, `${PRI},2024-01-03,22020`));
    const issues = r.issues.filter((i) => i.code === 'VARIANT_MISMATCH');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 rows affected');
    expect(r.rowsInvalid).toBe(3);
    expect(r.staged).toEqual([]);
  });

  it('keys are matched exactly (case and whitespace-trimmed only at the edges)', () => {
    const r = multi(mk(`  ${TRI}  ,2024-01-01,1000`, `${TRI.toLowerCase()},2024-01-02,1001`));
    expect(r.staged.map((s) => s.date)).toEqual(['2024-01-01']);
    expect(find(r, 'BENCHMARK_UNKNOWN')?.rowNumber).toBe(3);
  });
});

describe('provider exports with an index-name column', () => {
  const price = (rows: string[]) => `Index Name,Date,Open,High,Low,Close\n${rows.join('\n')}\n`;
  const p = (o: Partial<UploadParams> = {}) => ({
    shape: 'provider_export' as const,
    providerLayoutId: 'nse_price_export',
    returnVariant: 'price' as const,
    benchmarkKey: PRI,
    dateFormat: 'DD MMM YYYY' as const,
    ...o,
  });

  it('single index chosen: all rows must carry the same index name', () => {
    const ok = run(price(['Nifty 50,01 Jan 2024,1,2,3,22000', 'Nifty 50,02 Jan 2024,1,2,3,22100']), p());
    expect(ok.hardErrorCount).toBe(0);
    expect(ok.staged.map((s) => [s.benchmarkKey, s.value])).toEqual([[PRI, 22000], [PRI, 22100]]);
    const mixed = run(price(['Nifty 50,01 Jan 2024,1,2,3,22000', 'Nifty Bank,01 Jan 2024,1,2,3,48000']), p());
    expect(find(mixed, 'INDEX_NAME_MULTIPLE_WITHOUT_MAP')).toBeDefined();
    expect(mixed.staged).toEqual([]);
    expect(mixed.rowsInvalid).toBe(mixed.rowsTotal);
  });

  it('indexNameToKey maps names exactly; unmapped names are excluded and DISCLOSED, not silently dropped', () => {
    const rows = ['Nifty 50,01 Jan 2024,1,2,3,22000', 'Nifty Next 50,01 Jan 2024,1,2,3,60000', 'Nifty Bank,01 Jan 2024,1,2,3,48000', 'Nifty Bank,02 Jan 2024,1,2,3,48100'];
    const r = run(price(rows), p({ benchmarkKey: undefined, indexNameToKey: { 'Nifty 50': PRI, 'Nifty Next 50': PRI2 } }));
    expect(r.hardErrorCount).toBe(0);
    expect(r.staged.map((s) => s.benchmarkKey)).toEqual([PRI2, PRI].sort());
    expect(r.rowsExcluded).toBe(2);
    expect(r.rowsTotal).toBe(4);
    expect(r.rowsValid).toBe(2);
    const w = find(r, 'INDEX_NAME_NOT_SELECTED');
    expect(w?.severity).toBe('warning');
    expect(w?.message).toContain('Nifty Bank (2)');
    // names must match exactly: a differently-cased name is NOT mapped
    const exact = run(price(['nifty 50,01 Jan 2024,1,2,3,22000']), p({ benchmarkKey: undefined, indexNameToKey: { 'Nifty 50': PRI } }));
    expect(exact.staged).toEqual([]);
    expect(exact.rowsExcluded).toBe(1);
  });

  it('a mapped key is still checked against the catalogue (variant) row by row', () => {
    const r = run(price(['Nifty 50,01 Jan 2024,1,2,3,22000']), p({ benchmarkKey: undefined, indexNameToKey: { 'Nifty 50': TRI } }));
    expect(find(r, 'VARIANT_MISMATCH')?.rowNumber).toBe(2);
  });

  it('a single benchmark and an index-name map together are refused; neither is also refused', () => {
    const rows = ['Nifty 50,01 Jan 2024,1,2,3,22000'];
    expect(find(run(price(rows), p({ indexNameToKey: { 'Nifty 50': PRI } })), 'BENCHMARK_AND_INDEX_MAP_BOTH')).toBeDefined();
    expect(find(run(price(rows), p({ benchmarkKey: undefined })), 'BENCHMARK_REQUIRED')).toBeDefined();
  });

  it('a layout whose variant conflicts with the declaration blocks everything', () => {
    const r = run('Date,Total Returns Index\n01 Jan 2024,1000\n', { shape: 'provider_export', returnVariant: 'price', benchmarkKey: PRI, dateFormat: 'DD MMM YYYY' });
    expect(find(r, 'VARIANT_LAYOUT_CONFLICT')?.severity).toBe('error');
    expect(r.staged).toEqual([]);
    expect(r.rowsValid).toBe(0);
    expect(r.rowsInvalid).toBe(r.rowsTotal);
  });

  it('an explicit column map works and records the mapping', () => {
    const text = 'Trade Date,Settle,Notes\n2024-01-01,1000,a\n2024-01-02,1001,b\n';
    const r = run(text, { shape: 'provider_export', columnMap: { date: 'Trade Date', value: 'Settle' } });
    expect(r.hardErrorCount).toBe(0);
    expect(r.disclosure.layoutId).toBe('explicit_column_map');
    expect(r.disclosure.columnMapping).toEqual({ date: 'Trade Date', value: 'Settle' });
    const bad = run(text, { shape: 'provider_export', columnMap: { date: 'Trade Date', value: 'Close' } });
    expect(find(bad, 'MAPPED_COLUMN_MISSING')).toBeDefined();
    expect(bad.staged).toEqual([]);
  });
});

describe('explicit date format and number locale are honoured end to end', () => {
  it('03/04/2024 stages different dates under DD/MM and MM/DD; 13/04/2024 fails month-first', () => {
    const dm = run(file('03/04/2024,1000'), { dateFormat: 'DD/MM/YYYY' });
    const md = run(file('03/04/2024,1000'), { dateFormat: 'MM/DD/YYYY' });
    expect(dm.staged[0].date).toBe('2024-04-03');
    expect(md.staged[0].date).toBe('2024-03-04');
    const bad = run(file('13/04/2024,1000'), { dateFormat: 'MM/DD/YYYY' });
    expect(find(bad, 'DATE_NOT_A_CALENDAR_DATE')?.rowNumber).toBe(2);
    expect(bad.staged).toEqual([]);
  });

  it('thousands separators are interpreted per locale, never inferred', () => {
    const quoted = 'date,value\n2024-01-01,"1,23,456.50"\n';
    expect(run(quoted, { numberLocale: 'in' }).staged[0].value).toBe(123456.5);
    expect(find(run(quoted, { numberLocale: 'en' }), 'VALUE_BAD_GROUPING')).toBeDefined();
    expect(find(run(quoted, { numberLocale: 'plain' }), 'VALUE_BAD_GROUPING')).toBeDefined();
    const eu = 'date;value\n2024-01-01;1.234,50\n';
    expect(run(eu, { numberLocale: 'eu' }).staged[0].value).toBe(1234.5);
    expect(run(eu, { numberLocale: 'plain' }).hardErrorCount).toBeGreaterThan(0);
    expect(run(eu, { numberLocale: 'en' }).hardErrorCount).toBeGreaterThan(0);
  });
});

describe('limits, empty files and reader problems', () => {
  it('rows beyond the limit are a hard TOO_MANY_ROWS and nothing is staged', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `2024-01-0${i + 1},${1000 + i}`);
    const r = run(file(...rows), {}, { limits: { maxRows: 4 } });
    expect(find(r, 'TOO_MANY_ROWS')?.severity).toBe('error');
    expect(r.staged).toEqual([]);
    expect(run(file(...rows), {}, { limits: { maxRows: 5 } }).hardErrorCount).toBe(0);
  });

  it('a header-only file is NO_DATA_ROWS; an empty file has no header row', () => {
    expect(find(run('date,value\n'), 'NO_DATA_ROWS')?.severity).toBe('error');
    expect(find(run(''), 'HEADER_ROW_MISSING')).toBeDefined();
    expect(find(run('date,value\n\n,\n'), 'NO_DATA_ROWS')).toBeDefined();
  });

  it('reader problems become hard errors but row-level checks still run', () => {
    const r = run('date,value\n2024-01-01\n2024-01-02,1000\n');
    expect(find(r, 'RAGGED_ROW')?.rowNumber).toBe(2);
    expect(find(r, 'VALUE_EMPTY')?.rowNumber).toBe(2);
    expect(r.staged.map((s) => s.rowNumber)).toEqual([3]);
    expect(r.hardErrorCount).toBeGreaterThanOrEqual(2);
  });

  it('an ambiguous delimiter blocks the upload', () => {
    const r = run('date,value;x\n2024-01-01,1000;1\n', {}, {});
    expect(find(r, 'AMBIGUOUS_DELIMITER')).toBeDefined();
    expect(r.hardErrorCount).toBeGreaterThan(0);
  });

  it('an unusable "today" is refused rather than assumed', () => {
    const r = run(GOOD_TEXT, {}, { todayIso: 'yesterday' });
    expect(find(r, 'CONTEXT_INVALID')).toBeDefined();
    expect(r.staged).toEqual([]);
  });

  it('source row numbers are the numbers the operator sees (preamble, blank lines, header row inclusive)', () => {
    const text = 'Title line\n\ndate,value\n2024-01-01,1000\nnot-a-date,1001\n,1002\n';
    const r = run(text, { headerRow: 3 });
    expect(errors(r).map((i) => i.rowNumber)).toEqual([5, 6]);
    expect(r.staged.map((s) => s.rowNumber)).toEqual([4]);
    expect(r.disclosure.headerRow).toBe(3);
  });

  it('a quoted multi-line cell shifts the physical row numbers that follow it', () => {
    const text = 'date,value\n2024-01-01,"10\n00"\n2024-01-02,N/A\n';
    const r = run(text);
    expect(errors(r).map((i) => [i.rowNumber, i.code])).toEqual([[2, 'VALUE_NOT_NUMERIC'], [4, 'VALUE_PLACEHOLDER']]);
  });
});
