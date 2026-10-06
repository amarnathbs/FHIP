// Planning Benchmarks - upload template download (CSV or XLSX), generated from the ONE schema in
// lib/planning-benchmarks/uploadSchema.ts. Capability `view`. No stored data is read.
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

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (req: Request, { params }: { params: Promise<{ kind: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { kind } = await params;
  if (!isUploadKind(kind)) return bad('Unknown template', 404);
  const format = new URL(req.url).searchParams.get('format') ?? 'csv';
  if (format !== 'csv' && format !== 'xlsx') return bad('format must be csv or xlsx', 422);
  const t = buildTemplate(kind, format);
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
