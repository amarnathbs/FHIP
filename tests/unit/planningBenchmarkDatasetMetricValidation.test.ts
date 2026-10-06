// Planning Benchmarks upload: the dataset to metric mapping in the preview check, the allowed-metrics lists and the
// fallback when the mapping is not installed (migration 0277 not applied yet).
// Evidence label: UNIT-TESTED (pure validator and templates; lists derived through the real loader from an in-memory fake).
//
// FAILING-FIRST STATUS (recorded in DATASET_METRIC_MAPPING_REPORT.md): every test marked NEW fails on the base (52253bb),
// where the validator has no mapping rule and the lists carry no allowed-metrics section.
//
// NAMED NEGATIVE CONTROLS
//   NC-V1  a row whose metric is not mapped to its dataset for its kind is refused (red when the rule is removed);
//   NC-V2  with the mapping not installed the same row is NOT refused but a visible warning is raised (the fallback
//          is a warning, never a silent pass), and that warning is also on the screen, the Read me and the CSV;
//   NC-V3  drift guard: the allowed-metrics rows the Read me, the CSV and the screen print are exactly the pairs the
//          validator accepts, and every registered metric not listed for a dataset and kind is refused.
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createInMemoryDb } from './support/inMemorySupabase';
import { FIXTURE_TODAY, pbReferenceTables } from './support/pbAllowedFixture';
import {
  MAPPING_NOT_INSTALLED_LINE,
  allowedValuesSections,
  datasetMetricsSection,
  isMissingRelation,
  loadAllowedValues,
  loadMappingStatus,
  mappedFor,
  type AllowedValuesOk,
} from '@/lib/planning-benchmarks/allowedValues';
import { buildAllowedValuesCsv, buildTemplateXlsx } from '@/lib/planning-benchmarks/uploadTemplates';
import { TEMPLATE_VERSION, XLSX_README_SHEET, columnNames, type UploadKind } from '@/lib/planning-benchmarks/uploadSchema';
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

async function listsWith(over: Record<string, unknown[] | undefined> = {}): Promise<AllowedValuesOk> {
  const db = createInMemoryDb();
  const tables = { ...(pbReferenceTables() as Record<string, never[]>), ...(over as Record<string, never[]>) };
  for (const k of Object.keys(over)) if (over[k] === undefined) delete (tables as Record<string, unknown>)[k];
  db.reset(tables);
  const r = await loadAllowedValues(db.client as never, FIXTURE_TODAY);
  if (r.state !== 'ok') throw new Error('lists');
  return r;
}
async function check(kind: UploadKind, rows: Array<Record<string, string>>, av?: AllowedValuesOk) {
  const a = av ?? (await listsWith());
  const read = readUploadFile({ fileName: 'x.csv', bytes: new TextEncoder().encode(fileOf(kind, rows)) });
  if (!read.ok) throw new Error('read');
  return validateUploadTable(read.table, kind, { todayIso: FIXTURE_TODAY, metricUnits: new Map(a.metrics.map((m) => [m.code, m.unit])), allowed: a });
}
const find = (issues: UploadIssue[], code: string) => issues.find((i) => i.code === code);

describe('NC-V1: a metric that is not mapped to the dataset for that kind of file is refused', () => {
  it('NEW: names the metrics that ARE allowed (with units), says where the metric is mapped, hints a near miss and changes nothing', async () => {
    const out = await check('values', [values({ metric_code: 'savings_rate', unit: 'percentage', original_currency: '' })]);
    const i = find(out.issues, 'METRIC_NOT_MAPPED')!;
    expect(i).toBeTruthy();
    expect(i.severity).toBe('error');
    expect(i.rowNumber).toBe(2);
    expect(i.column).toBe('metric_code');
    expect(i.message).toContain('"savings_rate" is registered but is not mapped to the dataset "AU household wealth distribution" version 1.0 for observed values files');
    expect(i.message).toContain('Metrics allowed for that dataset in observed values files (2): net_worth (currency); retired_ratio (ratio)');
    expect(i.message).toMatch(/savings_rate is not mapped to any dataset for observed values files yet|mapped to:/);
    expect(i.message).toMatch(/Nothing was changed in your file/);
    expect(out.rows).toHaveLength(0);
    expect(out.errorCount).toBeGreaterThan(0);
  });

  it('NEW: a near miss gets a "did you mean" over the ALLOWED metrics only, and the row is still refused (never auto-corrected)', async () => {
    const out = await check('values', [values({ metric_code: 'net_worht' })]);
    // not registered at all: the older rule refuses it; the mapping rule does not double-report
    expect(find(out.issues, 'UNKNOWN_METRIC')).toBeTruthy();
    expect(find(out.issues, 'METRIC_NOT_MAPPED')).toBeUndefined();
    const av = await listsWith({ benchmark_metric_definitions: [...pbReferenceTables().benchmark_metric_definitions, { id: 'm-nwx', metric_code: 'net_worth_x', metric_name: 'X', category_code: 'assets_networth', unit: 'currency', comparison_direction: 'higher_better', active_flag: true }] });
    const near = await check('values', [values({ metric_code: 'net_worth_x' })], av);
    const i = find(near.issues, 'METRIC_NOT_MAPPED')!;
    expect(i.message).toContain('Did you mean "net_worth"?');
    expect(near.rows).toHaveLength(0);
  });

  it('NEW: the kind of file matters: a metric mapped only for target ranges is refused in a values file, and the message says to use the other kind', async () => {
    const out = await check('values', [values({ dataset_name: 'FHIP Planning Benchmarks v1.0', metric_code: 'savings_rate', unit: 'percentage', original_currency: '' })]);
    const i = find(out.issues, 'METRIC_NOT_MAPPED')!;
    expect(i.message).toContain('No metric is mapped to the dataset "FHIP Planning Benchmarks v1.0" version 1.0 for observed values files yet');
    expect(i.message).toContain('savings_rate is mapped to it for planning target ranges files: use that kind of file');
    const back = await check('target_ranges', [ranges({ dataset_name: 'AU household wealth distribution', source_name: 'ABS_SIH_2019_20' })]);
    expect(find(back.issues, 'METRIC_NOT_MAPPED')!.message).toContain('No metric is mapped to the dataset "AU household wealth distribution"');
  });

  it('NEW: a metric mapped to ANOTHER dataset says which, so the likely mistake (right metric, wrong dataset) is obvious', async () => {
    const av = await listsWith();
    const out = await check('target_ranges', [ranges({ dataset_name: 'India household consumption expenditure (rural/urban)', source_name: 'MOSPI_HCES_2023_24', metric_code: 'savings_rate' })], av);
    const i = find(out.issues, 'METRIC_NOT_MAPPED')!;
    expect(i.message).toContain('savings_rate is mapped to: FHIP Planning Benchmarks v1.0 (version 1.0)');
    expect(i.message).toContain('Metrics allowed for that dataset in planning target ranges files (1): emergency_fund_months (months)');
  });

  it('NEW: a dataset with nothing mapped says so and refuses every row (reported once per problem, every row still refused)', async () => {
    const out = await check('values', [
      values({ dataset_name: 'India household consumption expenditure (rural/urban)', metric_code: 'net_worth' }),
      values({ dataset_name: 'India household consumption expenditure (rural/urban)', metric_code: 'net_worth', statistic_type: 'mean' }),
    ]);
    const mapped = out.issues.filter((x) => x.code === 'METRIC_NOT_MAPPED');
    expect(mapped).toHaveLength(1);
    expect(mapped[0].message).toContain('No metric is mapped to the dataset "India household consumption expenditure (rural/urban)"');
    expect(mapped[0].message).toContain('Upload tab (Dataset metric mapping)');
    expect(out.rows).toHaveLength(0);
  });

  it('CONTROL: a legitimate pair is accepted with no mapping issue', async () => {
    const out = await check('values', [values()]);
    expect(out.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(out.rows).toHaveLength(1);
    const r = await check('target_ranges', [ranges()]);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('a mapped but retired (inactive) metric is accepted with the existing inactive warning', async () => {
    const out = await check('values', [values({ metric_code: 'retired_ratio', unit: 'ratio', original_currency: '' })]);
    expect(find(out.issues, 'METRIC_INACTIVE')?.severity).toBe('warning');
    expect(find(out.issues, 'METRIC_NOT_MAPPED')).toBeUndefined();
  });

  it('a list cut at its read limit does not refuse on absence (the database decides)', async () => {
    const av = await listsWith();
    const cut: AllowedValuesOk = { ...av, complete: { ...av.complete, mappings: false } };
    const out = await check('values', [values({ metric_code: 'savings_rate', unit: 'percentage', original_currency: '' })], cut);
    expect(find(out.issues, 'METRIC_NOT_MAPPED')).toBeUndefined();
  });
});

describe('NC-V2: fallback when the mapping is not installed (migration 0277 not applied yet)', () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.benchmark_dataset_metrics' in the schema cache" };
  function clientWithoutMappingTable() {
    const db = createInMemoryDb();
    db.reset(pbReferenceTables() as Record<string, never[]>);
    return {
      from: (t: string) => (t === 'benchmark_dataset_metrics' ? { select: () => ({ limit: async () => ({ data: null, error: missing }) }) } : (db.client.from(t) as never)),
    };
  }

  it('NEW: the lists load, say the mapping is not installed, and no dataset is blocked for lack of a mapping', async () => {
    const av = await loadAllowedValues(clientWithoutMappingTable() as never, FIXTURE_TODAY);
    if (av.state !== 'ok') throw new Error('expected ok');
    expect(av.mapping).toEqual({ installed: false, pairs: 0 });
    for (const d of av.datasets.filter((x) => x.open)) expect(d.accepts.values.accepted && d.accepts.target_ranges.accepted, d.name).toBe(true);
    expect(av.datasets.find((d) => d.name.startsWith('India'))!.accepts.values.note).toMatch(/mapping is not installed yet/);
  });

  it('NEW: the same wrong-dataset row is NOT refused, and ONE visible warning (not an error) says the check could not run', async () => {
    const av = await loadAllowedValues(clientWithoutMappingTable() as never, FIXTURE_TODAY);
    if (av.state !== 'ok') throw new Error('expected ok');
    const out = await check('values', [values({ metric_code: 'savings_rate', unit: 'percentage', original_currency: '' }), values({ metric_code: 'savings_rate', unit: 'percentage', original_currency: '', statistic_type: 'mean' })], av);
    expect(find(out.issues, 'METRIC_NOT_MAPPED')).toBeUndefined();
    const w = out.issues.filter((i) => i.code === 'MAPPING_NOT_INSTALLED');
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('warning');
    expect(w[0].message).toContain('not installed on this database yet (migration 0277)');
    expect(out.errorCount).toBe(0);
    expect(out.rows).toHaveLength(2);
    expect(out.warningCount).toBeGreaterThan(0);
  });

  it('NEW: the Read me sheet, the companion CSV and the screen section all say it plainly', async () => {
    const av = await loadAllowedValues(clientWithoutMappingTable() as never, FIXTURE_TODAY);
    if (av.state !== 'ok') throw new Error('expected ok');
    const sec = datasetMetricsSection(av, 'all');
    expect(sec.heading).toBe('Allowed metrics per dataset: not installed yet');
    expect(sec.intro).toBe(MAPPING_NOT_INSTALLED_LINE);
    expect(sec.rows).toEqual([]);
    expect(buildAllowedValuesCsv(av)).toContain('not installed on this database yet (migration 0277)');
    const wb = XLSX.read(buildTemplateXlsx('values', av), { type: 'array' });
    const cells = (XLSX.utils.sheet_to_json(wb.Sheets[XLSX_README_SHEET], { header: 1, defval: '' }) as unknown[][]).flat().map(String);
    expect(cells.some((c) => c.includes('not installed on this database yet (migration 0277)'))).toBe(true);
  });

  it('a different read failure of the mapping table is NOT the same as "not installed": the lists are unavailable', async () => {
    const db = createInMemoryDb();
    db.reset(pbReferenceTables() as Record<string, never[]>);
    const client = { from: (t: string) => (t === 'benchmark_dataset_metrics' ? { select: () => ({ limit: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }) } : (db.client.from(t) as never)) };
    expect((await loadAllowedValues(client as never, FIXTURE_TODAY)).state).toBe('unavailable');
  });

  it('isMissingRelation recognises the real missing-table errors and nothing else; loadMappingStatus reports installed, not installed and unavailable apart', async () => {
    expect(isMissingRelation({ code: 'PGRST205' })).toBe(true);
    expect(isMissingRelation({ code: '42P01', message: 'relation does not exist' })).toBe(true);
    expect(isMissingRelation({ code: '57014', message: 'canceling statement' })).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
    const mk = (r: { data: unknown; error: unknown }) => ({ from: () => ({ select: () => ({ limit: async () => r }) }) }) as never;
    expect(await loadMappingStatus(mk({ data: [], error: null }))).toBe('installed');
    expect(await loadMappingStatus(mk({ data: null, error: missing }))).toBe('not_installed');
    expect(await loadMappingStatus(mk({ data: null, error: { code: '57014', message: 'x' } }))).toBe('unavailable');
    expect(await loadMappingStatus({ from: () => { throw new Error('down'); } } as never)).toBe('unavailable');
  });

  it('an installed but EMPTY mapping table fails closed (nothing is mapped, so nothing may be uploaded), which is not the fallback', async () => {
    const av = await listsWith({ benchmark_dataset_metrics: [] });
    expect(av.mapping).toEqual({ installed: true, pairs: 0 });
    const out = await check('values', [values()], av);
    expect(find(out.issues, 'METRIC_NOT_MAPPED')).toBeTruthy();
  });
});

describe('NC-V3: the lists and the validator are one source (they cannot drift)', () => {
  it('NEW: the Read me, the CSV and the screen section print exactly the mapped pairs, with unit and kind, per dataset', async () => {
    const av = await listsWith();
    const sec = datasetMetricsSection(av, 'all');
    expect(sec.heading).toBe(`${av.mapping.pairs} dataset and metric pairs are mapped (which metrics each dataset may receive)`);
    expect(sec.rows).toHaveLength(av.mapping.pairs);
    expect(sec.intro).not.toMatch(/Open datasets with no metric mapped yet/);
    const none = datasetMetricsSection(await listsWith({ benchmark_dataset_metrics: [] }), 'all');
    expect(none.intro).toMatch(/Open datasets with no metric mapped yet.*India household consumption expenditure \(rural\/urban\) \(version 1\.0\)/);
    const listed = new Set(sec.rows.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[5]}|${r[6]}`));
    for (const d of av.datasets) for (const m of d.mappedMetrics) expect(listed.has(`${d.name}|${d.version}|${m.code}|${m.values ? 'yes' : 'no'}|${m.targetRanges ? 'yes' : 'no'}`), `${d.name} ${m.code}`).toBe(true);
    // the allowed-values sections (Read me and CSV) include the same rows
    const fromSections = allowedValuesSections(av, 'all').find((s) => s.id === 'dataset_metrics')!;
    expect(fromSections.rows).toEqual(sec.rows);
    const csv = buildAllowedValuesCsv(av);
    for (const r of sec.rows) expect(csv).toContain(r[2]);
    // a values Read me lists only the values pairs, a target ranges Read me only the bands pairs, a cohorts Read me none
    expect(allowedValuesSections(av, 'values').find((s) => s.id === 'dataset_metrics')!.rows.every((r) => r[5] === 'yes')).toBe(true);
    expect(allowedValuesSections(av, 'target_ranges').find((s) => s.id === 'dataset_metrics')!.rows.every((r) => r[6] === 'yes')).toBe(true);
    expect(allowedValuesSections(av, 'cohorts').some((s) => s.id === 'dataset_metrics')).toBe(false);
  });

  it('NEW: every listed (dataset, metric, kind) is accepted by the validator and every registered metric NOT listed for that dataset and kind is refused', async () => {
    const av = await listsWith();
    for (const d of av.datasets.filter((x) => x.open)) {
      for (const kind of ['values', 'target_ranges'] as const) {
        const allowed = new Set(mappedFor(d, kind).map((m) => m.code));
        for (const m of av.metrics) {
          const row =
            kind === 'values'
              ? values({ dataset_name: d.name, dataset_version: d.version, metric_code: m.code, unit: m.unit, original_currency: m.unit === 'currency' ? 'AUD' : '' })
              : ranges({ dataset_name: d.name, dataset_version: d.version, metric_code: m.code, source_name: d.sourceName ?? '' });
          const out = await check(kind, [row], av);
          const refused = out.issues.some((i) => i.code === 'METRIC_NOT_MAPPED');
          expect(refused, `${d.name} / ${m.code} / ${kind}`).toBe(!allowed.has(m.code));
        }
      }
    }
  });

  it('statically: the validator and the lists read the mapping from allowedValues.ts only; the service never reads the mapping table itself', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', p), 'utf8');
    expect(read('lib/planning-benchmarks/uploadValidate.ts')).toMatch(/mappedFor/);
    expect(read('lib/planning-benchmarks/uploadValidate.ts')).not.toMatch(/benchmark_dataset_metrics/);
    expect(read('lib/planning-benchmarks/uploadService.ts')).not.toMatch(/benchmark_dataset_metrics/);
    expect(read('lib/planning-benchmarks/uploadTemplates.ts')).not.toMatch(/benchmark_dataset_metrics/);
    expect(read('components/admin/PlanningBenchmarkAllowedValues.tsx')).toMatch(/datasetMetricsSection/);
  });
});
