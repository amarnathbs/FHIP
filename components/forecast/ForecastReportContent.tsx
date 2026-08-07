import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoneyWhole } from '@/lib/engines/money';
import type { ForecastReportData } from '@/lib/services/forecastReportData';
import { ReportTrendChart, ReportAllocationChart, ReportScenarioBarChart, ReportVarianceBarChart } from '@/components/forecast/ForecastReportCharts';

// The Consolidated Forecasting Report's body — extracted so both the
// interactive page (app/(app)/forecast/report/page.tsx, wrapped in AppShell
// with on-screen action buttons) and the bare print route
// (app/(app)/forecast/report/print/page.tsx, used by the headless-Chromium
// PDF renderer) render identical content from one source, the same way
// components/reports/ReportPreview.tsx is shared between the Free/Premium
// report's interactive and print routes.

const SEVERITY_CLASS: Record<string, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-caution/10 text-caution',
  high: 'bg-risk/10 text-risk',
  critical: 'bg-risk/20 text-risk',
};

const ALLOCATION_BUCKET_LABEL: Record<string, string> = {
  cash: 'Cash',
  property: 'Property',
  shares: 'Shares',
  super: 'Super / Retirement',
  business: 'Business',
  fixed_income: 'Fixed Income',
  crypto: 'Crypto',
  gold: 'Gold',
  other: 'Other',
};

interface ResultRow {
  period_number: number;
  period_date: string;
  closing_value: number;
  target_value: number | null;
  entity_id: string | null;
  entity_type: string;
}
interface ExplanationRow {
  title: string;
  explanation_text: string;
  entity_id: string | null;
  entity_type: string;
}
type RunDetail = { run: { id: string; status: string; created_at: string }; results: ResultRow[]; explanations: ExplanationRow[] } | null;

const STATUS_LABEL: Record<string, string> = {
  significantly_ahead: 'Significantly Ahead',
  ahead_of_plan: 'Ahead of Plan',
  on_track: 'On Track',
  slightly_behind: 'Slightly Behind',
  at_risk: 'At Risk',
  significantly_off_track: 'Significantly Off Track',
  baseline_established: 'Baseline Established',
  insufficient_data: 'Insufficient Data',
};

const VARIANCE_LABEL: Record<string, string> = {
  net_worth: 'Net Worth',
  retirement: 'Retirement',
  goal: 'Goals',
  debt: 'Debt',
  cross_border: 'Cross-Border',
};

function fmt(value: number | null | undefined, currency: 'AUD' | 'INR') {
  return value === null || value === undefined ? '—' : formatMoneyWhole(value, currency);
}

function pickPeriod(results: ResultRow[], months: number, entityId: string | null = null) {
  return results.find((r) => r.period_number === months && r.entity_id === entityId) ?? null;
}

function entitiesOf(results: ExplanationRow[]) {
  const seen = new Set<string>();
  const out: { entityId: string | null; entityType: string }[] = [];
  for (const r of results) {
    const key = `${r.entity_type}:${r.entity_id ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ entityId: r.entity_id, entityType: r.entity_type });
    }
  }
  return out;
}

function RunSummary({
  run,
  currency,
  perEntity = false,
}: {
  run: RunDetail;
  currency: 'AUD' | 'INR';
  perEntity?: boolean;
}) {
  if (!run || run.results.length === 0) {
    return null;
  }

  if (!perEntity) {
    const y1 = pickPeriod(run.results, 12);
    const y5 = pickPeriod(run.results, 60);
    const y10 = pickPeriod(run.results, 120);
    const explanation = run.explanations[0] ?? null;
    return (
      <div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="In 1 year" value={y1 ? fmt(y1.closing_value, currency) : '—'} />
          <Stat label="In 5 years" value={y5 ? fmt(y5.closing_value, currency) : '—'} />
          <Stat label="In 10 years" value={y10 ? fmt(y10.closing_value, currency) : '—'} />
        </div>
        {explanation && (
          <p className="mt-4 text-justify text-sm text-gray-600">
            <span className="font-semibold text-gray-800">{explanation.title}: </span>
            {explanation.explanation_text}
          </p>
        )}
      </div>
    );
  }

  const entities = entitiesOf(run.explanations);
  if (entities.length === 0) {
    return null;
  }
  return (
    <div className="space-y-4">
      {entities.map(({ entityId, entityType }) => {
        const explanation = run.explanations.find((e) => e.entity_id === entityId && e.entity_type === entityType);
        const y5 = pickPeriod(run.results, 60, entityId);
        const y10 = pickPeriod(run.results, 120, entityId);
        return (
          <div key={`${entityType}:${entityId ?? ''}`} className="rounded border p-3">
            <p className="font-semibold text-gray-800">{explanation?.title ?? entityType}</p>
            <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-2">
              <Stat label="Value in 5 years" value={y5 ? fmt(y5.closing_value, currency) : '—'} />
              <Stat label="Value in 10 years" value={y10 ? fmt(y10.closing_value, currency) : '—'} />
            </div>
            {explanation && <p className="mt-2 text-justify text-sm text-gray-600">{explanation.explanation_text}</p>}
          </div>
        );
      })}
    </div>
  );
}

export function ForecastReportContent({ data }: { data: ForecastReportData }) {
  const { currency, dashboard } = data;
  const generatedAtLabel = new Date(data.generatedAt).toLocaleString();

  // Sections and variance rows are shown only where the user actually has
  // data for them — a category with nothing recorded is omitted entirely
  // rather than rendered with a "no data" placeholder, so the report never
  // reads like an unfilled template.
  const goalEntities = entitiesOf(data.goalRun?.explanations ?? []);
  const debtEntities = entitiesOf(data.debtRun?.explanations ?? []);
  const investmentEntities = entitiesOf(data.investmentRun?.explanations ?? []);
  const hasNetWorth = Boolean(data.netWorthRun && data.netWorthRun.results.length > 0);
  const hasRetirement = dashboard.hasRetirement && Boolean(data.retirementRun && data.retirementRun.results.length > 0);
  const hasGoals = goalEntities.length > 0;
  const hasDebt = debtEntities.length > 0;
  const hasInvestments = investmentEntities.length > 0;
  const hasCrossBorder = dashboard.countriesInUse.length > 1;
  const hasResilience = Boolean(data.resilienceRun && data.resilienceRun.results.length > 0);
  const CATEGORY_HAS_DATA: Record<string, boolean> = {
    net_worth: hasNetWorth,
    retirement: hasRetirement,
    goal: hasGoals,
    debt: hasDebt,
    cross_border: hasCrossBorder,
  };
  const visibleVariances = data.variances.filter((v) => CATEGORY_HAS_DATA[v.forecastCategory] ?? true);

  return (
    <div className="report-print-root space-y-6">
      {/* Page 1 — Purpose / how to read */}
      <SectionCard title="About this report" className="report-section report-page-break">
        <p className="text-justify text-sm text-gray-600">
          This report consolidates every Forecasting Engine category — net worth, retirement, goals, debt, investments,
          cross-border wealth and financial resilience — into a single document, generated for scenario{' '}
          <span className="font-semibold">&quot;{data.scenarioName}&quot;</span> as of {generatedAtLabel}. All figures are
          deterministic projections from your recorded data and the assumptions listed in the Assumptions section below —
          they are not guarantees and are not personalised financial advice.
        </p>
        <p className="mt-3 text-justify text-sm text-gray-600">
          Each section states what was projected, how it compares with where you actually are (for categories with an
          established forecast history), and what it means in plain language. Categories with no recorded data are omitted
          from this report rather than shown as an empty section.
        </p>
      </SectionCard>

      {/* Page 2 — One-page summary */}
      <SectionCard title="One-Page Summary" className="report-section report-page-break">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Current net worth" value={fmt(dashboard.netWorth, currency)} />
          <Stat label="Total assets" value={fmt(dashboard.totalAssetsCombined, currency)} />
          <Stat label="Total liabilities" value={fmt(dashboard.totalLiabilities, currency)} />
          <Stat label="Monthly surplus" value={fmt(dashboard.monthlySurplus, currency)} />
        </div>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-semibold text-gray-700">Net worth allocation</p>
            <ReportAllocationChart
              slices={dashboard.netWorthAllocation.map((s) => ({ label: ALLOCATION_BUCKET_LABEL[s.bucket] ?? 'Other', value: s.value }))}
              currency={currency}
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-gray-700">Forecast vs actual, by category</p>
            <ReportVarianceBarChart
              rows={visibleVariances.map((v) => ({ label: VARIANCE_LABEL[v.forecastCategory] ?? v.forecastCategory, forecast: v.forecastTillDate, actual: v.actualTillDate }))}
              currency={currency}
            />
          </div>
        </div>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="py-1 pr-3">Category</th>
                <th className="py-1 pr-3">Result</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleVariances.map((v) => (
                <tr key={v.forecastCategory} className="border-t">
                  <td className="py-2 pr-3 font-medium text-gray-800">{VARIANCE_LABEL[v.forecastCategory] ?? v.forecastCategory}</td>
                  <td className="py-2 pr-3 capitalize">{v.result ?? '—'}</td>
                  <td className="py-2">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {STATUS_LABEL[v.status] ?? v.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* Page 3 — Consolidated variance */}
      <SectionCard
        title="Consolidated Variance"
        description={`Comparison date: ${data.comparisonDate} (data last updated ${data.dataLastUpdated ?? 'today, live'}; report generated ${generatedAtLabel}). Compares where you were expected to be with where you actually are, both as at the comparison date — not against today's live position or the final long-term forecast.`}
        className="report-section report-page-break"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="py-1 pr-3">Category</th>
                <th className="py-1 pr-3">Start Value</th>
                <th className="py-1 pr-3">Forecast Till Date</th>
                <th className="py-1 pr-3">Actual Till Date</th>
                <th className="py-1 pr-3">Variance %</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Final Target</th>
                <th className="py-1">Remaining Gap</th>
              </tr>
            </thead>
            <tbody>
              {visibleVariances.map((v) => (
                <tr key={v.forecastCategory} className="border-t align-top">
                  <td className="py-2 pr-3 font-medium text-gray-800">{VARIANCE_LABEL[v.forecastCategory] ?? v.forecastCategory}</td>
                  <td className="py-2 pr-3">{fmt(v.startValue, currency)}</td>
                  <td className="py-2 pr-3">
                    {fmt(v.forecastTillDate, currency)}
                    {v.forecastHorizonExceeded ? <sup className="ml-0.5 text-caution">†</sup> : null}
                  </td>
                  <td className="py-2 pr-3">{fmt(v.actualTillDate, currency)}</td>
                  <td className="py-2 pr-3">
                    {v.variancePercentage !== null ? `${v.variancePercentage >= 0 ? '+' : ''}${v.variancePercentage.toFixed(1)}%` : 'N/A'}
                  </td>
                  <td className="py-2 pr-3">{STATUS_LABEL[v.status] ?? v.status}</td>
                  <td className="py-2 pr-3">{fmt(v.finalTarget, currency)}</td>
                  <td className="py-2">{fmt(v.finalTargetGap, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visibleVariances.some((v) => v.forecastHorizonExceeded) && (
          <p className="mt-3 text-xs text-muted">
            † The comparison date is beyond this category&apos;s original forecast horizon — Forecast Till Date shows the final projected period, not a same-date value.
          </p>
        )}
      </SectionCard>

      {/* Net worth + growth drivers */}
      {hasNetWorth && (
        <SectionCard title="Net Worth Forecast" className="report-section report-page-break">
          <div className="mb-6">
            <ReportTrendChart results={data.netWorthRun!.results} currency={currency} />
          </div>
          <RunSummary run={data.netWorthRun} currency={currency} />
        </SectionCard>
      )}

      {/* Retirement */}
      {hasRetirement && (
        <SectionCard title="Retirement Forecast" className="report-section report-page-break">
          <div className="mb-6">
            <ReportTrendChart results={data.retirementRun!.results} currency={currency} />
          </div>
          <RunSummary run={data.retirementRun} currency={currency} />
        </SectionCard>
      )}

      {/* Goal summary + detail */}
      {hasGoals && (
        <SectionCard title="Goal Forecasts" className="report-section report-page-break">
          <div className="mb-6">
            <p className="mb-2 text-sm font-semibold text-gray-700">Combined value across all goals</p>
            <ReportTrendChart results={data.goalRun!.results} currency={currency} summed />
          </div>
          <RunSummary run={data.goalRun} currency={currency} perEntity />
        </SectionCard>
      )}

      {/* Debt */}
      {hasDebt && (
        <SectionCard title="Debt Reduction Forecast" className="report-section report-page-break">
          <div className="mb-6">
            <p className="mb-2 text-sm font-semibold text-gray-700">Total remaining balance across all debts</p>
            <ReportTrendChart results={data.debtRun!.results} currency={currency} summed />
          </div>
          <RunSummary run={data.debtRun} currency={currency} perEntity />
        </SectionCard>
      )}

      {/* Investment growth */}
      {hasInvestments && (
        <SectionCard title="Investment Growth Forecast" className="report-section report-page-break">
          <div className="mb-6">
            <p className="mb-2 text-sm font-semibold text-gray-700">Combined value across all investments</p>
            <ReportTrendChart results={data.investmentRun!.results} currency={currency} summed />
          </div>
          <RunSummary run={data.investmentRun} currency={currency} perEntity />
        </SectionCard>
      )}

      {/* Cross-border */}
      {hasCrossBorder && data.crossBorderRun && data.crossBorderRun.results.length > 0 && (
        <SectionCard title="Cross-Border Forecast" className="report-section report-page-break">
          <div className="mb-6">
            <ReportTrendChart results={data.crossBorderRun.results} currency={currency} />
          </div>
          <RunSummary run={data.crossBorderRun} currency={currency} />
        </SectionCard>
      )}

      {/* Resilience */}
      {hasResilience && (
        <SectionCard title="Financial Resilience Forecast" className="report-section report-page-break">
          <div className="mb-6">
            <p className="mb-2 text-sm font-semibold text-gray-700">Projected net worth under the modelled stress scenario</p>
            <ReportTrendChart results={data.resilienceRun!.results} currency={currency} />
          </div>
          <RunSummary run={data.resilienceRun} currency={currency} />
        </SectionCard>
      )}

      {/* Scenario comparison */}
      {data.scenarioComparison.length > 0 && (
        <SectionCard title="Scenario Comparison" className="report-section report-page-break">
          <div className="mb-6">
            <ReportScenarioBarChart scenarios={data.scenarioComparison} currency={currency} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th className="py-1 pr-3">Scenario</th>
                  <th className="py-1 pr-3">In 1 year</th>
                  <th className="py-1 pr-3">In 5 years</th>
                  <th className="py-1">In 10 years</th>
                </tr>
              </thead>
              <tbody>
                {data.scenarioComparison.map((s) => (
                  <tr key={s.scenarioId} className="border-t">
                    <td className="py-2 pr-3 font-medium text-gray-800">{s.scenarioName}</td>
                    <td className="py-2 pr-3">{fmt(s.oneYear, currency)}</td>
                    <td className="py-2 pr-3">{fmt(s.fiveYear, currency)}</td>
                    <td className="py-2">{fmt(s.tenYear, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* FHIP-FC-REC-001/002 — up to 5 ranked, non-conflicting recommendations
          from the real recommendation engine (action_recommendation_master),
          replacing what was previously a "major functional gap": no
          recommendations appeared in this report at all. */}
      {data.actionPlan.length > 0 && (
        <SectionCard title="Recommended Action Plan" className="report-section report-page-break">
          <div className="space-y-3">
            {data.actionPlan.map((action) => (
              <div key={action.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-gray-800">{action.title}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_CLASS[action.severity] ?? 'bg-gray-100 text-gray-500'}`}>
                    {action.severity}
                  </span>
                </div>
                <p className="mt-1 text-justify text-sm text-gray-600">{action.content}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Data quality / disclaimer — ahead of Assumptions so the report
          flows forecasts/recommendations first, then data quality, then
          assumptions/methodology/disclaimer at the very end, matching the
          general-formatting requirement applied report-wide. */}
      <SectionCard title="Data Quality & Disclaimer" className="report-section report-page-break">
        <p className="text-justify text-sm text-gray-600">
          This report is generated entirely from data you have recorded in FHIP and the assumptions listed below. It is a
          deterministic projection tool, not personalised financial, tax, or legal advice, and does not account for events
          or information not entered into the system. Categories with no recorded data are omitted from this report rather
          than estimated. Past forecast accuracy (shown in the Consolidated Variance section) does not guarantee future
          forecast accuracy.
        </p>
      </SectionCard>

      {/* Assumptions — always the last section. */}
      <SectionCard title="Forecast Assumptions" className="report-section">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="py-1 pr-3">Assumption</th>
                <th className="py-1 pr-3">Value</th>
                <th className="py-1 pr-3">Source</th>
                <th className="py-1">Reference</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(data.assumptions).map((a) => (
                <tr key={a.key} className="border-t">
                  <td className="py-2 pr-3 font-medium capitalize text-gray-800">{a.key.replace(/_/g, ' ')}</td>
                  <td className="py-2 pr-3">
                    {a.value}
                    {a.unit ? ` ${a.unit}` : a.valueType === 'percentage' ? '%' : ''}
                  </td>
                  <td className="py-2 pr-3 capitalize">{a.sourceType.replace(/_/g, ' ')}</td>
                  <td className="py-2 text-xs text-muted">{a.sourceReference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
