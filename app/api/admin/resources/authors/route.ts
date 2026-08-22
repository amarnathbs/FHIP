import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles } from '@/lib/resources/permissions';
import { getResourceActiveAuthors } from '@/lib/resources/editor/queries';

// GET /api/admin/resources/authors — active authors for the editor's
// Author/Reviewer/Compliance Reviewer pickers (spec §57/§58). Read-only:
// R1.3 explicitly does not build Author management (spec §4).
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const authors = await getResourceActiveAuthors(supabase);
    return ok(authors);
  } catch (err) {
    console.error('Resources authors list error:', err);
    return bad('Could not load authors.', 500);
  }
}
