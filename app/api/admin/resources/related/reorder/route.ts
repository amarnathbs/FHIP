import { createClient } from '@/lib/supabase/server';
import { adminClient } from '@/lib/services/adminAuth';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery } from '@/lib/resources/permissions';
import { reorderRelatedContent, MAX_RELATED_REORDER_ITEMS } from '@/lib/resources/discovery/relatedAdmin';

// PATCH /api/admin/resources/related/reorder — spec §39.
// Body: { source_post_id: string, ordered_ids: string[] }
//   ordered_ids are resource_related_content ROW ids (not post ids), and are
//   the COMPLETE ordered set of that source's existing links — every link
//   exactly once. See migration 0116 for the full contract.
//
// Admin A0.2 Wave 2 (Scope A). Previously this route called a Promise.all of
// independent UPDATEs and reported HTTP 500 for every failure mode, including
// ones that had already partially committed. It now validates the request
// shape, then delegates to public.admin_reorder_related_content — one
// transaction, complete-set validation, per-source locking — and maps that
// function's deliberate SQLSTATEs onto distinct, safe responses so the client
// can tell an invalid payload from a stale set from a server fault:
//
//   400  the request body itself is malformed (not JSON, wrong types)
//   403  the caller lacks canManageDiscovery
//   404  the source Resource does not exist
//   409  the link set changed since the client loaded it — refresh and retry
//   422  the payload is well-formed but not a valid complete ordered set
//   500  unexpected server fault (never carries a raw SQL error)
//
// Success returns the ordering that was actually COMMITTED, read back from
// the database by the RPC, so the client can never be told "saved" about an
// ordering that does not exist.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Related Content.", 403);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('A valid request body is required.', 400);

  const sourcePostId = typeof body.source_post_id === 'string' ? body.source_post_id.trim() : '';
  if (!sourcePostId) return bad('source_post_id is required.', 400);
  if (!UUID_RE.test(sourcePostId)) return bad('source_post_id must be a valid id.', 400);

  if (!Array.isArray(body.ordered_ids)) return bad('ordered_ids must be an array of relationship ids.', 400);
  const orderedIds: unknown[] = body.ordered_ids;

  if (orderedIds.length === 0) return bad('ordered_ids must contain at least one relationship id.', 422);
  if (orderedIds.length > MAX_RELATED_REORDER_ITEMS) {
    return bad(`Too many related items in one request (maximum ${MAX_RELATED_REORDER_ITEMS}).`, 422);
  }
  if (!orderedIds.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))) {
    return bad('ordered_ids must contain only valid relationship ids.', 422);
  }
  if (new Set(orderedIds as string[]).size !== orderedIds.length) {
    return bad('ordered_ids contains a duplicate relationship id.', 422);
  }

  try {
    // service-role client: admin_reorder_related_content is granted to
    // service_role only. The caller's authority was established above.
    const result = await reorderRelatedContent(adminClient(), sourcePostId, orderedIds as string[]);
    if (result.ok) return ok(result.data);

    switch (result.kind) {
      case 'invalid':
        return bad(result.message, 422);
      case 'not_found':
        return bad('Resource not found.', 404);
      case 'conflict':
        return bad('The related items for this Resource have changed since this list was loaded. Refresh and try again.', 409);
      default:
        return bad('Could not reorder related content.', 500);
    }
  } catch (err) {
    console.error('Resources related-content reorder error:', err);
    return bad('Could not reorder related content.', 500);
  }
}
