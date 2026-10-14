import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery } from '@/lib/resources/permissions';
import { unlinkVideoFromContent, auditBestEffort } from '@/lib/resources/video/links';
import { logResourceAudit } from '@/lib/resources/admin/auditLog';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// DELETE /api/admin/resources/videos/[id]/links/[linkId] — remove a link
// between this video and a piece of content. The link must really be a link
// TO this video (a video's URL cannot be used to delete another relationship).
// Same capability as linking: canManageDiscovery.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; linkId: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to link videos to content.", 403);

  const { id, linkId } = await params;
  try {
    const result = await unlinkVideoFromContent(supabase, { videoPostId: id, linkId });
    if (!result.ok) return bad(result.error, result.kind === 'not_found' ? 404 : 500);
    await auditBestEffort(() => logResourceAudit(createAdminClient(), {
      entity_type: 'resource_related_content',
      entity_id: result.removed.id,
      action: 'video_unlinked_from_content',
      actor_user_id: user.id,
      before_state: { video_post_id: result.removed.related_post_id, content_post_id: result.removed.source_post_id, relationship_type: result.removed.relationship_type },
    }));
    return ok({ id: linkId });
  } catch (err) {
    console.error('Resources video link delete error:', err);
    return bad('Could not remove this link.', 500);
  }
}
