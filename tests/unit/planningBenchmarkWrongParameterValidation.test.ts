// Planning Benchmarks upload: wrong-parameter protection in the preview check.
// Evidence label: UNIT-TESTED (pure validator, lists derived through the real loader from an in-memory fake).
//
// A row that names a dataset that is not open for upload, a metric that is not registered, a unit different
// from the metric's, a cohort that is not registered, or (target ranges) a source that is not the dataset's own,
// is refused in the check with a plain-language message that NAMES the allowed values, and may add a
// "did you mean" hint that is never applied for the person.
//
// FAILING-FIRST STATUS (recorded in TEMPLATE_ALLOWED_VALUES_REPORT.md): the tests marked NEW fail on the base
// (7054e36) validator, which ignores `allowed`. The tests marked CONTROL describe behaviour the base already had
// (unknown metric, unit mismatch) and pass before and after; they are here so the behaviour cannot be lost.
import { describe, expect, it } from 'vitest';
import { createInMemoryDb } from './support/inMemorySupabase';
import { FIXTURE_TODAY, pbReferenceTables } from './support/pbAllowedFixture';
import { loadAllowedValues, type AllowedValuesOk } from '@/lib/planning-benchmarks/allowedValues';
import { TEMPLATE_VERSION, columnNames, type UploadKind } from '@/lib/planning-benchmarks/uploadSchema';
import { readUploadFile, validateUploadTable, type UploadIssue } from '@/lib/planning-benchmarks/uploadValidate';

const csvq = (s: string) => (/[",\n]/.test(s) ? `"${s.split('"').join('""')}"` : s);
function fileOf(kind: UploadKind, rows: Array<Record<string, string>>): string {
  const cols = columnNames(kind);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvq(r[c] ?? '')).join(','))].join('\n') + '\n';
}
const values = (over: Record<string, string> = {}): Record<string, string> => ({
  template_version: TEMPLATE_VERSION.values, dataset_name: 'AU household wealth distribution', dataset_version: '1.0', cohort_code: '', metric_code: 'net_worth', statistic_type: 'median',
  value_numeric: '559000', unit: 'currency', original_currency: 'AUD', base_date: '30/06/2020', is_derived: 'false', source_release: 'ABS SIH', observation_period_start: '01/07/2019',
  source_file: 'sih.xlsx', source_locator: 'Table 1', retrieval_date: '01/10/2026', ...over,
});
const ranges = (over: Record<string, string> = {}): Record<string, string> => ({
  template_version: TEMPLATE_VERSION.target_ranges, dataset_name: 'FHIP Planning Benchmarks v1.0', dataset_version: '1.0', metric_code: 'savings_rate', source_name: 'FHIP_PLANNING_V1',
  country_code: 'AU', household_type: 'single', band_label: 'strong', band_tier: '4', lower_bound: '20', direction: 'higher_better', evidence_level: 'research_informed', model_version: 'fhip-1',
  source_release: 'FHIP', observation_period_start: '01/02/2026', source_file: 'x.pdf', source_locator: 'p3', retrieval_date: '01/10/2026', ...over,
});

async function lists(): Promise<AllowedValuesOk> {
  const db = createInMemoryDb();
  db.reset(pbReferenceTables() as Record<string, never[]>);
  const r = await loadAllowedValues(db.client as never, FIXTURE_TODAY);
  if (r.state !== 'ok') throw new Error('lists');
  return r;
}

async function check(kind: UploadKind, rows: Array<Record<string, string>>, mutate?: (av: AllowedValuesOk) => AllowedValuesOk) {
  const av0 = await lists();
  const av = mutate ? mutate(av0) : av0;
  const read = readUploadFile({ fileName: 'x.csv', bytes: new TextEncoder().encode(fileOf(kind, rows)) });
  if (!read.ok) throw new Error('read');
  return validateUploadTable(read.table, kind, { todayIso: FIXTURE_TODAY, metricUnits: new Map(av.metrics.map((m) => [m.code, m.unit])), allowed: av });
}
const errs = (issues: UploadIssue[]) => issues.filter((i) => i.severity === 'error');
const find = (issues: UploadIssue[], code: string) => issues.find((i) => i.code === code);

describe('wrong dataset', () => {
  it('NEW: a dataset that is not registered is refused, names the datasets open for upload, and hints a near miss without changing the file', async () => {
    const out = await check('values', [values({ dataset_name: 'AU household wealth distrbution' })]);
    const i = find(out.issues, 'DATASET_NOT_FOUND')!;
    expect(i).toBeTruthy();
    expect(i.rowNumber).toBe(2);
    expect(i.column).toBe('dataset_name');
    expect(i.message).toContain('Datasets open for upload (3)');
    expect(i.message).toContain('AU household wealth distribution (version 1.0)');
    expect(i.message).toContain('FHIP Planning Benchmarks v1.0 (version 1.0)');
    expect(i.message).toContain('Did you mean "AU household wealth distribution"?');
    expect(i.message).toMatch(/never creates a dataset/);
    // never auto-corrected: nothing is staged from a refused row
    expect(out.rows).toHaveLength(0);
    expect(out.errorCount).toBeGreaterThan(0);
  });

  it('NEW: the right name with the wrong version says which versions exist', async () => {
    const out = await check('values', [values({ dataset_version: '2.0' })]);
    const i = find(out.issues, 'DATASET_NOT_FOUND')!;
    expect(i.message).toContain('exists, but not as version "2.0"');
    expect(i.message).toContain('Its version(s): 1.0');
  });

  it('NEW: a dataset that is superseded (or suspended or archived) is refused as not open, naming the open ones', async () => {
    for (const [name, version, status] of [['AU household debt context', '1.0', 'superseded'], ['Archived legacy set', '0.9', 'archived']] as const) {
      const out = await check('values', [values({ dataset_name: name, dataset_version: version })]);
      const i = find(out.issues, 'DATASET_NOT_OPEN')!;
      expect(i, name).toBeTruthy();
      expect(i.message).toContain(`is ${status}, so it cannot receive an upload`);
      expect(i.message).toContain('Datasets open for upload (3)');
      expect(out.rows).toHaveLength(0);
    }
  });

  it('NEW: the same wrong dataset on many rows is reported once (first row), but every row is still refused', async () => {
    const rows = [values({ dataset_name: 'Nope' }), values({ dataset_name: 'Nope', statistic_type: 'mean' }), values({ dataset_name: 'Nope', statistic_type: 'p10' })];
    const out = await check('values', rows);
    expect(out.issues.filter((i) => i.code === 'DATASET_NOT_FOUND')).toHaveLength(1);
    expect(out.rows).toHaveLength(0);
  });

  it('NEW: an open dataset (including a draft one) passes the dataset check; the file can name it for any kind', async () => {
    expect(errs((await check('values', [values()])).issues)).toEqual([]);
    expect(errs((await check('target_ranges', [ranges()])).issues)).toEqual([]);
    const draft = await check('values', [values({ dataset_name: 'India household consumption expenditure (rural/urban)' })]);
    expect(draft.issues.some((i) => i.code === 'DATASET_NOT_OPEN' || i.code === 'DATASET_NOT_FOUND')).toBe(false);
  });
});

describe('wrong metric', () => {
  it('CONTROL (existing behaviour) + NEW message: an unregistered metric is refused; the message now names the registered metrics or a near miss', async () => {
    const hint = await check('values', [values({ metric_code: 'net_wurth' })]);
    const i = find(hint.issues, 'UNKNOWN_METRIC')!;
    expect(i.rowNumber).toBe(2);
    expect(i.message).toMatch(/not registered. An upload cannot create metrics/);
    expect(i.message).toContain('Did you mean "net_worth"?'); // NEW
    const far = await check('values', [values({ metric_code: 'qqqqqq' })]);
    const j = find(far.issues, 'UNKNOWN_METRIC')!;
    expect(j.message).toContain('4 metrics are registered'); // NEW
    expect(j.message).toContain('savings_rate'); // NEW
    expect(far.rows).toHaveLength(0);
  });

  it('CONTROL + NEW: the same refusal and the same names for a target-range file', async () => {
    const out = await check('target_ranges', [ranges({ metric_code: 'savings_rte' })]);
    const i = find(out.issues, 'UNKNOWN_METRIC')!;
    expect(i.message).toContain('Did you mean "savings_rate"?');
    expect(out.rows).toHaveLength(0);
  });

  it('NEW: an inactive (retired) metric is a visible warning, not a silent pass', async () => {
    const out = await check('values', [values({ metric_code: 'retired_ratio', unit: 'ratio', original_currency: '' })]);
    expect(find(out.issues, 'METRIC_INACTIVE')?.severity).toBe('warning');
    expect(out.errorCount).toBe(0);
  });
});

describe('pure controls: behaviour the base validator already had (pass before and after the change)', () => {
  it('CONTROL: an unregistered metric and a wrong unit are refused with the row number', async () => {
    const m = await check('values', [values({ metric_code: 'qqqqqq' })]);
    expect(m.issues.some((i) => i.code === 'UNKNOWN_METRIC' && i.rowNumber === 2 && i.severity === 'error')).toBe(true);
    const u = await check('values', [values({ unit: 'percentage', original_currency: '' })]);
    expect(u.issues.some((i) => i.code === 'UNIT_MISMATCH' && i.rowNumber === 2 && i.severity === 'error')).toBe(true);
    expect(m.rows).toHaveLength(0);
    expect(u.rows).toHaveLength(0);
  });
});

describe('wrong unit', () => {
  it('CONTROL (existing behaviour) + NEW wording: a unit different from the metric unit is refused, naming the unit to use', async () => {
    const out = await check('values', [values({ unit: 'percentage', original_currency: '' })]);
    const i = find(out.issues, 'UNIT_MISMATCH')!;
    expect(i.rowNumber).toBe(2);
    expect(i.column).toBe('unit');
    expect(i.message).toContain('defined in "currency"');
    expect(i.message).toContain('Upload this metric in "currency"'); // NEW
    expect(out.rows).toHaveLength(0);
  });
});

describe('wrong cohort', () => {
  it('NEW: a cohort that is not registered is refused (before the database does) and names the registered cohorts or a near miss', async () => {
    const hint = await check('values', [values({ cohort_code: 'au_age_25_43' })]);
    const i = find(hint.issues, 'COHORT_NOT_FOUND')!;
    expect(i.rowNumber).toBe(2);
    expect(i.column).toBe('cohort_code');
    expect(i.message).toContain('Did you mean "AU_AGE_25_34"?');
    expect(i.message).toContain('blank for a country-wide figure');
    const far = await check('values', [values({ cohort_code: 'ZZZ' })]);
    expect(find(far.issues, 'COHORT_NOT_FOUND')!.message).toContain('Registered cohorts (2): AU_AGE_25_34; IN_URBAN_ALL');
    expect(far.rows).toHaveLength(0);
  });

  it('NEW: blank cohort_code (country-wide) and a registered cohort pass', async () => {
    expect(errs((await check('values', [values({ cohort_code: '' })])).issues)).toEqual([]);
    expect(errs((await check('values', [values({ cohort_code: 'IN_URBAN_ALL' })])).issues)).toEqual([]);
  });
});

describe('wrong source on a target-range file', () => {
  it('NEW: source_name that is not the dataset source is refused naming the right source', async () => {
    const out = await check('target_ranges', [ranges({ source_name: 'ABS_SIH_2019_20' })]);
    const i = find(out.issues, 'SOURCE_MISMATCH')!;
    expect(i.message).toContain('the source of the dataset "FHIP Planning Benchmarks v1.0" is "FHIP_PLANNING_V1"');
    expect(out.rows).toHaveLength(0);
  });

  it('NEW: a household type no live band uses is a warning with the known types; a known one is silent', async () => {
    const out = await check('target_ranges', [ranges({ household_type: 'singel' })]);
    const w = find(out.issues, 'HOUSEHOLD_TYPE_NEW')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('family; single');
    expect(w.message).toContain('Did you mean "single"?');
    expect(out.errorCount).toBe(0);
    expect(find((await check('target_ranges', [ranges()])).issues, 'HOUSEHOLD_TYPE_NEW')).toBeUndefined();
  });
});

describe('lists that cannot prove absence do not refuse on absence (NC-A4)', () => {
  it('NEW: when the dataset, metric and cohort lists are incomplete the validator leaves those refusals to the database', async () => {
    const out = await check('values', [values({ dataset_name: 'Unknown set', metric_code: 'unknown_metric', cohort_code: 'UNKNOWN_COHORT' })], (av) => ({
      ...av,
      complete: { datasets: false, metrics: false, cohorts: false, bands: false, mappings: false },
    }));
    expect(out.issues.some((i) => i.code === 'DATASET_NOT_FOUND' || i.code === 'COHORT_NOT_FOUND')).toBe(false);
    // the metric is still refused by the older, unit-map based rule: a metric whose unit is unknown cannot be checked
    expect(find(out.issues, 'UNKNOWN_METRIC')).toBeTruthy();
  });
});
