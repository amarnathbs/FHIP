import { NextResponse } from 'next/server';
import { requireCountryConfirmedUser as requireUser } from '@/lib/api';
import { renderForecastReportToPdf } from '@/lib/services/forecastReportPdfRenderer';

// Streams the rendered PDF straight back — unlike the Free/Premium report's
// export route (app/api/reports/[id]/exports/route.ts), there's no
// report_exports row or Supabase Storage upload here, since the
// Consolidated Forecasting Report isn't a saved/versioned report; it's
// always rendered live from current forecast data, so persisting a copy
// would only ever go stale.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const scenario = new URL(req.url).searchParams.get('scenario') ?? undefined;

  try {
    const buffer = await renderForecastReportToPdf(user.id, scenario);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="consolidated-forecasting-report.pdf"',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PDF rendering failed';
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 500 });
  }
}
