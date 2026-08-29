import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles } from '@/lib/resources/permissions';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/categories — active categories for the filter
// dropdown (spec §28: "Primary Category from active categories").
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const categories = await getResourceCategoriesForFilter(supabase);
    return ok(categories);
  } catch (err) {
    console.error('Resources categories error:', err);
    return bad('Could not load categories.', 500);
  }
}
