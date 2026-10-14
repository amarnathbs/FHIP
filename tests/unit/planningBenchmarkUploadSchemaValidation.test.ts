// Planning Benchmarks staged upload (F5): the template and validation layers. Pure, no database.
// Evidence label: UNIT-TESTED.
//
// NAMED NEGATIVE CONTROLS
//   NC-U1  an UNEDITED template can never stage (its example rows name a dataset and metric that do not exist);
//   NC-U2  a unit that differs from the metric's unit is refused (the unit rule is what stops a wrong-unit figure);
//   NC-U3  a cell that starts with a formula character is neutralised in a generated template, and the neutraliser really bites;
//   NC-U4  a template from a different generation (wrong version marker) is refused.
import { describe, expect, it } from 'vitest';
import { UPLOAD_KINDS, UPLOAD_SCHEMA, columnNames, TEMPLATE_VERSION, UPLOAD_RULES, UPLOAD_LIMITS, XLSX_DATA_SHEET } from '@/lib/planning-benchmarks/uploadSchema';
import { buildTemplateCsv, buildTemplateXlsx, buildTemplate, templateFileName } from '@/lib/planning-benchmarks/uploadTemplates';
import { readUploadFile, validateUploadTable, safeCell } from '@/lib/planning-benchmarks/uploadValidate';
import { parseFileDateText } from '@/lib/planning-benchmarks/dates';
import { formatDayFirst, formatDayFirstDateTime } from '@/lib/planning-benchmarks/dayFirst';

const enc = new TextEncoder();
const CTX = { todayIso: '2026-10-06', metricUnits: new Map([['net_worth', 'currency'], ['savings_rate', 'percentage']]) };

function validateCsv(csv: string, kind: (typeof UPLOAD_KINDS)[number]) {
  const read = readUploadFile({ fileName: 'x.csv', bytes: enc.encode(csv) });
  if (!read.ok) throw new Error('read failed: ' + JSON.stringify(read.problems));
  return validateUploadTable(read.table, kind, CTX);
}

function valuesCsv(over: Record<string, string> = {}) {
  const cols = columnNames('values');
  const row: Record<string, string> = {
    template_version: TEMPLATE_VERSION.values, dataset_name: 'AU household wealth distribution', dataset_version: '1.0', cohort_code: '', metric_code: 'net_worth',
    statistic_type: 'median', value_numeric: '559000', unit: 'currency', original_currency: 'AUD', base_date: '30/06/2020', effective_from: '', is_derived: 'false', derivation_method: '',
    confidence_score: '', source_release: 'ABS SIH 2019-20', observation_period_start: '01/07/2019', observation_period_end: '30/06/2020', source_file: 'sih.xlsx', source_locator: 'Table 1.1 cell B7', retrieval_date: '01/10/2026', ...over,
  };
  return [cols.join(','), cols.map((c) => row[c] ?? '').join(',')].join('\n') + '\n';
}

describe('F5 templates come from ONE schema', () => {
  it('every kind has a CSV with the header on row 1, the version marker first, and the same columns the schema declares', () => {
    for (const kind of UPLOAD_KINDS) {
      const csv = buildTemplateCsv(kind);
      const lines = csv.split(/\r?\n/).filter(Boolean);
      expect(lines[0].split(',')).toEqual(columnNames(kind));
      expect(columnNames(kind)[0]).toBe('template_version');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[1].startsWith(TEMPLATE_VERSION[kind])).toBe(true);
      expect(csv.startsWith('#')).toBe(false); // no comment lines before the header
      expect(templateFileName(kind, 'csv')).toMatch(/\.csv$/);
    }
  });

  it('the XLSX template reads back through the repo reader with the same header, on the Data sheet', () => {
    for (const kind of UPLOAD_KINDS) {
      const bytes = buildTemplateXlsx(kind);
      const read = readUploadFile({ fileName: 'tpl.xlsx', bytes, sheetName: XLSX_DATA_SHEET });
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.table.header).toEqual(columnNames(kind));
    }
  });

  it('an XLSX upload without an explicit sheet choice is refused with the sheet list (the sheet is never chosen for the operator)', () => {
    const read = readUploadFile({ fileName: 'tpl.xlsx', bytes: buildTemplateXlsx('values') });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.stage).toBe('sheet');
      expect((read.sheets ?? []).map((s) => s.name)).toContain(XLSX_DATA_SHEET);
    }
  });

  it('NC-U1: an unedited values or target-range template can never stage (rejected with errors); the cohort template names a dataset that does not exist, which the database refuses (PGlite: PB_E_DATASET)', () => {
    for (const kind of ['values', 'target_ranges'] as const) {
      const out = validateCsv(buildTemplateCsv(kind), kind);
      expect(out.errorCount, `unedited ${kind} template must have errors`).toBeGreaterThan(0);
    }
    const cohorts = validateCsv(buildTemplateCsv('cohorts'), 'cohorts');
    expect(cohorts.datasetName).toMatch(/REPLACE ME/);
  });

  it('NC-U3: no generated cell can start a formula, and safeCell really neutralises one', () => {
    for (const kind of UPLOAD_KINDS) {
      for (const format of ['csv'] as const) {
        const t = buildTemplate(kind, format);
        const text = String(t.body);
        for (const line of text.split(/\r?\n/)) for (const cell of line.split(',')) expect(/^[=+\-@\t\r]/.test(cell.replace(/^"/, ''))).toBe(false);
      }
    }
    for (const bad of ['=SUM(A1)', '+1', '@cmd', '-2+3']) expect(safeCell(bad).startsWith("'") || !/^[=+\-@]/.test(safeCell(bad))).toBe(true);
    expect(safeCell('plain text')).toBe('plain text');
  });

  it('the schema text a person reads never contains a year-first date example or a month-first date', () => {
    const prose = [...UPLOAD_RULES, ...UPLOAD_KINDS.flatMap((k) => UPLOAD_SCHEMA[k].columns.map((c) => c.description))].join('\n');
    expect(prose).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(prose).not.toMatch(/yyyy-mm-dd/i);
    // the template example rows (file content) are day-first too
    for (const k of UPLOAD_KINDS) expect(buildTemplateCsv(k)).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });
});

describe('F5 validation', () => {
  it('accepts a correct values row (day-first dates) and normalises dates to the database form', () => {
    const out = validateCsv(valuesCsv(), 'values');
    expect(out.errorCount).toBe(0);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ metric_code: 'net_worth', unit: 'currency', base_date: '2020-06-30' });
    expect(out.datasetName).toBe('AU household wealth distribution');
  });

  it('NC-U2: a unit that is not the metric unit is refused with the row number, and a matching unit passes', () => {
    const wrong = validateCsv(valuesCsv({ unit: 'percentage', original_currency: '' }), 'values');
    expect(wrong.errorCount).toBeGreaterThan(0);
    expect(wrong.issues.some((i) => i.rowNumber === 2 && /unit/i.test(i.message + (i.column ?? '')))).toBe(true);
    expect(validateCsv(valuesCsv(), 'values').errorCount).toBe(0);
  });

  it('NC-U4: a wrong template version marker is refused', () => {
    const out = validateCsv(valuesCsv({ template_version: 'FHIP-PB-VALUES-0' }), 'values');
    expect(out.errorCount).toBeGreaterThan(0);
  });

  it('refuses unknown metrics, bad enums, future dates, thousands separators, percent signs and month-first dates', () => {
    expect(validateCsv(valuesCsv({ metric_code: 'nope' }), 'values').errorCount).toBeGreaterThan(0);
    expect(validateCsv(valuesCsv({ statistic_type: 'average' }), 'values').errorCount).toBeGreaterThan(0);
    expect(validateCsv(valuesCsv({ base_date: '30/06/2031' }), 'values').errorCount).toBeGreaterThan(0);
    expect(validateCsv(valuesCsv({ value_numeric: '"559,000"' }), 'values').errorCount).toBeGreaterThan(0);
    expect(validateCsv(valuesCsv({ value_numeric: '56.2%', unit: 'currency' }), 'values').errorCount).toBeGreaterThan(0);
    expect(validateCsv(valuesCsv({ base_date: '06/30/2020' }), 'values').errorCount).toBeGreaterThan(0);
  });

  it('refuses a duplicate key inside one file', () => {
    const one = valuesCsv();
    const lines = one.trim().split('\n');
    const out = validateCsv([lines[0], lines[1], lines[1]].join('\n') + '\n', 'values');
    expect(out.errorCount).toBeGreaterThan(0);
  });

  it('refuses a file that targets two datasets', () => {
    const a = valuesCsv().trim().split('\n');
    const b = valuesCsv({ dataset_name: 'Another dataset', statistic_type: 'mean' }).trim().split('\n');
    expect(validateCsv([a[0], a[1], b[1]].join('\n') + '\n', 'values').errorCount).toBeGreaterThan(0);
  });

  it('file size and row limits are the documented ones (5 MB, 5,000 rows)', () => {
    expect(UPLOAD_LIMITS.maxBytes).toBe(5 * 1024 * 1024);
    expect(UPLOAD_LIMITS.maxRows).toBe(5000);
  });
});

describe('F5 dates', () => {
  it('parses day-first and database-order text, refuses month-first and two-digit years, and formats day-first for people', () => {
    expect(parseFileDateText('30/06/2020')).toBe('2020-06-30');
    expect(parseFileDateText('30-06-2020')).toBe('2020-06-30');
    expect(parseFileDateText('2020-06-30')).toBe('2020-06-30');
    expect(parseFileDateText('06/30/2020')).toBeNull();
    expect(parseFileDateText('30/06/20')).toBeNull();
    expect(parseFileDateText('31/02/2020')).toBeNull();
    expect(formatDayFirst('2026-10-06')).toBe('06/10/2026');
    expect(formatDayFirstDateTime('2026-10-06T10:05:00Z')).toMatch(/^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
  });
});
