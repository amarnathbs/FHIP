import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { resolveForecastPageContext, getForecastVariance, type VarianceForecastCategory, type CategoryVariance } from '@/lib/services/forecastData';
import { formatMoney } from '@/lib/engines/money';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

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
  insufficient_data: 'Insufficient Data',
};

const STATUS_CLASS: Record<string, string> = {
  significantly_ahead: 'bg-progress/10 text-progress',
  ahead_of_plan: 'bg-progress/10 text-progress',
  on_track: 'bg-progress/10 text-progress',
  slightly_behind: 'bg-caution/10 text-caution',
  at_risk: 'bg-caution/10 text-caution',
  significantly_off_track: 'bg-risk/10 text-risk',
  insufficient_data: 'bg-gray-100 text-muted',
};

function fmt(value: number | null, currency: 'AUD' | 'INR') {
  return value === null ? '—' : formatMoney(value, currency);
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
    <AppShell>
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
          description={`Comparison date: ${variances[0]?.comparisonDate ?? '—'}. For net worth, retirement, goals and cross-border wealth, a higher actual value is generally favourable; for debt, a lower actual balance is favourable.`}
        >
          <div className="overflow-x-auto">
            <table data-testid="forecast-variance-table" className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr>
                  <th className="py-1 pr-3">Category</th>
                  <th className="py-1 pr-3">Start Value</th>
                  <th className="py-1 pr-3">Forecast Till Date</th>
                  <th className="py-1 pr-3">Actual Till Date</th>
                  <th className="py-1 pr-3">Variance</th>
                  <th className="py-1 pr-3">Variance %</th>
                  <th className="py-1 pr-3">Result</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Revised Forecast</th>
                  <th className="py-1 pr-3">Final Target</th>
                  <th className="py-1">Remaining Gap</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.map((c, i) => {
                  const v = variances[i];
                  return (
                    <tr key={c.key} data-testid={`variance-row-${c.key}`} className="border-t align-top">
                      <td className="py-2 pr-3 font-medium text-gray-800">{c.label}</td>
                      <td className="py-2 pr-3">{fmt(v.startValue, currency)}</td>
                      <td data-testid="variance-forecast" className="py-2 pr-3">
                        {fmt(v.forecastTillDate, currency)}
                      </td>
                      <td data-testid="variance-actual" className="py-2 pr-3">
                        {fmt(v.actualTillDate, currency)}
                      </td>
                      <td className="py-2 pr-3">{fmt(v.varianceAmount, currency)}</td>
                      <td className="py-2 pr-3">{v.variancePercentage !== null ? `${v.variancePercentage >= 0 ? '+' : ''}${v.variancePercentage.toFixed(1)}%` : '—'}</td>
                      <td className="py-2 pr-3 capitalize">{v.result ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[v.status]}`}>{STATUS_LABEL[v.status]}</span>
                      </td>
                      <td className="py-2 pr-3">{fmt(v.revisedForecast, currency)}</td>
                      <td className="py-2 pr-3">{fmt(v.finalTarget, currency)}</td>
                      <td className="py-2">{fmt(v.finalTargetGap, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted">
            A favourable variance does not automatically mean the final target will be achieved; an unfavourable variance does not
            automatically mean the final target is impossible. Rows with no forecast history yet show &quot;Insufficient Data&quot; —
            generate a forecast for that category first to establish a baseline.
          </p>
        </SectionCard>
      </div>
    </AppShell>
  );
}
