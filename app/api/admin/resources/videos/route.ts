import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { parseContentListFilters } from '@/lib/resources/admin/filters';
import { getVideoList } from '@/lib/resources/video/queries';
import { createVideoDraft } from '@/lib/resources/video/mutations';

// GET /api/admin/resources/videos — list (spec §13). Same RLS-scoped-client
// convention as every other Resources Admin list route (R1.2/R1.3): a
// caller with no Resources role never reaches a Resources table query.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const { searchParams } = new URL(request.url);
    const filters = parseContentListFilters(searchParams);
    const result = await getVideoList(supabase, filters);
    return ok(result);
  } catch (err) {
    console.error('Resources video list error:', err);
    return bad("We couldn't load Videos. Try again.", 500);
  }
}

// POST /api/admin/resources/videos { youtubeInput: string } — spec §14-16.
// Creation roles match R1.3's stricter CREATE_ROLES set (spec §70): Resource
// Admin, Author, Editor, Super Admin only — never Analyst, never Publisher.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canCreateSpecialistContent(current)) return bad("You don't have permission to add a video.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const youtubeInput = typeof body?.youtubeInput === 'string' ? body.youtubeInput : '';
    const result = await createVideoDraft(supabase, youtubeInput, user.id);
    if (!result.ok) return bad(result.error, 422);
    return ok(result.result);
  } catch (err) {
    console.error('Resources video create error:', err);
    return bad('Could not create this video.', 500);
  }
}
