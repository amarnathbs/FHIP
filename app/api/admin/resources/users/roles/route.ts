import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageResources } from '@/lib/resources/permissions';
import { assignResourceRole, removeResourceRole, RESOURCE_ROLES } from '@/lib/resources/admin/userRoles';
import type { ResourceRole } from '@/lib/resources/types';

// Assign/remove Resources roles (spec §9/§10/§27). Resource Admin / Super
// Admin only — this is the *entire* self-escalation defence for this
// feature: an Author/Editor/Compliance Reviewer/Publisher/Analyst calling
// this endpoint gets a 403 before any role read/write happens, so they can
// never grant themselves or anyone else a role no matter what payload they
// send (spec §9: "author cannot assign self resource_admin", etc.). The
// underlying resource_user_roles table also grants zero direct
// insert/update/delete to `authenticated` (see 0033's grants section) — this
// route's use of the service-role client is the *only* legitimate write path
// even for an authorised Resource Admin, mirroring every other privileged
// admin route in this codebase (lib/services/adminAuth.ts's adminClient()).
async function authorize(): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: bad('unauthenticated', 401) };

  const current = await getCurrentResourceRoles();
  if (!canManageResources(current)) return { ok: false, res: bad("You don't have permission to manage Resources users and roles.", 403) };
  return { ok: true, userId: user.id };
}

function parseBody(body: unknown): { targetUserId: string; role: ResourceRole } | null {
  const b = body as Record<string, unknown>;
  const targetUserId = typeof b?.userId === 'string' ? b.userId : '';
  const role = typeof b?.role === 'string' ? b.role : '';
  if (!targetUserId) return null;
  if (!RESOURCE_ROLES.includes(role as ResourceRole)) return null;
  return { targetUserId, role: role as ResourceRole };
}

export async function POST(request: Request) {
  const auth = await authorize();
  if (!auth.ok) return auth.res;

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = parseBody(body);
    if (!parsed) return bad('A valid user and Resources role are required.', 422);

    const admin = createAdminClient();
    const result = await assignResourceRole(admin, { targetUserId: parsed.targetUserId, role: parsed.role, actorUserId: auth.userId });
    if (!result.ok) return bad(result.error ?? 'Could not assign this role.', 422);
    return ok({ assigned: true });
  } catch (err) {
    console.error('Resources role assign error:', err);
    return bad('Could not assign this role.', 500);
  }
}

export async function DELETE(request: Request) {
  const auth = await authorize();
  if (!auth.ok) return auth.res;

  try {
    const body = await request.json().catch(() => ({}));
    const parsed = parseBody(body);
    if (!parsed) return bad('A valid user and Resources role are required.', 422);

    const admin = createAdminClient();
    const result = await removeResourceRole(admin, { targetUserId: parsed.targetUserId, role: parsed.role, actorUserId: auth.userId });
    if (!result.ok) return bad(result.error ?? 'Could not remove this role.', 422);
    return ok({ removed: true });
  } catch (err) {
    console.error('Resources role remove error:', err);
    return bad('Could not remove this role.', 500);
  }
}
