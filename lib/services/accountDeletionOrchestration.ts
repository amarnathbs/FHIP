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
  /** True when deletion was aborted BEFORE deleteUser was ever called, because
   *  one or more Storage buckets could not be confirmed purged. Lets a caller
   *  distinguish "we tried to delete the identity and Supabase itself
   *  rejected it" from "we deliberately never attempted it". */
  abortedForStorageFailure: boolean;
}

/**
 * Order of operations, and why (NEG-05/NEG-06/NEG-07):
 *
 * 1. Purge all 3 Storage buckets under this user's prefix FIRST. Every
 *    bucket key is userId-prefixed (see accountDeletionStorage.ts's own
 *    header), so this never depends on any database row surviving —
 *    NEG-06's exact concern ("auth deleted before cleanup loses ownership
 *    path") cannot arise here regardless of order.
 *
 * 2. Call supabase.auth.admin.deleteUser(userId) ONLY IF every bucket purged
 *    cleanly. This is the single statement that cascades all ~132 of this
 *    user's other owned tables — migrations 0111 and 0130 already proved
 *    this cascade live on real synthetic DEV users and fixed the one
 *    trigger-ordering defect found (a G5B write-permission trigger firing
 *    mid-cascade after user_profiles was already gone) — so this function
 *    does not, and must not, issue 134 individual application-level
 *    DELETEs; doing so would be building a second, parallel, unproven
 *    deletion path alongside one this schema already certifies (NEG-05
 *    "partial delete leaves financial rows" is exactly the risk a
 *    hand-rolled per-table loop would reintroduce).
 *
 * CORRECTED INVARIANT (2026-09-10, PO review — supersedes the original
 * design below this line): a Storage-purge failure now ABORTS the deletion
 * entirely — the auth identity and all financial rows are left intact, and
 * the request is reported as failed/retryable, never as completed. The
 * original design let deleteUser proceed regardless of storage errors,
 * reasoning that an orphaned Storage object (no owner left to attribute it
 * to) was a smaller, independently-discoverable problem than leaving a
 * user's financial data undeleted. That reasoning is REJECTED going
 * forward: an orphaned file with no owner is invisible and undiscoverable
 * once the account is gone, whereas an intact, undeleted account is
 * visible and safely retryable. See
 * docs/live-recovery/LR9_STORAGE_DELETION_INVARIANT_FIX.md for the full
 * before/after record — do not re-loosen this without an equally explicit
 * PO decision.
 */
export async function executeAccountDeletion(userId: string): Promise<AccountDeletionResult> {
  const storageResults = await purgeAllUserStorage(userId);

  const storageFailures = storageResults.filter((r) => r.error);
  if (storageFailures.length > 0) {
    const bucketList = storageFailures.map((r) => r.bucket).join(', ');
    return {
      success: false,
      storageResults,
      authDeleteError: `Deletion aborted: Storage purge failed for ${bucketList}. No identity or financial data was deleted -- retry once the storage issue is resolved.`,
      abortedForStorageFailure: true,
    };
  }

  const admin = createAdminClient();
  const { error: authError } = await admin.auth.admin.deleteUser(userId);

  return {
    success: !authError,
    storageResults,
    authDeleteError: authError?.message ?? null,
    abortedForStorageFailure: false,
  };
}
