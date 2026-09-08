import { requireAccountDeletionAdmin } from '@/lib/services/accountDeletionAdmin';
import { adminClient, adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

const QUEUE_STATUS_GROUPS: Record<string, string[]> = {
  pending: ['pending'],
  processing: ['processing'],
  completed: ['completed'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

// LR-9 WP-08 — Admin deletion queue, gated by the separately-named
// requireAccountDeletionAdmin() capability (not bare requireAdmin()). Mirrors
// the Resources content queue's own `?queue=` preset pattern
// (app/api/admin/resources/content/route.ts) — the closest existing
// structural precedent for a status-grouped Admin review queue in this
// codebase.
//
// WP-08's own lock: "required minimal identity/status, without exposing
// unnecessary financial data" — this returns only email (looked up live via
// auth.admin.getUserById, never persisted on this table — see migration
// 0132's own header) plus the request's own status/timestamps/reason. No
// financial table is ever joined here.
export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAccountDeletionAdmin();
  if (forbidden) return forbidden;

  const url = new URL(req.url);
  const queue = url.searchParams.get('queue') ?? 'pending';
  const statuses = QUEUE_STATUS_GROUPS[queue];
  if (!statuses) return bad(`Unknown queue "${queue}"`, 422);

  const admin = adminClient();
  const { data, error } = await admin
    .from('account_deletion_requests')
    .select('*')
    .in('status', statuses)
    .order('requested_at', { ascending: true });
  if (error) return safeDbError(error, 'account-deletions queue list');

  // Live identity lookup, bounded to exactly the rows returned — a
  // completed/cancelled row whose user_id is already null (migration 0132's
  // "on delete set null" tombstone) simply has no email to show, which is
  // itself the correct, honest signal that the account no longer exists.
  const withIdentity = await Promise.all(
    (data ?? []).map(async (row) => {
      if (!row.user_id) return { ...row, email: null };
      const { data: userRes } = await admin.auth.admin.getUserById(row.user_id);
      return { ...row, email: userRes?.user?.email ?? null };
    })
  );

  return ok(withIdentity);
});
