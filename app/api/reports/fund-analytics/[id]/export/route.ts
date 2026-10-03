import { NextResponse } from 'next/server';
import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { canExportReports } from '@/lib/services/entitlements';
import { getFundAnalyticsReport } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { renderFundAnalyticsReportToPdf } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';

// The Fund analytics report as a PDF. Premium only (canExportReports, explicit 403 with the reason), and the report must be
// the caller's own BEFORE any render token is created. The PDF is streamed back, never stored, and never cached by a shared
// cache (a per-user financial document). The file name carries the as-of date and version, not any personal detail.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad('The report was not found.', 404);
  const supabase = await createClient();
  if (!(await canExportReports(user.id, supabase))) return bad('Exporting the Fund analytics report requires a premium plan. You can still view it on screen.', 403);
  const found = await getFundAnalyticsReport(supabase, user.id, id);
  if (!found) return bad('The report was not found.', 404);
  try {
    const buffer = await renderFundAnalyticsReportToPdf(createAdminClient(), user.id, id);
    const asOf = found.summary.asOfDate.slice(8, 10) + '-' + found.summary.asOfDate.slice(5, 7) + '-' + found.summary.asOfDate.slice(0, 4);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="fund-analytics-report-${asOf}-v${found.summary.versionNumber}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('[fund-analytics] pdf failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'The PDF could not be generated. Try again, or use Print / Save as PDF.' }, { status: 500 });
  }
}
