import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery } from '@/lib/resources/permissions';
import { reorderRelatedContent } from '@/lib/resources/discovery/relatedAdmin';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// PATCH /api/admin/resources/related/reorder — spec §39. Body: { source_post_id, ordered_ids: string[] } (ordered_ids are resource_related_content row ids, not post ids).
export async function PATCH(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Related Content.", 403);

  const body = await request.json().catch(() => ({}));
  const sourcePostId = typeof body?.source_post_id === 'string' ? body.source_post_id : '';
  const orderedIds = Array.isArray(body?.ordered_ids) ? body.ordered_ids.filter((x: unknown) => typeof x === 'string') : [];
  if (!sourcePostId || orderedIds.length === 0) return bad('source_post_id and ordered_ids are required.', 400);

  try {
    await reorderRelatedContent(supabase, sourcePostId, orderedIds);
    return ok({ ok: true });
  } catch (err) {
    console.error('Resources related-content reorder error:', err);
    return bad('Could not reorder related content.', 500);
  }
}
