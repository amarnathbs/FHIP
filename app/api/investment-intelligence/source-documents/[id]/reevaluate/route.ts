import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { recertifyPosition } from '@/lib/services/investment-intelligence/documentProcessing';
import { admitStatementJob } from '@/lib/services/investment-intelligence/statementJob/admission';
import { acceptedJobResponse, isUnavailable } from '@/lib/services/investment-intelligence/statementJob/routeHelpers';
import { listStatementPositions } from '@/lib/services/investment-intelligence/statementPipeline';

// Document2 (4) WP-B (F7) -- "Re-evaluate all positions" / "Rebuild from retained structured data".
//
// Re-runs the certification decision for every position this statement produced, from what is retained in the database (holding
// snapshots, transactions, owners, open cases). It never reads the raw statement file, so it works after the file has been deleted. It
// changes no holding or transaction; only each position's Portfolio Truth status is recomputed.
//
// WP-J: for a statement with many positions this is minutes of work, so it is a background JOB (kind `reevaluate`), admitted here and
// advanced in short slices by the browser (POST /api/investment-intelligence/statement-jobs/{job_id}/advance) and the scheduled backstop.
// Answers 202 with the job, or 200 with the result at once when there is nothing to do. Where the job tables are not there yet (migration
// 0313 not applied) the earlier one-request behaviour is used.
export const maxDuration = 30;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: doc } = await supabase.from('ii_source_documents').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!doc) return bad('Statement not found.', 404);

  const admin = createAdminClient();
  let positions: Array<[string, string]>;
  try {
    positions = await listStatementPositions(admin, user.id, id);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not read the positions of this statement.', 500);
  }
  if (positions.length === 0) return ok({ evaluated: 0, failed: 0, message: 'No positions were recorded for this statement, so there is nothing to re-evaluate.' });

  try {
    const admitted = await admitStatementJob({ userId: user.id, documentId: id, kind: 'reevaluate' });
    if (admitted.kind === 'job') return acceptedJobResponse(admitted.job, { resumed: admitted.resumed, positions: positions.length });
    if (admitted.kind === 'answer' && !admitted.result.ok) return bad(admitted.result.error ?? 'Statement not found.', admitted.result.status === 'not_found' ? 404 : 409);
  } catch (e) {
    if (!isUnavailable(e)) throw e;
    // Migration 0313 is not applied here: the earlier synchronous behaviour.
    let evaluated = 0;
    let failed = 0;
    for (const [accountId, instrumentId] of positions) {
      const r = await recertifyPosition(user.id, accountId, instrumentId);
      if (r.ok) evaluated += 1;
      else failed += 1;
    }
    return ok({ evaluated, failed });
  }
  return bad('The re-evaluation could not be started.', 500);
}
