import { bad, ok } from '@/lib/api';
import { guardBulkImport } from '@/lib/resources/import/access';
import { getRun, getRunRows } from '@/lib/resources/import/staging';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/admin/resources/import/runs/[id] -- one run + its compact row table (no payloads). RLS decides
// visibility: another person's run is a plain 404, never "exists but not yours".
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardBulkImport();
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return bad('Import not found.', 404);
  try {
    const run = await getRun(g.supabase, id);
    if (!run) return bad('Import not found.', 404);
    const rows = await getRunRows(g.supabase, id);
    return ok({ run, rows });
  } catch (err) {
    console.error('Resources import run load error:', err);
    return bad('Could not load this import.', 500);
  }
}
