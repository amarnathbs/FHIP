import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildForecastReportData, resolveForecastReportRenderToken } from '@/lib/services/forecastReportData';
import { ForecastReportContent } from '@/components/forecast/ForecastReportContent';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { ReportPrintFrame } from '@/components/reports/ReportPrintFrame';

// Bare print view — no AppShell chrome, no nav, no action buttons. Opened
// two ways: (1) a logged-in user visiting directly to manually
// print/preview (normal session auth), or (2) the headless PDF renderer
// (lib/services/forecastReportPdfRenderer.ts), which has no session and
// instead presents a short-lived ?token= — same pattern as
// app/(app)/reports/[id]/print.
export default async function ForecastReportPrintPage({ searchParams }: { searchParams: Promise<{ token?: string; scenario?: string; print?: string }> }) {
  const { token, scenario, print } = await searchParams;

  if (token) {
    const resolved = await resolveForecastReportRenderToken(token);
    if (!resolved) notFound();
    const admin = createAdminClient();
    const data = await buildForecastReportData(resolved.userId, scenario ?? resolved.scenarioId ?? undefined, admin);
    return (
      <ReportPrintFrame identity="Consolidated Forecasting Report" serverRender>
        <ForecastReportContent data={data} />
      </ReportPrintFrame>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const data = await buildForecastReportData(user.id, scenario, supabase);
  return (
    <ReportPrintFrame identity="Consolidated Forecasting Report">
      <PrintTabToolbar autoPrint={print === '1'} parentHref="/forecast/report" parentLabel="Forecasting Report" />
      <ForecastReportContent data={data} />
    </ReportPrintFrame>
  );
}
