import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageResources } from '@/lib/resources/permissions';
import { listResourceUsers } from '@/lib/resources/admin/userRoles';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/users — Users & Roles admin list (spec §6).
// Resource Admin / Super Admin only: this reads across every FHIP user via
// the service-role client (auth.users, resource_user_roles for other users)
// which must never be reachable by an ordinary Resources staff role (spec
// §9: only resource_admin/Super Admin may see or change role assignments).
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageResources(current)) return bad("You don't have permission to manage Resources users and roles.", 403);

  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') ?? '').slice(0, 200);
    const admin = createAdminClient();
    const items = await listResourceUsers(admin, { search: q || undefined });
    return ok({ items, currentUserId: current.userId });
  } catch (err) {
    console.error('Resources users list error:', err);
    return bad('Could not load Resources users.', 500);
  }
}
