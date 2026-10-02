// Market Index Data - validation-error download for a job.
//
// ADMIN STANDARD SECTION 11 (export): purpose = let the operator fix the file and re-upload;
// authorised role = `view`; server-side generation; column allow-list (row, severity, code,
// column, message, excerpt - the excerpt is a cell of the operator's OWN uploaded index file, no
// personal data); formula-injection protection (buildValidationErrorCsv neutralises = + - @ TAB CR);
// authorisation checked at generation time (there is no stored link); no-store; non-identifying
// file name; every download is a GET under the caller's session.
import { bad } from '@/lib/api';
import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { buildJobErrorCsv } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { csvResponse, guarded, idParam } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const id = await idParam(params);
  if (!id.ok) return id.response;
  try {
    const csv = await buildJobErrorCsv(g.supabase, id.id);
    if (csv === null) return bad('Import job not found', 404);
    return csvResponse(csv, `benchmark-import-${id.id.slice(0, 8)}-validation.csv`);
  } catch (e) {
    return safeDbError(e as { code?: string; message?: string }, 'benchmark import errors');
  }
});
