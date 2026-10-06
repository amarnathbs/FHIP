// Planning Benchmarks - the ALLOWED VALUES lists (datasets, metrics with units, cohorts, closed lists).
//   GET ?format=json (default)  the lists for the Upload tab's collapsible "Allowed values" panel
//   GET ?format=csv             the companion "Allowed values (CSV)" download (a CSV has no Read me sheet)
//
// ADMIN ARCHITECTURE STANDARD - applicability, stated:
//   Capability : `view` (upload OR activate), the same read gate as the upload history and the templates. No new
//                capability, no migration, no new privileged path (section 14).
//   Four layers: API - requireAdmin() then the capability guard, before anything is read (401 / 403 / 503);
//                page / nav - the panel renders only inside the capability-gated Upload tab; database - plain
//                world-readable reference tables (RLS select using (true), migration 0011), read under the
//                CALLER'S session client. The service-role client is not imported here.
//   Section 8/13: a read that fails is state 'unavailable' with the same wording the Read me uses, never an
//                empty list that looks complete. The CSV says so too.
//   Section 9    : global reference data only. No user data, no identifiers.
//   Section 11   : server-side generation, every CSV cell formula-neutralised, non-identifying file name,
//                Cache-Control no-store, authorisation checked on this very request.
import { bad, ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded } from '@/lib/planning-benchmarks/routeSupport';
import { loadAllowedValues } from '@/lib/planning-benchmarks/allowedValues';
import { todayIsoUtc } from '@/lib/planning-benchmarks/dates';
import { ALLOWED_VALUES_CSV_NAME, buildAllowedValuesCsv } from '@/lib/planning-benchmarks/uploadTemplates';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (req: Request) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const format = new URL(req.url).searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') return bad('format must be json or csv', 422);
  const allowed = await loadAllowedValues(g.supabase, todayIsoUtc());
  if (format === 'csv') {
    return new Response(buildAllowedValuesCsv(allowed), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ALLOWED_VALUES_CSV_NAME}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  const res = ok(allowed);
  res.headers.set('Cache-Control', 'no-store');
  return res;
});
