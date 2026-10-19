import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getReport, getReportByRenderToken } from '@/lib/services/reportsData';
import { loadReportContent } from '@/lib/services/reportContentData';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { ReportPrintFrame } from '@/components/reports/ReportPrintFrame';
import { localeForReportingCurrency } from '@/lib/engines/money';
import { PrintDocumentTitle } from '@/components/reports/PrintDocumentTitle';
import { reportPrintTitle } from '@/lib/reports/printDocumentTitle';

// The saved PDF's default file name is this page's title (Chrome uses <title>). This is the static fallback served before the report is loaded;
// the report's own name, month and version are set by <PrintDocumentTitle> and PrintTabToolbar (lib/reports/printDocumentTitle.ts), never the
// generic title, which made every saved PDF the same name.
export const metadata = { title: 'FHIP Report' };

// Bare print view — no AppShell chrome, no nav, no action buttons. Opened
// two ways: (1) a logged-in user visiting directly to manually print/preview
// (normal session auth), or (2) the headless PDF renderer
// (lib/services/reportPdfRenderer.ts), which has no session and instead
// presents a short-lived ?token= tied to this exact report_id.
export default async function ReportPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string; print?: string }>;
}) {
  const { id } = await params;
  const { token, print } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const result = user ? await getReport(user.id, id) : token ? await getReportByRenderToken(id, token) : null;
  if (!result) {
    if (!user) redirect('/login');
    notFound();
  }
  const content = await loadReportContent('en', supabase);
  const currency = result.report.reporting_currency as 'AUD' | 'INR';
  // The running header of the printed pages: the report's name and its month (a month name, never a numeric date).
  const month = new Date(result.report.report_month).toLocaleDateString(localeForReportingCurrency(currency), { month: 'long', year: 'numeric' });

  const printTitle = reportPrintTitle({
    reportTypeCode: result.report.report_type_code,
    reportMonth: result.report.report_month,
    asOfDate: result.report.as_of_date,
    versionNumber: result.report.version_number,
    currency,
  });

  return (
    <ReportPrintFrame identity={`Household Financial Health Report - ${month}`} serverRender={Boolean(token)}>
      <PrintDocumentTitle title={printTitle} />
      {/* A person (session) gets the shared print-tab toolbar (print, close this tab); the headless PDF renderer (token) never does,
          and the toolbar is hidden in print anyway, so the PDF is unchanged. */}
      {user && !token ? <PrintTabToolbar autoPrint={print === '1'} parentHref={`/reports/${id}`} parentLabel="Report" documentTitle={printTitle} /> : null}
      <ReportPreview
        report={result.report}
        sections={result.sections}
        currency={currency}
        content={content}
      />
    </ReportPrintFrame>
  );
}
