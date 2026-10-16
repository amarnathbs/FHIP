import { bad, ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { guardBulkImport } from '@/lib/resources/import/access';
import { applyRun } from '@/lib/resources/import/staging';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/resources/import/runs/[id]/apply -- Apply is a SEPARATE request from the preview and carries NO
// body: the browser sends only the run id, never content. Authority is the server-staged rows. The work is one
// database transaction (public.apply_resource_content_import): all rows or none. Every resulting item is a
// PRIVATE DRAFT; nothing is approved, scheduled or published.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardBulkImport();
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return bad('Import not found.', 404);
  try {
    const result = await applyRun(g.supabase, createAdminClient(), id, g.user.id);
    if (!result.ok) return Response.json({ error: result.message, code: result.code }, { status: result.status });
    return ok({ runId: result.runId, created: result.created, alreadyApplied: result.alreadyApplied, postIds: result.postIds, dbMs: result.dbMs });
  } catch (err) {
    console.error('Resources import apply error:', err);
    return Response.json({ error: 'The import could not be completed. Nothing was created.', code: 'APPLY_FAILED' }, { status: 500 });
  }
}
