import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles } from '@/lib/resources/permissions';
import { getResourceActiveTags } from '@/lib/resources/editor/queries';

// GET /api/admin/resources/tags — active tags for the editor's Tags
// multi-select (spec §48). Read-only: R1.3 does not build Tag management.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const tags = await getResourceActiveTags(supabase);
    return ok(tags);
  } catch (err) {
    console.error('Resources tags list error:', err);
    return bad('Could not load tags.', 500);
  }
}
