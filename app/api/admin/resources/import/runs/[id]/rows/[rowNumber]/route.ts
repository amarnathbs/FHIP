import { bad, ok } from '@/lib/api';
import { guardBulkImport } from '@/lib/resources/import/access';
import { getRowDetail, getRun } from '@/lib/resources/import/staging';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/admin/resources/import/runs/[id]/rows/[rowNumber] -- the expandable detail of ONE row (the staged
// normalised payload). Loaded on demand so the row table never carries 500 full article bodies.
// After a run is applied the payload is cleared and this returns an explanatory empty detail.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; rowNumber: string }> }) {
  const g = await guardBulkImport();
  if (!g.ok) return g.response;
  const { id, rowNumber } = await params;
  const n = Number.parseInt(rowNumber, 10);
  if (!UUID_RE.test(id) || !Number.isInteger(n) || n < 1) return bad('Row not found.', 404);
  try {
    const run = await getRun(g.supabase, id);
    if (!run) return bad('Import not found.', 404);
    const row = await getRowDetail(g.supabase, id, n);
    if (!row) return bad('Row not found.', 404);
    return ok({ row, payloadCleared: run.status === 'applied' });
  } catch (err) {
    console.error('Resources import row load error:', err);
    return bad('Could not load this row.', 500);
  }
}
