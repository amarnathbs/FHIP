import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { canViewPremiumReport } from '@/lib/services/entitlements';
import { getFundAnalyticsReport } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
// the browser-free token module: this page must load on a server that has no headless browser (never import fundAnalyticsPdfRenderer here)
import { resolveNav2RenderToken } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { parsePagePlan } from '@/lib/config/nav2/printLayout';

// Bare print view -- no AppShell chrome. Opened two ways: (1) a logged-in Premium user visiting directly to print or preview
// (?id=<report>), or (2) the headless PDF renderer, which has no session and presents a short-lived single-use ?token= tied to
// ONE user and ONE report. In both cases the report is loaded with an explicit user filter, so a token or an id can never open
// another user's report. Anything else is a 404 (or a login redirect when there is no session and no token).
// The person's own path is the free browser print flow (PO decision 18-10-2026): the page opens in its own tab from OpenPrintTabLink with
// print=1, PrintTabToolbar opens the print dialog once and closes the tab afterwards (lib/reports/printTab.ts). The token path (headless
// renderer) shows no toolbar. A bare print page has no back link by design (see the back-link guard allow-list).
export default async function FundAnalyticsPrintPage({ searchParams }: { searchParams: Promise<{ token?: string; id?: string; plan?: string; print?: string }> }) {
  const { token, id, plan, print } = await searchParams;
  const pagesPerFund = parsePagePlan(plan);

  if (token) {
    const admin = createAdminClient();
    const resolved = await resolveNav2RenderToken(admin, token);
    if (!resolved) notFound();
    const found = await getFundAnalyticsReport(admin as never, resolved.userId, resolved.reportId);
    if (!found) notFound();
    return (
      <FundAnalyticsPrintDocument report={found.report} version={{ versionNumber: found.summary.versionNumber, createdAt: found.summary.createdAt }} pagesPerFund={pagesPerFund} />
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
    <>
      <PrintTabToolbar autoPrint={print === '1'} parentHref="/reports/fund-analytics" parentLabel="Fund Analytics" />
      <FundAnalyticsPrintDocument report={found.report} version={{ versionNumber: found.summary.versionNumber, createdAt: found.summary.createdAt }} pagesPerFund={pagesPerFund} />
    </>
  );
}
