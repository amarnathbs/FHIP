import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { formatDateShort } from '@/lib/engines/date';
import { listReports, getReport } from '@/lib/services/reportsData';
import { GenerateReportButton } from '@/components/reports/GenerateReportButton';
import { ReportHistoryTable } from '@/components/reports/ReportHistoryTable';

export default async function ReportsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('user_profiles').select('preferred_currency').eq('user_id', user.id).single();
  const currency = (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const reports = await listReports(user.id);
  const latest = reports.find((r) => ['ready', 'published'].includes(r.status)) ?? null;
  const latestDetail = latest ? await getReport(user.id, latest.id) : null;
  const execSummary = latestDetail?.sections.find((s) => s.sectionCode === 'executive_summary');
  const metrics = (execSummary?.sectionData.metrics as { label: string; currentText: string; displayText: string }[] | undefined) ?? [];
  const scoreMetric = metrics.find((m) => m.label === 'Financial Health Score');
  const netWorthMetric = metrics.find((m) => m.label === 'Net worth');

  return (
      <div className="space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Reports</h1>
            <p className="mt-1 text-muted">
              A structured monthly review of your financial position, financial health, progress, risks and next areas to review.
            </p>
          </div>
          <GenerateReportButton />
        </div>

        {latest ? (
          <SectionCard title="Latest Report">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-ink">{latest.title}</p>
                <p className="text-xs text-muted">
                  Generated {latest.generated_at ? formatDateShort(latest.generated_at, currency) : '—'} · Status: {latest.status}
                </p>
              </div>
              <Link href={`/reports/${latest.id}`} className="rounded border px-3 py-1.5 text-sm text-trust hover:border-trust">
                View report
              </Link>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted">Financial Health Score</p>
                <p className="text-lg font-semibold text-ink">{scoreMetric?.currentText ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Net worth</p>
                <p className="text-lg font-semibold text-ink">{netWorthMetric?.currentText ?? formatMoney(0, currency)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Data completeness</p>
                <p className="text-lg font-semibold text-ink">{latest.data_completeness_pct?.toFixed(0) ?? '—'}%</p>
              </div>
              <div>
                <p className="text-xs text-muted">Reporting currency</p>
                <p className="text-lg font-semibold text-ink">{latest.reporting_currency}</p>
              </div>
            </div>
          </SectionCard>
        ) : (
          <div className="rounded-card border border-dashed bg-gray-50 p-8 text-center">
            <p className="text-gray-700">No monthly reports have been generated yet. Complete the required financial information and generate your first report.</p>
          </div>
        )}

        <SectionCard title="Report History">
          <ReportHistoryTable reports={reports} currency={currency} />
        </SectionCard>

        <SectionCard title="Export Centre" description="Report exports (PDF, CSV) require a premium plan. In-app viewing and browser printing are available to everyone.">
          <p className="text-sm text-muted">Open a report to request an export or print it.</p>
        </SectionCard>

        {/* LR-8 WP-02/03/04/06 — Reports Hub consolidation. Interactive
            Forecasting and the Financial Activity analytics/review workspace
            deliberately stay where they already live (their own top-level
            nav entries) — this section makes their GENERATED outputs
            discoverable from Reports without moving or duplicating either
            module, matching the phase's own lock: "do not move interactive
            Forecasting into Reports" / "operational transaction review
            remains under Expenses". */}
        <SectionCard title="Other Reports & Outputs" description="Generated outputs that live in their own modules — opened here, not duplicated here.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ReportOutputCard
              href="/financial-data-hub/activity"
              title="Financial Activity"
              description="Approved income and spending activity, trends and category breakdowns from your connected/imported transactions."
            />
            <ReportOutputCard
              href="/forecast/report"
              title="Consolidated Forecasting Report"
              description="A single printable roll-up of every Forecasting module — Net Worth, Retirement, Goals, Debt and more."
            />
            <ReportOutputCard
              href="/forecast/variance"
              title="Forecast Variance"
              description="How your actual position compares with what was forecast, by category, as of your last comparison date."
            />
          </div>
        </SectionCard>
      </div>
  );
}

function ReportOutputCard({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link href={href} className="block rounded-card border p-4 hover:border-trust">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <span className="mt-3 inline-block text-xs font-medium text-trust">Open →</span>
    </Link>
  );
}
