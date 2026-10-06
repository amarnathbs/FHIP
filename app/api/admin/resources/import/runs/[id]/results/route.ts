import { bad } from '@/lib/api';
import { guardBulkImport } from '@/lib/resources/import/access';
import { buildResultsCsv, resultsFileName } from '@/lib/resources/import/results-csv';
import { getRun, getRunRows, issuesOfRun } from '@/lib/resources/import/staging';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/admin/resources/import/runs/[id]/results -- downloadable validation results CSV
// (row, field, error_code, message). Generated on the server, formula-injection neutralised, and
// authorised AT DOWNLOAD TIME: capability + RLS ownership are re-checked on every request.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardBulkImport();
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return bad('Import not found.', 404);
  try {
    const run = await getRun(g.supabase, id);
    if (!run) return bad('Import not found.', 404);
    const rows = await getRunRows(g.supabase, id);
    const csv = buildResultsCsv(issuesOfRun(run, rows));
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${resultsFileName(run.content_type, run.id)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('Resources import results error:', err);
    return bad('Could not build the results file.', 500);
  }
}
