import { requireAccountDeletionAdmin } from '@/lib/services/accountDeletionAdmin';
import { executeAccountDeletion } from '@/lib/services/accountDeletionOrchestration';
import { adminClient, adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

// LR-9 WP-09/WP-10 — the one route allowed to trigger irreversible account
// deletion. Gated by the separately-named requireAccountDeletionAdmin()
// capability; the actual destructive work lives in
// lib/services/accountDeletionOrchestration.ts, which performs no
// authorization of its own and must never be called from anywhere else.
//
// State machine (WP-07): pending -> processing -> completed | failed. The
// transition to 'processing' is written and read back BEFORE the
// destructive work starts, so a request already mid-processing (e.g. a
// double-click, or a second admin opening the same row) is rejected with a
// clear 409 rather than running the deletion twice.
export const POST = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireAccountDeletionAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;

  const admin = adminClient();

  const { data: claimed, error: claimError } = await admin
    .from('account_deletion_requests')
    .update({ status: 'processing', processing_started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id, user_id')
    .maybeSingle();
  if (claimError) return safeDbError(claimError, 'account-deletions claim');
  if (!claimed) return bad('This request is not pending (already processing, completed, cancelled, or does not exist).', 409);
  if (!claimed.user_id) {
    // Should not be reachable — a pending row always has a user_id (RLS's
    // own insert policy requires it) — but fail closed rather than crash if
    // it ever is.
    await admin.from('account_deletion_requests').update({ status: 'failed', failure_reason: 'Request has no linked user.' }).eq('id', id);
    return bad('This request has no linked user and cannot be executed.', 422);
  }

  const result = await executeAccountDeletion(claimed.user_id);

  const { data: finalRow, error: updateError } = await admin
    .from('account_deletion_requests')
    .update({
      status: result.success ? 'completed' : 'failed',
      processed_at: new Date().toISOString(),
      processed_by: user!.id,
      failure_reason: result.authDeleteError,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (updateError) return safeDbError(updateError, 'account-deletions finalise');

  return ok({ request: finalRow, storageResults: result.storageResults });
});
