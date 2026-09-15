import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { resolveForecastPageContext, getForecastVariance, type VarianceForecastCategory, type CategoryVariance } from '@/lib/services/forecastData';
import { formatMoneyWhole } from '@/lib/engines/money';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';

const CATEGORIES: { key: VarianceForecastCategory; label: string }[] = [
  { key: 'net_worth', label: 'Net Worth' },
  { key: 'retirement', label: 'Retirement' },
  { key: 'goal', label: 'Goals' },
  { key: 'debt', label: 'Debt' },
  { key: 'cross_border', label: 'Cross-Border' },
];

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

const STATUS_CLASS: Record<string, string> = {
  significantly_ahead: 'bg-progress/10 text-progress',
  ahead_of_plan: 'bg-progress/10 text-progress',
  on_track: 'bg-progress/10 text-progress',
  slightly_behind: 'bg-caution/10 text-caution',
  at_risk: 'bg-caution/10 text-caution',
  significantly_off_track: 'bg-risk/10 text-risk',
  baseline_established: 'bg-gray-100 text-muted',
  insufficient_data: 'bg-gray-100 text-muted',
};

function fmt(value: number | null, currency: 'AUD' | 'INR') {
  return value === null ? '—' : formatMoneyWhole(value, currency);
}

export default async function ForecastVariancePage({ searchParams }: { searchParams: Promise<{ scenario?: string; date?: string }> }) {
  const { scenario, date } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { profile, scenarios, activeScenario } = await resolveForecastPageContext(user.id, scenario, supabase);
  const currency = profile.base_currency as 'AUD' | 'INR';

  const variances: CategoryVariance[] = await Promise.all(
    CATEGORIES.map((c) => getForecastVariance(user.id, profile.id, activeScenario.id, c.key, date, supabase))
  );

  return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Forecast Variance Report</h1>
            <p className="mt-1 text-muted">
              Compares where you were expected to be by the comparison date with where you actually are — it does not compare
              today&apos;s position directly with a future target. The actual and forecast amounts use the same comparison date.
            </p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>

        <SectionCard
          title="Consolidated Variance"
          description={`Comparison date: ${variances[0]?.comparisonDate ?? '—'}${variances[0]?.dataLastUpdated ? ` (data last updated ${variances[0].dataLastUpdated})` : ' (live data — no recorded snapshot yet)'}. For net worth, retirement, goals and cross-border wealth, a higher actual value is generally favourable; for debt, a lower actual balance is favourable.`}
        >
          <div className="overflow-x-auto">
            <table data-testid="forecast-variance-table" className="w-full min-w-[900px] text-sm">
              {/* App Review 2026-09-15, G2: every amount column is right-aligned
                  via the shared NUM_HEADER_CLASS/NUM_CELL_CLASS constants
                  (lib/ui/tableAlign.ts); text columns stay left-aligned. */}
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th className="py-1 pr-3">Category</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Start Value</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Forecast Till Date</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Actual Till Date</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Variance</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Variance %</th>
                  <th className="py-1 pr-3">Result</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Revised Forecast</th>
                  <th className={`py-1 pr-3 ${NUM_HEADER_CLASS}`}>Final Target</th>
                  <th className={`py-1 ${NUM_HEADER_CLASS}`}>Remaining Gap</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.map((c, i) => {
                  const v = variances[i];
                  return (
                    <tr key={c.key} data-testid={`variance-row-${c.key}`} className="border-t align-top">
                      <td className="py-2 pr-3 font-medium text-gray-800">
                        {c.label}
                        {/* App Review 2026-09-15, item 6.1: the reviewer could not
                            find where the Retirement figure came from and the
                            product offered nothing to check it against. Each row
                            now names the exact register and column it is summed
                            from. */}
                        <span className="mt-1 block max-w-[22rem] whitespace-normal text-xs font-normal text-muted">{v.actualBasis}</span>
                      </td>
                      <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{fmt(v.startValue, currency)}</td>
                      <td data-testid="variance-forecast" className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>
                        {fmt(v.forecastTillDate, currency)}
                        {v.forecastHorizonExceeded ? <sup className="ml-0.5 text-caution">†</sup> : null}
                      </td>
                      <td data-testid="variance-actual" className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>
                        {fmt(v.actualTillDate, currency)}
                      </td>
                      <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{fmt(v.varianceAmount, currency)}</td>
                      <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>
                        {v.variancePercentage !== null ? `${v.variancePercentage >= 0 ? '+' : ''}${v.variancePercentage.toFixed(1)}%` : '—'}
                      </td>
                      <td className="py-2 pr-3 capitalize">{v.result ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[v.status]}`}>{STATUS_LABEL[v.status]}</span>
                      </td>
                      <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{fmt(v.revisedForecast, currency)}</td>
                      <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>
                        {fmt(v.finalTarget, currency)}
                        {v.finalTarget === null ? (
                          <span className="mt-1 block max-w-[16rem] whitespace-normal text-left text-xs font-normal text-muted">{v.finalTargetBasis}</span>
                        ) : null}
                      </td>
                      <td className={`py-2 ${NUM_CELL_CLASS}`}>{fmt(v.finalTargetGap, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted">
            A favourable variance does not automatically mean the final target will be achieved; an unfavourable variance does not
            automatically mean the final target is impossible. Rows with no forecast history yet show &quot;Insufficient Data&quot; —
            generate a forecast for that category first to establish a baseline. Rows showing &quot;Baseline Established&quot; have a
            forecast but no elapsed comparison period yet — performance tracking becomes available once a later comparison date exists.
            {variances.some((v) => v.forecastHorizonExceeded)
              ? ' † The comparison date is beyond that category’s original forecast horizon — Forecast Till Date shows the final projected period, not a same-date value.'
              : ''}
          </p>
        </SectionCard>
      </div>
  );
}
