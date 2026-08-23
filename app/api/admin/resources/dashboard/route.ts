import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { getResourceDashboardSummary } from '@/lib/resources/admin/queries';

// GET /api/admin/resources/dashboard — spec §12-17.
//
// Analyst-only callers (spec §11): RLS would technically let a `.count()`
// query run, but it would silently return 0 for every status Analyst can't
// read (drafts/review/scheduled) rather than the true count — indistinguishable
// from "there is genuinely no content in that state." Spec §15 explicitly
// forbids showing counts for records a role shouldn't know exist, so rather
// than risk that misleading "0 drafts" reading, Analyst gets the safe
// placeholder message instead of the operational dashboard. This is a
// deliberate application-level choice on top of RLS, not a workaround for it.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

  if (!current.isSuperAdmin && !isResourceStaff(current)) {
    return ok({ analystPlaceholder: true, summary: null });
  }

  try {
    const summary = await getResourceDashboardSummary(supabase);
    return ok({ analystPlaceholder: false, summary });
  } catch (err) {
    console.error('Resources dashboard error:', err);
    return bad('Could not load the Resources dashboard.', 500);
  }
}
