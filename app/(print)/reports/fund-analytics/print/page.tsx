import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { canViewPremiumReport } from '@/lib/services/entitlements';
import { getFundAnalyticsReport } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
// the browser-free token module: this page must load on a server that has no headless browser (never import fundAnalyticsPdfRenderer here)
import { resolveNav2RenderToken } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import FundAnalyticsCombinedPrintDocument from '@/components/reports/FundAnalyticsCombinedPrintDocument';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { parsePagePlan } from '@/lib/config/nav2/printLayout';
import { isKnownTimeZone } from '@/lib/engines/date';
import { FUND_ANALYTICS_TITLE_FALLBACK, fundAnalyticsPrintTitle } from '@/lib/reports/fundAnalyticsPrintTitle';
import { combinedPrintTitle, parseCombinedIds } from '@/lib/reports/fundAnalyticsCombinedPrint';
import type { Metadata } from 'next';

// The page title is the default file name of "Save as PDF" and the text in the browser's header line: it names the report (as-at month in words and
// version, lib/reports/fundAnalyticsPrintTitle.ts). Only the person's own path (?id=) reads the report for it; the headless renderer's single-use ?token=
// is NOT used here (reading it would spend it before the page renders), and that path has its own header, so it keeps the plain name.
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ token?: string; id?: string; ids?: string | string[] }> }): Promise<Metadata> {
  const { token, id, ids } = await searchParams;
  const fallback: Metadata = { title: { absolute: FUND_ANALYTICS_TITLE_FALLBACK } };
  if (token || (!id && ids === undefined)) return fallback;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !(await canViewPremiumReport(user.id, supabase))) return fallback;
    if (ids !== undefined) {
      // the combined document: named for all of its reports ("... - Versions 4 and 5"); any id that is not the person's own gives the plain name (the page itself answers 404)
      const own = await getOwnReports(supabase, user.id, parseCombinedIds(ids));
      return own ? { title: { absolute: combinedPrintTitle(own.map((o) => ({ asOfDate: o.report.asOfDate, versionNumber: o.summary.versionNumber }))) } } : fallback;
    }
    if (!id) return fallback;
    const found = await getFundAnalyticsReport(supabase, user.id, id);
    return found ? { title: { absolute: fundAnalyticsPrintTitle(found.report.asOfDate, found.summary.versionNumber) } } : fallback;
  } catch {
    return fallback;
  }
}

type OwnReport = NonNullable<Awaited<ReturnType<typeof getFundAnalyticsReport>>>;

/**
 * The person's OWN reports for a combined print, in the order of the address; null when ANY id is refused (not a valid id, repeated parameter, more than the
 * cap, or a report that is not this user's / does not exist). Every report is read with the explicit user filter of getFundAnalyticsReport, so a foreign id
 * returns nothing, and a refusal never says which id was the problem.
 */
async function getOwnReports(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, ids: string[] | null): Promise<OwnReport[] | null> {
  if (!ids) return null;
  const found = await Promise.all(ids.map((rid) => getFundAnalyticsReport(supabase, userId, rid)));
  return found.every((f): f is OwnReport => f !== null) ? (found as OwnReport[]) : null;
}

// Bare print view -- no AppShell chrome. Opened two ways: (1) a logged-in Premium user visiting directly to print or preview
// (?id=<report>), or (2) the headless PDF renderer, which has no session and presents a short-lived single-use ?token= tied to
// ONE user and ONE report. In both cases the report is loaded with an explicit user filter, so a token or an id can never open
// another user's report. Anything else is a 404 (or a login redirect when there is no session and no token).
// The person's own path is the free browser print flow (PO decision 18-10-2026): the page opens in its own tab from OpenPrintTabLink with
// print=1, PrintTabToolbar opens the print dialog once and closes the tab afterwards (lib/reports/printTab.ts). The token path (headless
// renderer) shows no toolbar. A bare print page has no back link by design (see the back-link guard allow-list).
export default async function FundAnalyticsPrintPage({ searchParams }: { searchParams: Promise<{ token?: string; id?: string; ids?: string | string[]; plan?: string; print?: string; tz?: string }> }) {
  const { token, id, ids, plan, print, tz } = await searchParams;
  // the viewer's time zone, from the screen that opened this tab: the printed "made" time then matches the screen (a server has no zone of its own)
  const timeZone = isKnownTimeZone(tz) ? tz : null;
  const pagesPerFund = parsePagePlan(plan);

  if (token) {
    const admin = createAdminClient();
    const resolved = await resolveNav2RenderToken(admin, token);
    if (!resolved) notFound();
    const found = await getFundAnalyticsReport(admin as never, resolved.userId, resolved.reportId);
    if (!found) notFound();
    return (
      <FundAnalyticsPrintDocument report={found.report} version={{ versionNumber: found.summary.versionNumber, createdAt: found.summary.createdAt }} pagesPerFund={pagesPerFund} serverRender />
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  if (ids !== undefined) {
    // SEVERAL of the person's own reports as one document (one print job = one PDF). Premium, ownership and the cap are checked before anything is read or shown.
    if (!(await canViewPremiumReport(user.id, supabase))) notFound();
    const own = await getOwnReports(supabase, user.id, parseCombinedIds(ids));
    if (!own) notFound();
    const title = combinedPrintTitle(own.map((o) => ({ asOfDate: o.report.asOfDate, versionNumber: o.summary.versionNumber })));
    return (
      <>
        <PrintTabToolbar autoPrint={print === '1'} parentHref="/reports/fund-analytics" parentLabel="Fund Analytics" documentTitle={title} />
        <FundAnalyticsCombinedPrintDocument
          parts={own.map((o) => ({ report: o.report, version: { versionNumber: o.summary.versionNumber, createdAt: o.summary.createdAt } }))}
          pagesPerFund={pagesPerFund}
          timeZone={timeZone}
        />
      </>
    );
  }
  if (!id || !(await canViewPremiumReport(user.id, supabase))) notFound();
  const found = await getFundAnalyticsReport(supabase, user.id, id);
  if (!found) notFound();
  return (
    <>
      <PrintTabToolbar autoPrint={print === '1'} parentHref="/reports/fund-analytics" parentLabel="Fund Analytics" />
      <FundAnalyticsPrintDocument report={found.report} version={{ versionNumber: found.summary.versionNumber, createdAt: found.summary.createdAt }} pagesPerFund={pagesPerFund} timeZone={timeZone} />
    </>
  );
}
