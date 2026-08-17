import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles } from '@/lib/resources/permissions';
import { getResourceActiveCTAs } from '@/lib/resources/editor/queries';

// GET /api/admin/resources/ctas — active CTAs for the editor's Primary/
// Secondary CTA pickers (spec §61). Read-only: R1.3 does not build CTA
// Library management.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const ctas = await getResourceActiveCTAs(supabase);
    return ok(ctas);
  } catch (err) {
    console.error('Resources CTAs list error:', err);
    return bad('Could not load CTAs.', 500);
  }
}
