import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';

// GET /api/admin/resources/categories — active categories for the filter
// dropdown (spec §28: "Primary Category from active categories").
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  // Phase A Wave 1: narrowed from the former coarse `!current.isSuperAdmin &&
  // current.roles.length === 0` check, which any single Resources role
  // cleared — including Analyst, who then received a misleading RLS-filtered
  // 200 instead of an honest denial (Admin Architecture Standard §4). Same
  // message and status code; only the predicate narrows.
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const categories = await getResourceCategoriesForFilter(supabase);
    return ok(categories);
  } catch (err) {
    console.error('Resources categories error:', err);
    return bad('Could not load categories.', 500);
  }
}
