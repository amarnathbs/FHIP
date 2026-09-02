import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery } from '@/lib/resources/permissions';
import { removeRelatedContent } from '@/lib/resources/discovery/relatedAdmin';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// DELETE /api/admin/resources/related/[id] — spec §39.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Related Content.", 403);

  try {
    // Admin A0.2 Wave 4 (PO4-4 / DEF4-10): the canonical single-resource
    // DELETE contract — first successful deletion returns 200 (the
    // existing compatible shape); an unknown/already-gone id returns 404,
    // never a false 200. No audit event exists for this route (none was
    // required before this Wave and none is added now, matching scope), so
    // there is no risk of an audit record claiming a deletion that never
    // happened — only the response itself needed correcting.
    const { deleted } = await removeRelatedContent(supabase, id);
    if (!deleted) return bad('This relationship no longer exists.', 404);
    return ok({ id });
  } catch (err) {
    console.error('Resources related-content delete error:', err);
    return bad('Could not remove this relationship.', 500);
  }
}
