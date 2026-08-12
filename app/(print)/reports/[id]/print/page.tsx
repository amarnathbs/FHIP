import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getReport, getReportByRenderToken } from '@/lib/services/reportsData';
import { loadReportContent } from '@/lib/services/reportContentData';
import { ReportPreview } from '@/components/reports/ReportPreview';

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
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;

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

  return (
    <div className="mx-auto max-w-3xl p-6">
      <ReportPreview
        report={result.report}
        sections={result.sections}
        currency={result.report.reporting_currency as 'AUD' | 'INR'}
        content={content}
      />
    </div>
  );
}
