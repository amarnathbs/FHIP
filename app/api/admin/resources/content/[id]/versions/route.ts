import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getResourcePostVersions } from '@/lib/resources/editor/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';

// GET /api/admin/resources/content/[id]/versions — read-only revision
// history list (spec §47). Refreshed independently of the main editor load
// after a save/workflow action creates a new version.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  // Admin A0.2 Wave 4 (found while building the authorization register):
  // this route previously checked authentication only, relying entirely on
  // `resource_post_versions`'s own RLS policy ("staff read post versions",
  // migration 0049) to return an empty array to a non-staff caller. RLS
  // does correctly prevent real data disclosure, but Standard §4 requires
  // independent enforcement at the API layer too, not a bare empty result
  // standing in for a clean denial. Low severity (no data was ever
  // actually leaked), fixed as straightforward defence-in-depth.
  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to view revision history.", 403);

  const { id } = await params;
  try {
    const versions = await getResourcePostVersions(supabase, id);
    return ok(versions);
  } catch (err) {
    console.error('Resources versions list error:', err);
    return bad('Could not load revision history.', 500);
  }
}
