import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { repairMissingVideoRow } from '@/lib/resources/video/repair';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// POST /api/admin/resources/videos/[id]/repair { youtubeInput }
//
// PO review F12: creates the missing resource_videos row for an EXISTING
// video-typed post from a real YouTube URL / ID (see lib/resources/video/
// repair.ts for the full contract: refuses if a row already exists, atomic,
// audited, never changes the post itself).
//
// Capability: the same set that may ADD a video (canCreateSpecialistContent:
// Resource Admin, Author, Editor, Super Admin). Repairing a video record
// is the same act as supplying its YouTube identity at creation, so it is not
// widened to Publisher / Compliance Reviewer / Analyst. The database layer
// ("staff manage videos" on resource_videos) is the second boundary.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canCreateSpecialistContent(current)) return bad("You don't have permission to add YouTube details to a video.", 403);

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const result = await repairMissingVideoRow(supabase, createAdminClient(), { postId: id, youtubeInput: body?.youtubeInput, actorUserId: user.id });
    if (!result.ok) {
      const status = result.kind === 'invalid' ? 422 : result.kind === 'not_found' ? 404 : result.kind === 'already_has_video' ? 409 : result.kind === 'forbidden' ? 403 : 500;
      return bad(result.error, status);
    }
    return ok({ id, youtube_video_id: result.youtubeVideoId, youtube_url: result.youtubeUrl });
  } catch (err) {
    console.error('Resources video repair error:', err);
    return bad('Could not save the YouTube details.', 500);
  }
}
