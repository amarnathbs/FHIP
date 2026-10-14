// Planning Benchmarks Admin — what each table cell SHOWS, as pure functions (no React), so it can be
// unit-tested with sample rows (tests/unit/adminBenchmarksCells.test.ts).
//
// Two rules this module exists to enforce:
//   1. A cell never shows a raw database id (UUID). The Metric column used to return the row's own
//      `metric_definition_id` before it ever reached the joined metric name, so operators saw a UUID.
//      A name is looked up from the joined definition (metric_name, then metric_code); if neither is
//      available the cell says "Unnamed metric". Every other id-shaped value is shown as an em dash.
//   2. Dates are day-first through the canonical formatter. This page has no single country, so it
//      uses the AU shape dd/mm/yyyy (PO rule, Document2 findings #8/#19).
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';
import { formatFigure, type FigureContext } from '@/lib/planning-benchmarks/figureFormat';

export type Row = Record<string, unknown>;

// §18 — one register for every raw lifecycle value this screen can show, so an operator never has to
// interpret a database enum. An unmapped value falls back to its raw text rather than being hidden.
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  under_review: 'Under review',
  approved: 'Approved',
  active: 'Active',
  superseded: 'Superseded',
  suspended: 'Suspended',
  archived: 'Archived',
  retired: 'Retired',
  rejected: 'Rejected',
  pending: 'Pending',
};

export const UNNAMED_METRIC = 'Unnamed metric';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is a UUID-shaped string (a raw database id). */
export function isUuidShaped(v: unknown): boolean {
  return typeof v === 'string' && UUID_SHAPE.test(v.trim());
}

/** Columns whose value is a date or a timestamp. */
const DATE_COLUMNS = new Set(['Effective From', 'Review Due']);
const DATETIME_COLUMNS = new Set(['Imported At']);

export function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (isUuidShaped(v)) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The raw (un-formatted) value for a column; may be a UUID for an unmapped column — use fmtCell to display. */
export function cell(r: Row, col: string): unknown {
  const sources = r['benchmark_sources'] as Row | null | undefined;
  const datasets = r['benchmark_datasets'] as Row | null | undefined;
  const metricDefs = r['benchmark_metric_definitions'] as Row | null | undefined;

  // The Metric column NEVER reads metric_definition_id: that is the foreign key, not a label. The name
  // comes from the joined definition (or, for a flattened row, metric_name / metric_code).
  if (col === 'Metric') {
    const name = metricDefs?.metric_name ?? metricDefs?.metric_code ?? r['metric_name'] ?? r['metric_code'];
    return typeof name === 'string' && name.trim() !== '' && !isUuidShaped(name) ? name : UNNAMED_METRIC;
  }

  const map: Record<string, string> = {
    Source: 'source_name',
    Publisher: 'publisher',
    Status: col === 'Status' && 'status' in r ? 'status' : 'data_status',
    'Country/Quality': 'country_code',
    Dataset: 'dataset_name',
    Version: 'version',
    Class: 'benchmark_class',
    Evidence: 'evidence_level',
    'Effective From': 'effective_from',
    'Review Due': 'review_due_at',
    'Cohort Code': 'cohort_code',
    Tier: 'cohort_tier',
    Description: 'cohort_description',
    Statistic: 'statistic_type',
    Value: 'value_numeric',
    Currency: 'original_currency',
    'Band Label': 'band_label',
    'Band Tier': 'band_tier',
    Min: 'lower_bound',
    Max: 'upper_bound',
    Approval: 'approval_status',
    'Imported At': 'created_at',
  };
  const key = map[col];
  if (key && key in r) return r[key];
  // nested join fields
  if (col === 'Publisher' && sources) return sources.publisher ?? sources.source_name;
  if (col === 'Dataset' && datasets) return datasets.dataset_name;
  return r[col] ?? '—';
}

/** What the table shows for a cell. Never a raw id; dates are dd/mm/yyyy (AU shape, no single country here). */
export function fmtCell(col: string, v: unknown): string {
  if (col === 'Metric') return typeof v === 'string' && v.trim() !== '' && !isUuidShaped(v) ? v : UNNAMED_METRIC;
  if (isUuidShaped(v)) return '—';
  if (typeof v === 'string' && DATE_COLUMNS.has(col) && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDateShort(v.slice(0, 10), 'AUD');
  if (typeof v === 'string' && DATETIME_COLUMNS.has(col) && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDateTimeShort(v, 'AUD');
  if (typeof v === 'string' && DATETIME_COLUMNS.has(col) && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDateShort(v, 'AUD');
  const raw = fmt(v);
  if (col === 'Status' || col === 'Approval') return STATUS_LABELS[raw] ?? raw;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return raw;
}

/** Convenience: the displayed text for one cell of one row. */
export function displayCell(r: Row, col: string): string {
  const v = cell(r, col);
  const ctx = figureContextFor(r, col);
  if (ctx !== null && v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return formatFigure(v as string | number, ctx);
  return fmtCell(col, v);
}

/**
 * A figure is shown by ITS OWN currency or unit (lib/planning-benchmarks/figureFormat.ts), never by the viewer's locale.
 * An observed value carries its unit and original_currency on the row. A band carries the country of its group and the
 * unit of its metric (the joined definition), and has no currency of its own.
 */
function figureContextFor(r: Row, col: string): FigureContext | null {
  if (col === 'Value') return { unit: typeof r['unit'] === 'string' ? (r['unit'] as string) : null, currency: typeof r['original_currency'] === 'string' ? (r['original_currency'] as string) : null };
  if (col === 'Min' || col === 'Max') {
    const def = r['benchmark_metric_definitions'] as Row | null | undefined;
    return { unit: typeof def?.unit === 'string' ? def.unit : null, country: typeof r['country_code'] === 'string' ? (r['country_code'] as string) : null };
  }
  return null;
}
