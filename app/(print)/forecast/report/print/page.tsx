import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildForecastReportData, resolveForecastReportRenderToken } from '@/lib/services/forecastReportData';
import { ForecastReportContent } from '@/components/forecast/ForecastReportContent';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { ReportPrintFrame } from '@/components/reports/ReportPrintFrame';
import { PrintDocumentTitle } from '@/components/reports/PrintDocumentTitle';
import { forecastReportPrintTitle } from '@/lib/reports/printDocumentTitle';

// The saved PDF's default file name is this page's title (Chrome uses <title>). Static fallback here; the report's month is set by
// <PrintDocumentTitle> and PrintTabToolbar (lib/reports/printDocumentTitle.ts), never the app-wide generic title.
export const metadata = { title: 'FHIP Consolidated Forecast Report' };

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
        <PrintDocumentTitle title={forecastReportPrintTitle({ generatedAt: data.generatedAt, currency: data.currency })} />
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
  const printTitle = forecastReportPrintTitle({ generatedAt: data.generatedAt, currency: data.currency });
  return (
    <ReportPrintFrame identity="Consolidated Forecasting Report">
      <PrintDocumentTitle title={printTitle} />
      <PrintTabToolbar autoPrint={print === '1'} parentHref="/forecast/report" parentLabel="Forecasting Report" documentTitle={printTitle} />
      <ForecastReportContent data={data} />
    </ReportPrintFrame>
  );
}
