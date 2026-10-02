// Planning Benchmarks Admin: what table cells show. PO found raw UUIDs in the Metric column of
// Observed values and Planning target ranges: the cell function returned the row's own
// metric_definition_id before it reached the joined metric name. These tests pin the fix and carry a
// named negative control (a faithful copy of the OLD cell function) that must fail the same checks.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNNAMED_METRIC, displayCell, fmt, fmtCell, isUuidShaped, type Row } from '@/components/admin/adminBenchmarksCells';

const UUID = '3f2b8c1e-9a4d-4e7b-8c55-0d1f6a7b9e21';
const UUID2 = '8d6e2f40-1b3c-4a59-9f77-2c4e5a6b7d80';
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Columns of each tab, copied from columnsFor() in AdminBenchmarksClient.tsx (a contract test below pins that).
const TAB_COLUMNS: Record<string, string[]> = {
  sources: ['Source', 'Publisher', 'Status', 'country_code', 'citation_text', 'quality_rating'],
  datasets: ['Dataset', 'Version', 'Class', 'Evidence', 'Status', 'Effective From', 'Review Due', 'Publisher'],
  cohorts: ['Cohort Code', 'country_code', 'Tier', 'life_stage', 'household_type', 'Description'],
  values: ['Dataset', 'Metric', 'Statistic', 'Value', 'Currency', 'is_derived'],
  'target-ranges': ['Metric', 'country_code', 'Band Label', 'Band Tier', 'Min', 'Max', 'evidence_level'],
  'update-runs': ['Dataset', 'Approval', 'rows_imported', 'rows_rejected', 'Imported At'],
};

// Sample rows exactly as the routes return them (select('*, <join>')): every id column present.
const valueJoined: Row = {
  id: UUID2, dataset_id: UUID, cohort_id: UUID2, metric_definition_id: UUID, statistic_type: 'median', value_numeric: 12.5, original_currency: 'AUD', is_derived: false,
  created_at: '2026-10-01T09:05:33.512+00:00',
  benchmark_metric_definitions: { metric_code: 'savings_rate', metric_name: 'Savings rate' },
  benchmark_datasets: { dataset_name: 'ABS household 2024' },
};
const valueNoJoin: Row = { id: UUID2, dataset_id: UUID, metric_definition_id: UUID, statistic_type: 'median', value_numeric: 12.5, original_currency: 'AUD', is_derived: false };
const valueCodeOnly: Row = { ...valueNoJoin, benchmark_metric_definitions: { metric_code: 'savings_rate', metric_name: null } };
const rangeJoined: Row = {
  id: UUID2, metric_definition_id: UUID, country_code: 'AU', band_label: 'Healthy', band_tier: 2, lower_bound: 10, upper_bound: 20, evidence_level: 'published',
  benchmark_metric_definitions: { metric_code: 'savings_rate', metric_name: 'Savings rate' },
};
const rangeNoJoin: Row = { id: UUID2, metric_definition_id: UUID, country_code: 'AU', band_label: 'Healthy', band_tier: 2, lower_bound: 10, upper_bound: 20, evidence_level: 'published' };

// FAITHFUL COPY of the pre-fix cell(): the raw key in the column map wins before the nested join is consulted.
function oldCell(r: Row, col: string): unknown {
  const map: Record<string, string> = { Dataset: 'dataset_name', Publisher: 'publisher', Metric: 'metric_definition_id', Statistic: 'statistic_type', Value: 'value_numeric' };
  const key = map[col];
  if (key && key in r) return r[key];
  const sources = r['benchmark_sources'] as Row | undefined;
  const datasets = r['benchmark_datasets'] as Row | undefined;
  const metricDefs = r['benchmark_metric_definitions'] as Row | undefined;
  if (col === 'Publisher' && sources) return sources.publisher ?? sources.source_name;
  if (col === 'Dataset' && datasets) return datasets.dataset_name;
  if (col === 'Metric' && metricDefs) return metricDefs.metric_name ?? metricDefs.metric_code;
  return r[col] ?? '—';
}

describe('Metric column shows the metric NAME, never the id', () => {
  it('Observed values with a joined definition: the name', () => {
    expect(displayCell(valueJoined, 'Metric')).toBe('Savings rate');
  });
  it('Planning target ranges with a joined definition: the name', () => {
    expect(displayCell(rangeJoined, 'Metric')).toBe('Savings rate');
  });
  it('a definition with no name falls back to the metric code', () => {
    expect(displayCell(valueCodeOnly, 'Metric')).toBe('savings_rate');
  });
  it('NO join at all (only metric_definition_id): a neutral label, never the id', () => {
    expect(displayCell(valueNoJoin, 'Metric')).toBe(UNNAMED_METRIC);
    expect(displayCell(rangeNoJoin, 'Metric')).toBe(UNNAMED_METRIC);
    expect(UNNAMED_METRIC).toBe('Unnamed metric');
  });
  it('a flattened row (metric_name / metric_code on the row) also works', () => {
    expect(displayCell({ metric_definition_id: UUID, metric_name: 'Debt ratio' }, 'Metric')).toBe('Debt ratio');
    expect(displayCell({ metric_definition_id: UUID, metric_code: 'debt_ratio' }, 'Metric')).toBe('debt_ratio');
  });
  it('a name that is itself an id, an empty name or a null join never leaks', () => {
    expect(displayCell({ benchmark_metric_definitions: { metric_name: UUID } }, 'Metric')).toBe(UNNAMED_METRIC);
    expect(displayCell({ benchmark_metric_definitions: { metric_name: '  ' } }, 'Metric')).toBe(UNNAMED_METRIC);
    expect(displayCell({ metric_definition_id: UUID, benchmark_metric_definitions: null }, 'Metric')).toBe(UNNAMED_METRIC);
  });
});

describe('no cell on any tab can render a uuid-shaped string', () => {
  const sampleRows: Array<[string, Row]> = [
    ['values', valueJoined], ['values', valueNoJoin], ['values', valueCodeOnly],
    ['target-ranges', rangeJoined], ['target-ranges', rangeNoJoin],
    ['sources', { id: UUID, source_name: 'ABS', publisher: 'ABS', status: 'approved', country_code: 'AU', citation_text: 'c', quality_rating: 'A', created_by: UUID2 }],
    ['datasets', { id: UUID, source_id: UUID2, dataset_name: 'D', version: '1', benchmark_class: 'x', evidence_level: 'published', data_status: 'active', effective_from: '2026-01-01', review_due_at: '2027-01-01', benchmark_sources: { publisher: 'ABS' } }],
    ['datasets', { id: UUID, source_id: UUID2, dataset_name: UUID, benchmark_sources: { publisher: UUID2 } }],
    ['cohorts', { id: UUID, dataset_id: UUID2, cohort_code: 'C1', country_code: 'AU', cohort_tier: 1, life_stage: 'x', household_type: 'y', cohort_description: 'd', benchmark_datasets: { dataset_name: 'D' } }],
    ['update-runs', { id: UUID, dataset_id: UUID2, source_id: UUID2, approval_status: 'approved', rows_imported: 3, rows_rejected: 0, created_at: '2026-10-01T09:05:33Z', benchmark_datasets: { dataset_name: 'D', version: '1' } }],
    ['update-runs', { id: UUID, dataset_id: UUID2, approval_status: 'pending' }],
  ];

  it('every column of every tab, for every sample row, is free of uuid-shaped text', () => {
    for (const [tab, row] of sampleRows) {
      for (const col of TAB_COLUMNS[tab]) {
        const shown = displayCell(row, col);
        expect(shown, `${tab}/${col}`).not.toMatch(UUID_ANYWHERE);
        expect(isUuidShaped(shown), `${tab}/${col}`).toBe(false);
      }
    }
  });

  it('fmt and fmtCell turn a bare id into an em dash (a defence even for a column nobody mapped)', () => {
    expect(fmt(UUID)).toBe('—');
    expect(fmtCell('Anything', UUID)).toBe('—');
    expect(fmtCell('Anything', ` ${UUID.toUpperCase()} `)).toBe('—');
    expect(fmt('not-a-uuid')).toBe('not-a-uuid');
    expect(fmt(null)).toBe('—');
  });

  it('a dataset whose name is missing but whose id is present shows an em dash, not the id', () => {
    expect(displayCell({ id: UUID, dataset_id: UUID2, benchmark_datasets: null }, 'Dataset')).toBe('—');
  });

  it('shadowing check: a raw id column can never win over a joined label for Dataset / Publisher', () => {
    const r: Row = { dataset_id: UUID, benchmark_datasets: { dataset_name: 'ABS 2024' } };
    expect(displayCell(r, 'Dataset')).toBe('ABS 2024');
    expect(displayCell({ source_id: UUID, benchmark_sources: { publisher: 'ABS', source_name: 'S' } }, 'Publisher')).toBe('ABS');
  });
});

describe('dates on this page are dd/mm/yyyy (the AU shape: no single country here)', () => {
  const ds: Row = { effective_from: '2026-01-31', review_due_at: '2027-03-09', created_at: '2026-10-01T09:05:33.512+00:00' };
  it('Effective From and Review Due', () => {
    expect(displayCell(ds, 'Effective From')).toBe('31/01/2026');
    expect(displayCell(ds, 'Review Due')).toBe('09/03/2027');
    expect(displayCell({ review_due_at: '2027-03-09T00:00:00+00:00' }, 'Review Due')).toBe('09/03/2027');
  });
  it('Imported At is a day-first date and time', () => {
    expect(displayCell(ds, 'Imported At')).toMatch(/^\d{2}\/\d{2}\/\d{4}, /);
    expect(displayCell(ds, 'Imported At')).not.toMatch(/2026-/);
  });
  it('an empty date is an em dash; boolean and status labels are unchanged', () => {
    expect(displayCell({ effective_from: null }, 'Effective From')).toBe('—');
    expect(displayCell({ is_derived: true }, 'is_derived')).toBe('Yes');
    expect(displayCell({ data_status: 'under_review' }, 'Status')).toBe('Under review');
    expect(displayCell({ approval_status: 'approved' }, 'Approval')).toBe('Approved');
  });
});

describe('NEGATIVE CONTROL CELL-NC-1: the pre-fix cell function shows the id, and these checks catch it', () => {
  // The old fmt/fmtCell had no id guard either.
  const oldFmtCell = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const shownOld = (r: Row, col: string) => oldFmtCell(oldCell(r, col));

  it('the old function renders a uuid for a joined Observed-value row (the PO-reported defect)', () => {
    expect(shownOld(valueJoined, 'Metric')).toBe(UUID);
    expect(shownOld(valueJoined, 'Metric')).toMatch(UUID_ANYWHERE);
  });
  it('the old function renders a uuid for a joined target-range row', () => {
    expect(shownOld(rangeJoined, 'Metric')).toMatch(UUID_ANYWHERE);
  });
  it('the "no uuid on any tab" assertion FAILS when run against the old function', () => {
    const failing: string[] = [];
    for (const [tab, row] of [['values', valueJoined], ['values', valueNoJoin], ['target-ranges', rangeJoined], ['target-ranges', rangeNoJoin]] as Array<[string, Row]>) {
      for (const col of TAB_COLUMNS[tab]) if (UUID_ANYWHERE.test(shownOld(row, col))) failing.push(`${tab}/${col}`);
    }
    expect(failing).toEqual(['values/Metric', 'values/Metric', 'target-ranges/Metric', 'target-ranges/Metric']);
    // ...and the real function has none:
    for (const [tab, row] of [['values', valueJoined], ['values', valueNoJoin], ['target-ranges', rangeJoined], ['target-ranges', rangeNoJoin]] as Array<[string, Row]>) {
      for (const col of TAB_COLUMNS[tab]) expect(UUID_ANYWHERE.test(displayCell(row, col)), `${tab}/${col}`).toBe(false);
    }
  });
});

describe('wiring: the client uses this module, the routes join the metric definition, the columns match', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const client = readFileSync(path.join(ROOT, 'components/admin/AdminBenchmarksClient.tsx'), 'utf8');

  it('the client imports the cell functions and no longer defines its own cell/fmtCell', () => {
    expect(client).toMatch(/from '@\/components\/admin\/adminBenchmarksCells'/);
    expect(client).not.toMatch(/function cell\(/);
    expect(client).not.toMatch(/function fmtCell\(/);
    expect(client).not.toMatch(/metric_definition_id/);
  });

  it('both tabs\' API selects join benchmark_metric_definitions with the name and the code', () => {
    for (const f of ['values', 'target-ranges']) {
      const src = readFileSync(path.join(ROOT, `app/api/admin/benchmarks/${f}/route.ts`), 'utf8');
      expect(src, f).toMatch(/benchmark_metric_definitions(!inner)?\(metric_code, metric_name\)/);
    }
  });

  it('TAB_COLUMNS here equals columnsFor() in the client', () => {
    for (const [tab, cols] of Object.entries(TAB_COLUMNS)) {
      const m = new RegExp(`case '${tab}':\\s*return \\[([^\\]]*)\\]`).exec(client);
      expect(m, tab).not.toBeNull();
      const listed = [...(m as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      expect(listed, tab).toEqual(cols);
    }
  });
});
