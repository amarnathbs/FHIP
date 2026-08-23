import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery } from '@/lib/resources/permissions';
import { removeRelatedContent } from '@/lib/resources/discovery/relatedAdmin';

// DELETE /api/admin/resources/related/[id] — spec §39.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Related Content.", 403);

  try {
    await removeRelatedContent(supabase, id);
    return ok({ id });
  } catch (err) {
    console.error('Resources related-content delete error:', err);
    return bad('Could not remove this relationship.', 500);
  }
}
