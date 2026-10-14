// Planning Benchmarks - upload template download (CSV or XLSX), generated from the ONE schema in
// lib/planning-benchmarks/uploadSchema.ts. Capability `view`. The XLSX Read me also prints the live allowed
// lists (global reference data only, read-only, bounded); the CSV is header and examples only.
//
// Safe export (Admin Standard section 11): server-side generation, header on row 1, the version marker on
// every example row, every cell passed through the formula-injection neutraliser, no comment lines, a
// non-identifying file name, Cache-Control no-store, authorisation checked on this very request (a template
// link does not outlive the caller's access). The example rows name a dataset that does not exist, so an
// unedited template can never be staged.
import { bad } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { guarded } from '@/lib/planning-benchmarks/routeSupport';
import { isUploadKind } from '@/lib/planning-benchmarks/uploadSchema';
import { buildTemplate } from '@/lib/planning-benchmarks/uploadTemplates';
import { loadAllowedValues } from '@/lib/planning-benchmarks/allowedValues';
import { todayIsoUtc } from '@/lib/planning-benchmarks/dates';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (req: Request, { params }: { params: Promise<{ kind: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { kind } = await params;
  if (!isUploadKind(kind)) return bad('Unknown template', 404);
  const format = new URL(req.url).searchParams.get('format') ?? 'csv';
  if (format !== 'csv' && format !== 'xlsx') return bad('format must be csv or xlsx', 422);
  // The Excel Read me carries the CURRENT allowed lists, read now under the caller's session (read-only, global
  // reference data). If they cannot be read the download still works and the sheet says so (never a silent omission).
  const allowed = format === 'xlsx' ? await loadAllowedValues(g.supabase, todayIsoUtc()) : undefined;
  const t = buildTemplate(kind, format, allowed);
  return new Response(t.body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': t.contentType,
      'Content-Disposition': `attachment; filename="${t.fileName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
