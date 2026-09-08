// LR-9 WP-09/WP-10 — the actual, irreversible account-deletion execution.
// Called ONLY from app/api/admin/account-deletions/[id]/execute/route.ts,
// which gates on requireAccountDeletionAdmin() before this ever runs. This
// module performs no authorization of its own — see that route's own
// header for why the split is deliberate (a destructive orchestration
// function should never be reachable by anything that forgot to check).
import { createAdminClient } from '@/lib/supabase/admin';
import { purgeAllUserStorage, type StoragePurgeResult } from '@/lib/services/accountDeletionStorage';

export interface AccountDeletionResult {
  success: boolean;
  storageResults: StoragePurgeResult[];
  authDeleteError: string | null;
}

/**
 * Order of operations, and why (NEG-05/NEG-06/NEG-07):
 *
 * 1. Purge all 3 Storage buckets under this user's prefix FIRST. Every
 *    bucket key is userId-prefixed (see accountDeletionStorage.ts's own
 *    header), so this never depends on any database row surviving —
 *    NEG-06's exact concern ("auth deleted before cleanup loses ownership
 *    path") cannot arise here regardless of order, but doing it first means
 *    a partial failure leaves the account (and its financial rows) still
 *    intact and the failure visible/retryable, rather than an orphaned
 *    Storage object outliving an already-gone, unrecoverable account.
 *
 * 2. Call supabase.auth.admin.deleteUser(userId) LAST. This is the single
 *    statement that cascades all ~132 of this user's other owned tables —
 *    migrations 0111 and 0130 already proved this cascade live on real
 *    synthetic DEV users and fixed the one trigger-ordering defect found
 *    (a G5B write-permission trigger firing mid-cascade after user_profiles
 *    was already gone) — so this function does not, and must not, issue
 *    134 individual application-level DELETEs; doing so would be building
 *    a second, parallel, unproven deletion path alongside one this schema
 *    already certifies (NEG-05 "partial delete leaves financial rows" is
 *    exactly the risk a hand-rolled per-table loop would reintroduce).
 *
 * Storage failures are recorded but do NOT block step 2 by default — an
 * orphaned Storage object with no owner left to attribute it to is a real
 * but bounded and independently discoverable residue (the same orphan-
 * report class of tooling FDH-3 already has); refusing to delete the
 * ACCOUNT because one Storage bucket call failed would leave the user's
 * financial data undeleted over a much smaller, separately-fixable problem.
 * This tradeoff is disclosed, not hidden — storageResults is always
 * returned in full so the caller (and the deletion-request row) can record
 * exactly what happened.
 */
export async function executeAccountDeletion(userId: string): Promise<AccountDeletionResult> {
  const storageResults = await purgeAllUserStorage(userId);

  const admin = createAdminClient();
  const { error: authError } = await admin.auth.admin.deleteUser(userId);

  return {
    success: !authError,
    storageResults,
    authDeleteError: authError?.message ?? null,
  };
}
