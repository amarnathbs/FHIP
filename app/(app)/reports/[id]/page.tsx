import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { getReport, recordAccessEvent } from '@/lib/services/reportsData';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { ReportActions } from '@/components/reports/ReportActions';

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const result = await getReport(user.id, id);
  if (!result) notFound();
  await recordAccessEvent(user.id, id, 'viewed');

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="no-print flex items-center justify-between">
          <Link href="/reports" className="text-xs text-muted hover:underline">
            ← Back to Reports
          </Link>
          <ReportActions reportId={id} />
        </div>

        {result.report.status === 'failed' && (
          <div className="no-print rounded-card border border-risk bg-red-50 p-4 text-sm text-risk">
            {result.report.failure_message ?? 'Report generation did not complete.'}
          </div>
        )}

        <ReportPreview report={result.report} sections={result.sections} currency={result.report.reporting_currency as 'AUD' | 'INR'} />
      </div>
    </AppShell>
  );
}
