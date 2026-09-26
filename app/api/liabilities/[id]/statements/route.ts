import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { loadLiabilityStatementHistory } from '@/lib/import-bridge/liabilityStatementHistory';
import {
  LIABILITY_IMPORT_OWNERS,
  recordLiabilityStatementLedger,
  statusForLiabilityApplyError,
} from '@/lib/import-bridge/applyLiabilityProposalAtomic';
import { ReadModelUnavailableError } from '@/lib/read-models/core/types';

// GET /api/liabilities/{id}/statements — WP-11 (G7). The imported statements
// behind one liability and what every line became (ledger row, loan split,
// bank settlement), so imported evidence stays visible after Apply.
// Read-only; RLS-scoped client, and every query is also filtered by user_id.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const history = await loadLiabilityStatementHistory(await createClient(), user.id, id);
    if (!history) return bad('Liability not found.', 404);
    return ok(history);
  } catch (e) {
    if (e instanceof ReadModelUnavailableError) return bad('Statement history is unavailable right now.', 503);
    throw e;
  }
}

const recordSchema = z.object({
  statement_id: z.string().uuid(),
  owner: z.enum(LIABILITY_IMPORT_OWNERS).optional(),
  acknowledge_unclassified: z.boolean().optional(),
});

// POST /api/liabilities/{id}/statements — record the activity of a statement
// that was applied to (or kept against) THIS liability before the ledger Apply
// existed (fdh10_record_liability_statement_ledger, migration 0209). The
// statement must be one this liability's history lists as recordable.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = recordSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('Invalid request body.', 422);

  let history;
  try {
    history = await loadLiabilityStatementHistory(await createClient(), user.id, id);
  } catch (e) {
    if (e instanceof ReadModelUnavailableError) return bad('Statement history is unavailable right now.', 503);
    throw e;
  }
  if (!history) return bad('Liability not found.', 404);
  const statement = history.statements.find((s) => s.id === parsed.data.statement_id);
  if (!statement) return bad('That statement is not part of this liability.', 404);
  if (!statement.can_record) return bad("This statement's activity has already been recorded or rejected.", 409);

  const result = await recordLiabilityStatementLedger({
    statementId: statement.id,
    owner: parsed.data.owner,
    acknowledgeUnclassified: parsed.data.acknowledge_unclassified,
  });
  if (!result.ok) {
    return Response.json({ error: result.error, code: result.code, blockers: result.blockers }, { status: statusForLiabilityApplyError(result.code) });
  }
  return ok({ outcome: 'recorded', ledger: result.ledger });
}
