// The "Full Financial Twin Comparison" chapter of the Monthly Report.
//
// A stored report keeps only the Twin metric's CODE and numbers (financial_twin_metric_results has no label and no unit column), so the
// report used to hand the chart `label: undefined`: every row printed a bare number with no name, and the section on paper was a column of
// unlabelled figures (PO 18-10-2026, pages 21-24 of his PDF). The name, the unit and the category come from the metric catalogue, by code, at
// render time, so reports already saved are fixed without regenerating them. Pure: no clock, no I/O.
import { METRIC_CATALOGUE, type MetricDefinition, type MetricUnit } from '@/lib/engines/twin/metricCatalogue';
import { METRIC_CATEGORY_LABEL, type MetricCategory } from '@/lib/engines/twin/taxonomy';

export interface StoredTwinMetric {
  metricCode: string;
  userValue: number | null;
  peerValue: number | null;
  healthyMin: number | null;
  healthyMax: number | null;
  comparisonStatus: string | null;
  /** Present on a few older rows only; the catalogue is the source of truth. */
  label?: string;
  unit?: MetricUnit;
}

export interface TwinComparisonRow {
  metricCode: string;
  label: string;
  /** null when the code is not in the catalogue (a metric retired since the report was saved): the value is then shown as a plain number. */
  unit: MetricUnit | null;
  userValue: number | null;
  peerValue: number | null;
  healthyMin: number | null;
  healthyMax: number | null;
  comparisonStatus: string | null;
}

export interface TwinComparisonGroup {
  categoryCode: string;
  categoryLabel: string;
  rows: TwinComparisonRow[];
}

const BY_CODE = new Map<string, MetricDefinition>(METRIC_CATALOGUE.map((m) => [m.code, m]));

/** "debt_to_income" -> "Debt to income": the last resort for a code the catalogue no longer knows. */
export function humaniseMetricCode(code: string): string {
  const words = code.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Metric';
}

export function twinComparisonGroups(metrics: readonly StoredTwinMetric[]): TwinComparisonGroup[] {
  const rows = metrics.map((m) => {
    const def = BY_CODE.get(m.metricCode);
    const row: TwinComparisonRow & { order: number; category: string } = {
      metricCode: m.metricCode,
      label: def?.label ?? m.label ?? humaniseMetricCode(m.metricCode),
      unit: def?.unit ?? m.unit ?? null,
      userValue: m.userValue,
      peerValue: m.peerValue,
      healthyMin: m.healthyMin,
      healthyMax: m.healthyMax,
      comparisonStatus: m.comparisonStatus,
      order: def?.displayOrder ?? Number.MAX_SAFE_INTEGER,
      category: def?.category ?? 'other',
    };
    return row;
  });
  rows.sort((a, b) => a.order - b.order);
  const groups = new Map<string, TwinComparisonGroup>();
  for (const r of rows) {
    const { category, ...withOrder } = r;
    const row: TwinComparisonRow = { metricCode: withOrder.metricCode, label: withOrder.label, unit: withOrder.unit, userValue: withOrder.userValue, peerValue: withOrder.peerValue, healthyMin: withOrder.healthyMin, healthyMax: withOrder.healthyMax, comparisonStatus: withOrder.comparisonStatus };
    const group = groups.get(category) ?? { categoryCode: category, categoryLabel: METRIC_CATEGORY_LABEL[category as MetricCategory] ?? 'Other metrics', rows: [] };
    group.rows.push(row);
    groups.set(category, group);
  }
  return [...groups.values()];
}
