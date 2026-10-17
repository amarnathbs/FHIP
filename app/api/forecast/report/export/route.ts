import { NextResponse } from 'next/server';
import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { canExportReports } from '@/lib/services/entitlements';
import { newCorrelationId, typedError } from '@/lib/services/reportApiResponses';
import { classifyRenderFailure, REPORT_EXPORT_FAILURES, ReportExportError } from '@/lib/services/reportExportFailure';

// Streams the rendered PDF straight back — unlike the Free/Premium report's
// export route (app/api/reports/[id]/exports/route.ts), there's no
// report_exports row or Supabase Storage upload here, since the
// Consolidated Forecasting Report isn't a saved/versioned report; it's
// always rendered live from current forecast data, so persisting a copy
// would only ever go stale.
//
// LR-8 WP-09/NEG-02 (2026-09-08) — this route never checked entitlement at
// all before this fix: any authenticated, country-confirmed user (Free or
// Premium) could download this PDF, while the sibling Monthly/Premium
// report's own PDF export (app/api/reports/[id]/exports/route.ts) has
// always required canExportReports(). A real, live "premium route
// accessible free" gap, closed here with the identical check.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  if (!(await canExportReports(user.id, supabase))) {
    return bad('Exporting the Consolidated Forecasting Report requires a premium plan. You can still view it in Forecasting.', 403);
  }

  const scenario = new URL(req.url).searchParams.get('scenario') ?? undefined;

  // 17-10-2026: the renderer (and `playwright` with it) is loaded on demand, inside this try, never at route load. A
  // server that cannot load it used to fail the whole route with the platform's bare "Internal Server Error".
  const correlationId = newCorrelationId();
  try {
    const { renderForecastReportToPdf } = await import('@/lib/services/forecastReportPdfRenderer').catch((e) => {
      throw new ReportExportError('renderer_unavailable', `renderer module could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
    });
    const buffer = await renderForecastReportToPdf(user.id, scenario);
    // LR-8 WP-07 — the filename was a static literal for every user/scenario/
    // period ("consolidated-forecasting-report.pdf"), genuinely collision-
    // prone if saved side-by-side on a device despite scenario being a real
    // parameter. This report has no persisted period of its own (always
    // rendered live), so today's date is the honest period label rather than
    // implying a saved historical snapshot that doesn't exist.
    const dateLabel = new Date().toISOString().slice(0, 10);
    const scenarioLabel = (scenario ?? 'base').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const fileName = `consolidated-forecast-report-${scenarioLabel}-${dateLabel}.pdf`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        // LR-8 WP-07/NEG-07 — a per-user financial PDF must never be cached
        // by a shared/intermediate cache.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    // Typed JSON with a reference; the underlying message goes to the server log only. `error` stays the user sentence
    // the client already displays.
    const step = classifyRenderFailure(err);
    const spec = REPORT_EXPORT_FAILURES[step];
    console.error('[forecast-report] pdf render failed', { correlationId, step, message: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return typedError(spec.status, spec.code, spec.message, correlationId, spec.retryable, step);
  }
}
