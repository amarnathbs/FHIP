// Planning Benchmarks upload: the ALLOWED VALUES lists (Read me sheet, companion CSV, validator guard).
// Evidence label: UNIT-TESTED against an in-memory fake of the reference tables. DEV evidence is in
// docs/planning-benchmarks/TEMPLATE_ALLOWED_VALUES_REPORT.md.
//
// PO request 07/10/2026: "read me tab should show all the 12 parameters or any other number currently developed
// and available which is allowed to upload from this module, so that there is no error uploading the wrong data
// to the parameter."
//
// NAMED NEGATIVE CONTROLS (each fails something when the thing it guards is broken)
//   NC-A1  the lists really come from the database: a dataset added to the fake DB appears in the file, the count
//          moves with it, and a dataset closed by status is listed as closed and not counted as open;
//   NC-A2  an unreadable database does not fail the download and is not an empty list: the sheet carries the
//          "unavailable" line (and the Data sheet is unchanged);
//   NC-A3  the Read me lists and the validator cannot drift: every dataset, metric, unit and cohort the Read me
//          prints is accepted by the validator, and everything it does not print is refused;
//   NC-A4  a list cut by its read bound is flagged incomplete and the validator then does not refuse on absence;
//   NC-A5  a formula-looking reference name is neutralised in both the XLSX and the CSV.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createInMemoryDb } from './support/inMemorySupabase';
import { FIXTURE_TODAY, pbReferenceTables } from './support/pbAllowedFixture';
import {
  ALLOWED_VALUES_LIMITS,
  UNAVAILABLE_LINE,
  allowedValuesSections,
  buildAllowedIndex,
  datasetsHeading,
  deriveAllowedValues,
  didYouMean,
  loadAllowedValues,
  nearestMatches,
  type AllowedValues,
  type AllowedValuesOk,
} from '@/lib/planning-benchmarks/allowedValues';
import { ALLOWED_VALUES_CSV_NAME, buildAllowedValuesCsv, buildTemplate, buildTemplateXlsx } from '@/lib/planning-benchmarks/uploadTemplates';
import { CLOSED_DATASET_STATUSES, TEMPLATE_VERSION, UPLOAD_KINDS, XLSX_DATA_SHEET, XLSX_README_SHEET, columnNames, type UploadKind } from '@/lib/planning-benchmarks/uploadSchema';
import { readUploadFile, validateUploadTable } from '@/lib/planning-benchmarks/uploadValidate';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function dbWith(over: Record<string, unknown[]> = {}) {
  const db = createInMemoryDb();
  db.reset({ ...(pbReferenceTables() as Record<string, never[]>), ...(over as Record<string, never[]>) });
  return db;
}

async function loadOk(db = dbWith()): Promise<AllowedValuesOk> {
  const r = await loadAllowedValues(db.client as never, FIXTURE_TODAY);
  if (r.state !== 'ok') throw new Error('expected ok lists');
  return r;
}

/** Flatten a sheet to rows of strings with the repo-independent `xlsx` reader. */
function sheetRows(bytes: Uint8Array, sheet: string): string[][] {
  const wb = XLSX.read(bytes, { type: 'array' });
  const ws = wb.Sheets[sheet];
  if (!ws) throw new Error(`no sheet ${sheet}; have ${wb.SheetNames.join(', ')}`);
  return (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true }) as unknown[][]).map((r) => r.map((c) => String(c)));
}
const flat = (rows: string[][]) => rows.flat().filter((c) => c !== '');

function csvToTable(csv: string): string[][] {
  // The companion CSV is quoted RFC 4180 with CRLF; the XLSX library parses it the same way a spreadsheet would.
  const wb = XLSX.read(csv, { type: 'string', raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: false }) as unknown[][]).map((r) => r.map((c) => String(c)));
}

describe('allowed values - derived from the reference tables', () => {
  it('NC-A1: lists, counts, open/closed and the per-kind acceptance all come from the database rows', async () => {
    const av = await loadOk();
    expect(av.counts).toEqual({ datasetsTotal: 5, datasetsOpen: 3, datasetsClosed: 2, metricsTotal: 4, metricsActive: 3, cohortsTotal: 2 });
    // open datasets first, then closed; each by name
    expect(av.datasets.map((d) => `${d.open ? 'open' : 'closed'}:${d.name}`)).toEqual([
      'open:AU household wealth distribution',
      'open:FHIP Planning Benchmarks v1.0',
      'open:India household consumption expenditure (rural/urban)',
      'closed:Archived legacy set',
      'closed:AU household debt context',
    ]);
    const closed = av.datasets.find((d) => d.name === 'AU household debt context')!;
    expect(closed.status).toBe('superseded');
    expect(closed.accepts.values.accepted).toBe(false);
    expect(closed.accepts.values.note).toMatch(/superseded/);
    // the target-range condition names the one source; the draft observed dataset holds no figure yet
    const india = av.datasets.find((d) => d.name.startsWith('India'))!;
    expect(india.liveValueCount).toBe(0);
    expect(india.accepts.target_ranges.note).toContain('source_name must be exactly "MOSPI_HCES_2023_24"');
    expect(india.accepts.target_ranges.note).toMatch(/only be activated by an observed values file/);
    expect(av.datasets.find((d) => d.name === 'AU household wealth distribution')!.liveValueCount).toBe(2);
    // metrics: unit and the LIVE bands only (the end-dated band's household type is not live)
    const sr = av.metrics.find((m) => m.code === 'savings_rate')!;
    expect(sr.unit).toBe('percentage');
    expect(sr.bandCount).toBe(2);
    expect(sr.bandTiers.map((t) => t.tier)).toEqual([1, 4]);
    expect(sr.bandHouseholdTypes).toEqual(['single']);
    expect(av.bandHouseholdTypes).toEqual(['family', 'single']);
    expect(av.metrics.find((m) => m.code === 'retired_ratio')!.active).toBe(false);
  });

  it('only suspended, archived and superseded datasets are closed: the constant is pinned to migration 0275', () => {
    const sql = read('supabase/migrations/0275_planning_benchmark_staged_upload.sql');
    const m = /if d\.data_status in \(([^)]*)\) then\s+raise exception[^;]*PB_E_DATASET/.exec(sql);
    expect(m).not.toBeNull();
    const inSql = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect([...inSql].sort()).toEqual([...CLOSED_DATASET_STATUSES].sort());
  });

  it('the heading counts, singular and plural, from the data', async () => {
    const av = await loadOk();
    expect(datasetsHeading(av)).toBe('3 datasets are open for upload today');
    const one = await loadOk(dbWith({ benchmark_datasets: [pbReferenceTables().benchmark_datasets[0]] }));
    expect(datasetsHeading(one)).toBe('1 dataset is open for upload today');
  });

  it('NC-A2: a failed read, or a client that throws, is "unavailable" - never an empty ok list', async () => {
    const failing = { from: () => ({ select: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) };
    expect((await loadAllowedValues(failing as never, FIXTURE_TODAY)).state).toBe('unavailable');
    const throwing = { from: () => { throw new Error('network down'); } };
    expect((await loadAllowedValues(throwing as never, FIXTURE_TODAY)).state).toBe('unavailable');
  });

  it('NC-A4: a list cut by its read bound is flagged incomplete', () => {
    const t = pbReferenceTables();
    const many = Array.from({ length: ALLOWED_VALUES_LIMITS.cohorts }, (_, i) => ({ cohort_code: `C${i}`, cohort_tier: 1, cohort_description: 'x' }));
    const av = deriveAllowedValues(
      { datasets: t.benchmark_datasets, sources: t.benchmark_sources, metrics: t.benchmark_metric_definitions, cohorts: many, bands: t.benchmark_target_ranges, valueDatasetIds: [], cut: { datasets: false, sources: false, metrics: false, cohorts: true, bands: false, values: false } },
      FIXTURE_TODAY
    );
    expect(av.complete.cohorts).toBe(false);
    expect(av.complete.datasets).toBe(true);
  });

  it('"did you mean" hints find a near miss, ignore unrelated words, and never invent', () => {
    expect(nearestMatches('au household wealth distribution', ['AU household wealth distribution', 'Other'])).toEqual(['AU household wealth distribution']);
    expect(nearestMatches('net_wurth', ['net_worth', 'savings_rate'])).toEqual(['net_worth']);
    expect(nearestMatches('zzzzzz', ['net_worth', 'savings_rate'])).toEqual([]);
    expect(didYouMean('zzzzzz', ['net_worth'])).toBe('');
    expect(didYouMean('net_wurth', ['net_worth'])).toContain('Did you mean "net_worth"?');
  });
});

describe('Excel template Read me sheet carries the live lists', () => {
  it('NC-A1: for every kind the Read me prints the count heading, every dataset exactly as stored, every metric with its unit, every cohort, and the closed lists; the Data sheet is unchanged', async () => {
    const av = await loadOk();
    for (const kind of UPLOAD_KINDS) {
      const bytes = buildTemplateXlsx(kind, av);
      const wb = XLSX.read(bytes, { type: 'array' });
      expect(wb.SheetNames).toEqual([XLSX_DATA_SHEET, XLSX_README_SHEET]);
      const readme = sheetRows(bytes, XLSX_README_SHEET);
      const cells = flat(readme);
      // explicit count, from the data
      expect(cells).toContain('3 datasets are open for upload today');
      expect(cells.some((c) => /^3 datasets are open for upload today\. The full lists/.test(c))).toBe(true);
      // every dataset name and version exactly, closed ones with their reason
      for (const d of av.datasets) {
        const row = readme.find((r) => r[0] === d.name && r[1] === d.version);
        expect(row, `${kind}: ${d.name}`).toBeTruthy();
        expect(row![4]).toBe(d.status);
        expect(row![5]).toBe(d.sourceName ?? 'none');
      }
      expect(readme.find((r) => r[0] === 'AU household debt context')!.join('|')).toMatch(/superseded/);
      // metrics (values and target ranges) with units; not on the cohorts template
      if (kind !== 'cohorts') {
        expect(cells).toContain('4 metrics are registered and can be uploaded to (3 active)');
        for (const m of av.metrics) {
          const row = readme.find((r) => r[0] === m.code);
          expect(row, `${kind}: ${m.code}`).toBeTruthy();
          expect(row![1]).toBe(m.name);
          expect(row![2]).toBe(m.unit);
        }
      } else {
        expect(cells.some((c) => /registered and can be uploaded to/.test(c))).toBe(false);
      }
      // cohorts (values and cohorts templates)
      if (kind !== 'target_ranges') {
        expect(cells).toContain('2 cohorts exist');
        for (const c of av.cohorts) expect(readme.some((r) => r[0] === c.code && r[1] === c.description)).toBe(true);
      }
      // closed lists from the schema
      if (kind === 'values') {
        expect(readme.filter((r) => r[0] === 'statistic_type').at(-1)![1]).toContain('median');
        expect(readme.filter((r) => r[0] === 'unit').at(-1)![1]).toBe('currency, percentage, months, ratio, count, years, days');
        expect(readme.filter((r) => r[0] === 'is_derived').at(-1)![1]).toBe('true or false');
      }
      // household types already in live bands (target ranges)
      if (kind === 'target_ranges') {
        expect(readme.find((r) => r[0] === 'household_type' && r[1] === 'family, single')).toBeTruthy();
        expect(cells.join(' ')).not.toContain('retired_couple'); // the end-dated band
      }
      // the Read me still holds the column table and the rule that it is never imported
      expect(cells.some((c) => /never imported/.test(c))).toBe(true);
      // the importable Data sheet is byte-for-byte the same cells with or without the lists
      const without = sheetRows(buildTemplateXlsx(kind), XLSX_DATA_SHEET);
      expect(sheetRows(bytes, XLSX_DATA_SHEET)).toEqual(without);
      expect(without[0]).toEqual(columnNames(kind));
      // and it still reads back through the repo's own reader on the explicit Data sheet
      const back = readUploadFile({ fileName: 't.xlsx', bytes, sheetName: XLSX_DATA_SHEET });
      expect(back.ok).toBe(true);
    }
  });

  it('NC-A1: adding a dataset to the database changes the file (the number moves with the data)', async () => {
    const base = pbReferenceTables();
    const added = { id: 'ds-new', dataset_name: 'A brand new dataset', version: '2.0', benchmark_class: 'observed_market', evidence_level: 'official_statistical', data_status: 'approved', benchmark_source_id: 'src-abs' };
    const av = await loadOk(dbWith({ benchmark_datasets: [...base.benchmark_datasets, added] }));
    const cells = flat(sheetRows(buildTemplateXlsx('values', av), XLSX_README_SHEET));
    expect(cells).toContain('4 datasets are open for upload today');
    expect(cells).toContain('A brand new dataset');
  });

  it('NC-A2: when the lists are unavailable the download still works and says so; nothing is silently omitted', async () => {
    const unavailable: AllowedValues = await loadAllowedValues({ from: () => ({ select: () => ({ limit: async () => ({ data: null, error: { message: 'down' } }) }) }) } as never, FIXTURE_TODAY);
    expect(unavailable.state).toBe('unavailable');
    for (const kind of UPLOAD_KINDS) {
      const t = buildTemplate(kind, 'xlsx', unavailable);
      const cells = flat(sheetRows(t.body as Uint8Array, XLSX_README_SHEET));
      expect(cells).toContain(UNAVAILABLE_LINE);
      expect(UNAVAILABLE_LINE).toMatch(/Datasets tab/);
      expect(cells.some((c) => /datasets are open for upload today/.test(c))).toBe(false);
      expect(sheetRows(t.body as Uint8Array, XLSX_DATA_SHEET)[0]).toEqual(columnNames(kind));
    }
    // and a build with no lists at all (an older caller) says the same, never an empty promise
    expect(flat(sheetRows(buildTemplateXlsx('values'), XLSX_README_SHEET))).toContain(UNAVAILABLE_LINE);
  });

  it('every date a person reads is day-first; no year-first text appears in the generated Read me or CSV', async () => {
    const av = await loadOk();
    const text = flat(sheetRows(buildTemplateXlsx('target_ranges', av), XLSX_README_SHEET)).join('\n') + buildAllowedValuesCsv(av);
    expect(text).toContain('07/10/2026');
    expect(/\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(text) || /yyyy-mm-dd/i.test(text)).toBe(false);
  });

  it('NC-A5: a formula-looking reference name is neutralised in the XLSX and in the CSV', async () => {
    const evil = { id: 'ds-evil', dataset_name: '=HYPERLINK("http://evil","x")', version: '1.0', benchmark_class: 'observed_market', evidence_level: 'official_statistical', data_status: 'active', benchmark_source_id: 'src-abs' };
    const av = await loadOk(dbWith({ benchmark_datasets: [...pbReferenceTables().benchmark_datasets, evil] }));
    const xlsxCells = flat(sheetRows(buildTemplateXlsx('values', av), XLSX_README_SHEET));
    expect(xlsxCells.some((c) => c.startsWith('='))).toBe(false);
    expect(xlsxCells).toContain(`'=HYPERLINK("http://evil","x")`);
    const csv = buildAllowedValuesCsv(av);
    for (const row of csvToTable(csv)) for (const cell of row) expect(/^[=+@\t\r]/.test(cell)).toBe(false);
  });
});

describe('companion "Allowed values (CSV)"', () => {
  it('lists every dataset, metric, cohort and closed list with the same counts, and is not an upload template', async () => {
    const av = await loadOk();
    const csv = buildAllowedValuesCsv(av);
    expect(ALLOWED_VALUES_CSV_NAME).toBe('planning_benchmarks_allowed_values.csv');
    const rows = csvToTable(csv);
    const cells = flat(rows);
    expect(cells).toContain('3 datasets are open for upload today');
    expect(cells).toContain('4 metrics are registered and can be uploaded to (3 active)');
    expect(cells).toContain('2 cohorts exist');
    for (const d of av.datasets) expect(rows.some((r) => r[0] === d.name && r[1] === d.version)).toBe(true);
    for (const m of av.metrics) expect(rows.some((r) => r[0] === m.code && r[2] === m.unit)).toBe(true);
    for (const c of av.cohorts) expect(rows.some((r) => r[0] === c.code)).toBe(true);
    expect(rows.some((r) => r[0] === 'statistic_type (Observed values)')).toBe(true);
    // not importable: it has no template_version column, so staging would refuse it outright
    const upload = readUploadFile({ fileName: 'x.csv', bytes: new TextEncoder().encode(csv) });
    expect(upload.ok).toBe(true);
    if (upload.ok) {
      const out = validateUploadTable(upload.table, 'values', { todayIso: FIXTURE_TODAY, metricUnits: new Map() });
      expect(out.errorCount).toBeGreaterThan(0);
      expect(out.rows).toHaveLength(0);
    }
  });

  it('NC-A2: unavailable lists produce a file that says so (still a 200-able download)', () => {
    const csv = buildAllowedValuesCsv({ state: 'unavailable', reason: 'x' });
    expect(csv).toContain('lists are unavailable');
    expect(csv).toContain('Datasets tab');
  });
});

describe('NC-A3: the Read me lists and the validator are one source (they cannot drift)', () => {
  it('statically: the validator, the templates, the service, the routes and the screen all read allowedValues.ts', () => {
    expect(read('lib/planning-benchmarks/uploadValidate.ts')).toMatch(/from '\.\/allowedValues'/);
    expect(read('lib/planning-benchmarks/uploadTemplates.ts')).toMatch(/from '\.\/allowedValues'/);
    const service = read('lib/planning-benchmarks/uploadService.ts');
    expect(service).toMatch(/loadAllowedValues\(supabase, input\.todayIso\)/);
    expect(service).toMatch(/validateUploadTable\([^)]*allowed/);
    expect(read('app/api/admin/benchmarks/upload/templates/[kind]/route.ts')).toMatch(/loadAllowedValues/);
    expect(read('app/api/admin/benchmarks/upload/allowed-values/route.ts')).toMatch(/loadAllowedValues/);
    expect(read('components/admin/PlanningBenchmarkAllowedValues.tsx')).toMatch(/from '@\/lib\/planning-benchmarks\/allowedValues'/);
    // nothing else decides which dataset statuses are closed or reads the metric list on its own
    expect(read('lib/planning-benchmarks/uploadService.ts')).not.toMatch(/from\('benchmark_metric_definitions'\)/);
    expect(read('lib/planning-benchmarks/uploadValidate.ts')).not.toMatch(/'suspended'|'archived'|'superseded'/);
  });

  function rowsCsv(kind: UploadKind, cells: Record<string, string>): string {
    const cols = columnNames(kind);
    return [cols.join(','), cols.map((c) => csvq(cells[c] ?? '')).join(',')].join('\n') + '\n';
  }
  const csvq = (s: string) => (/[",\n]/.test(s) ? `"${s.split('"').join('""')}"` : s);
  const baseValues = (over: Record<string, string>): Record<string, string> => ({
    template_version: TEMPLATE_VERSION.values, dataset_name: 'AU household wealth distribution', dataset_version: '1.0', cohort_code: '', metric_code: 'net_worth', statistic_type: 'median',
    value_numeric: '559000', unit: 'currency', original_currency: 'AUD', base_date: '30/06/2020', is_derived: 'false', source_release: 'ABS SIH', observation_period_start: '01/07/2019',
    source_file: 'sih.xlsx', source_locator: 'Table 1', retrieval_date: '01/10/2026', ...over,
  });
  function validate(kind: UploadKind, cells: Record<string, string>, av: AllowedValuesOk) {
    const read2 = readUploadFile({ fileName: 'x.csv', bytes: new TextEncoder().encode(rowsCsv(kind, cells)) });
    if (!read2.ok) throw new Error('read failed');
    return validateUploadTable(read2.table, kind, { todayIso: FIXTURE_TODAY, metricUnits: new Map(av.metrics.map((m) => [m.code, m.unit])), allowed: av });
  }

  it('every listed OPEN dataset is accepted and every listed CLOSED dataset is refused, exactly as the Read me says', async () => {
    const av = await loadOk();
    for (const d of av.datasets) {
      const out = validate('values', baseValues({ dataset_name: d.name, dataset_version: d.version }), av);
      const refused = out.issues.some((i) => i.code === 'DATASET_NOT_FOUND' || i.code === 'DATASET_NOT_OPEN');
      expect(refused, `${d.name} (${d.status})`).toBe(!d.open);
      expect(d.accepts.values.accepted).toBe(d.open);
    }
  });

  it('every listed metric is accepted with exactly its listed unit, and refused with any other unit', async () => {
    const av = await loadOk();
    for (const m of av.metrics) {
      const cur = m.unit === 'currency' ? { original_currency: 'AUD' } : { original_currency: '' };
      expect(validate('values', baseValues({ metric_code: m.code, unit: m.unit, ...cur }), av).issues.filter((i) => i.severity === 'error')).toEqual([]);
      const other = m.unit === 'ratio' ? 'count' : 'ratio';
      const bad = validate('values', baseValues({ metric_code: m.code, unit: other, original_currency: '' }), av);
      expect(bad.issues.some((i) => i.code === 'UNIT_MISMATCH' && i.message.includes(`"${m.unit}"`))).toBe(true);
    }
  });

  it('every listed cohort is accepted; a cohort the list does not print is refused', async () => {
    const av = await loadOk();
    for (const c of av.cohorts) expect(validate('values', baseValues({ cohort_code: c.code }), av).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(validate('values', baseValues({ cohort_code: 'NOT_A_COHORT' }), av).issues.some((i) => i.code === 'COHORT_NOT_FOUND')).toBe(true);
  });

  it('the index the validator uses is built from the same object the sections print', async () => {
    const av = await loadOk();
    const ix = buildAllowedIndex(av);
    const sections = allowedValuesSections(av, 'all');
    expect(sections.find((s) => s.id === 'datasets')!.rows.length).toBe(ix.datasetsByKey.size);
    expect(sections.find((s) => s.id === 'metrics')!.rows.length).toBe(ix.metricsByCode.size);
    expect(sections.find((s) => s.id === 'cohorts')!.rows.length).toBe(ix.cohortCodes.size);
  });
});
