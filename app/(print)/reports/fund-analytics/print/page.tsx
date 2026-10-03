import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { canViewPremiumReport } from '@/lib/services/entitlements';
import { getFundAnalyticsReport } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { resolveNav2RenderToken } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';

// Bare print view -- no AppShell chrome. Opened two ways: (1) a logged-in Premium user visiting directly to print or preview
// (?id=<report>), or (2) the headless PDF renderer, which has no session and presents a short-lived single-use ?token= tied to
// ONE user and ONE report. In both cases the report is loaded with an explicit user filter, so a token or an id can never open
// another user's report. Anything else is a 404 (or a login redirect when there is no session and no token).
export default async function FundAnalyticsPrintPage({ searchParams }: { searchParams: Promise<{ token?: string; id?: string }> }) {
  const { token, id } = await searchParams;

  if (token) {
    const admin = createAdminClient();
    const resolved = await resolveNav2RenderToken(admin, token);
    if (!resolved) notFound();
    const found = await getFundAnalyticsReport(admin as never, resolved.userId, resolved.reportId);
    if (!found) notFound();
    return (
      <div className="mx-auto max-w-3xl p-6">
        <FundAnalyticsReportView report={found.report} printMode />
      </div>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  if (!id || !(await canViewPremiumReport(user.id, supabase))) notFound();
  const found = await getFundAnalyticsReport(supabase, user.id, id);
  if (!found) notFound();
  return (
    <div className="mx-auto max-w-3xl p-6">
      <FundAnalyticsReportView report={found.report} printMode />
    </div>
  );
}
