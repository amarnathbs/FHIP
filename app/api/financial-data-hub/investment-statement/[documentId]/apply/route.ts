import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { applyAuStatementActivity } from '@/lib/investment-import-bridge/applyAuStatementActivity';
import { applyAuStatementPosition } from '@/lib/investment-import-bridge/applyAuStatementPosition';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';

// POST /api/financial-data-hub/investment-statement/{documentId}/apply
// spec sections 63-65, 108, 121-124. The ONLY route that can change
// canonical Investment Intelligence records. Applies every matched,
// pending activity/position on this statement — each one individually
// atomic and idempotent (see applyAuStatementActivity.ts/
// applyAuStatementPosition.ts headers). A statement that is not yet
// approved, or a row that is not yet matched, is skipped with its own
// per-row reason rather than failing the whole request.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  // PAGINATION (spec section 93): a statement with more than 1000 pending
  // rows would otherwise be silently truncated by PostgREST's row cap,
  // applying only the first 1000 and reporting success — `fetchAllRows`
  // pages past it with a deterministic `id` ordering.
  const supabase = await createClient();
  const [activities, positions] = await Promise.all([
    fetchAllRows(() =>
      supabase.from('fdh_investment_statement_activities').select('id').eq('statement_id', statementId).eq('user_id', user.id).eq('apply_status', 'pending').order('id', { ascending: true }),
    ),
    fetchAllRows(() =>
      supabase.from('fdh_investment_statement_positions').select('id').eq('statement_id', statementId).eq('user_id', user.id).eq('apply_status', 'pending').order('id', { ascending: true }),
    ),
  ]);

  const activityResults = [];
  for (const a of activities) {
    activityResults.push({ id: a.id, result: await applyAuStatementActivity({ userId: user.id, activityId: a.id as string }) });
  }
  const positionResults = [];
  for (const p of positions) {
    positionResults.push({ id: p.id, result: await applyAuStatementPosition({ userId: user.id, positionId: p.id as string }) });
  }

  const appliedCount = activityResults.filter((r) => r.result.ok).length + positionResults.filter((r) => r.result.ok).length;

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'investment_statement_applied',
    actorType: 'user',
    actorId: user.id,
    metadata: { statementId, appliedCount, activitiesAttempted: activityResults.length, positionsAttempted: positionResults.length },
  });

  return ok({
    statement_id: statementId,
    applied_count: appliedCount,
    activities: activityResults.map((r) => ({ id: r.id, ok: r.result.ok, code: r.result.code, canonical_transaction_id: r.result.canonicalTransactionId, error: r.result.error })),
    positions: positionResults.map((r) => ({ id: r.id, ok: r.result.ok, code: r.result.code, canonical_holding_snapshot_id: r.result.canonicalTransactionId, error: r.result.error })),
  });
}
