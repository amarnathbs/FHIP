import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery, isResourceStaff } from '@/lib/resources/permissions';
import { listContentLinkedToVideo, linkVideoToContent, auditBestEffort } from '@/lib/resources/video/links';
import { logResourceAudit } from '@/lib/resources/admin/auditLog';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// PO review F12 — link a video to content using the EXISTING relationship
// model (resource_related_content; see lib/resources/video/links.ts).
//
// Capabilities: listing needs Resources staff (same gate as the Related
// Content screen); linking needs canManageDiscovery (Resource Admin, Editor,
// Super Admin — the existing rule for Related Content). A caller who lacks it
// gets an explicit 403, never an empty 200 (Admin standard §4).

// GET /api/admin/resources/videos/[id]/links — the content this video is linked to.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  const { id } = await params;
  try {
    const items = await listContentLinkedToVideo(supabase, id);
    return ok({ items, canManage: canManageDiscovery(current) });
  } catch (err) {
    console.error('Resources video links list error:', err);
    return bad('Could not load the content this video is linked to.', 500);
  }
}

// POST /api/admin/resources/videos/[id]/links { content_post_id }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to link videos to content.", 403);

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const contentPostId = typeof body?.content_post_id === 'string' ? body.content_post_id : '';
    const result = await linkVideoToContent(supabase, { videoPostId: id, contentPostId });
    if (!result.ok) {
      const status = result.kind === 'not_found' ? 404 : result.kind === 'duplicate' ? 409 : result.kind === 'invalid' ? 422 : 500;
      return bad(result.error, status);
    }
    await auditBestEffort(() => logResourceAudit(createAdminClient(), {
      entity_type: 'resource_related_content',
      entity_id: result.id,
      action: 'video_linked_to_content',
      actor_user_id: user.id,
      after_state: { video_post_id: result.video.id, content_post_id: result.content.id, relationship_type: 'related' },
      metadata: { video_title: result.video.title, content_title: result.content.title, content_type: result.content.content_type },
    }));
    return ok({ id: result.id });
  } catch (err) {
    console.error('Resources video link create error:', err);
    return bad('Could not link this video.', 500);
  }
}
