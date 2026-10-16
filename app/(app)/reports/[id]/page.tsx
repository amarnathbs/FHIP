import { PageBackLink } from '@/components/navigation/PageBackLink';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getReport, recordAccessEvent } from '@/lib/services/reportsData';
import { loadReportContent } from '@/lib/services/reportContentData';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { ReportActions } from '@/components/reports/ReportActions';

async function ReportDetailPageContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const result = await getReport(user.id, id);
  if (!result) notFound();
  await recordAccessEvent(user.id, id, 'viewed');
  const content = await loadReportContent('en', supabase);

  return (
      <div className="space-y-6">
        <div className="no-print flex items-center justify-end">
          <ReportActions reportId={id} />
        </div>

        {result.report.status === 'failed' && (
          <div className="no-print rounded-card border border-risk bg-red-50 p-4 text-sm text-risk">
            {result.report.failure_message ?? 'Report generation did not complete.'}
          </div>
        )}

        {/* 16-10-2026: a report row with no saved sections used to render as a cover page and nothing else, with no
            explanation. Say so, and point at the one action that fixes it (generating again rebuilds it). */}
        {['ready', 'published'].includes(result.report.status) && result.sections.length === 0 && (
          <div role="alert" className="no-print rounded-card border border-amber-300 bg-amber-50 p-4 text-sm text-ink">
            <p className="font-medium">This report has no saved content.</p>
            <p className="mt-1 text-muted">
              It was not saved completely, so there is nothing to show here. Nothing in your data has changed. Go back to Reports and press Generate report again; this empty version is kept in your history and replaced by a complete one.
            </p>
          </div>
        )}

        {/* Module 11.5 (spec sections 44-45, 98): contextual Explain controls
            are enabled on the INTERACTIVE web report only. The print/PDF route
            (app/(print)/reports/[id]/print/page.tsx) deliberately does not
            pass this, so the generated PDF is unchanged. */}
        <ReportPreview
          report={result.report}
          sections={result.sections}
          currency={result.report.reporting_currency as 'AUD' | 'INR'}
          content={content}
          enableContextualExplain
        />
      </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Reports).
export default function ReportDetailPage(props: Parameters<typeof ReportDetailPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/reports" label="Reports" />
      <ReportDetailPageContent {...props} />
    </>
  );
}
