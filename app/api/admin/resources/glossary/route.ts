import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { parseContentListFilters } from '@/lib/resources/admin/filters';
import { getGlossaryList } from '@/lib/resources/glossary/queries';
import { createGlossaryDraft } from '@/lib/resources/glossary/mutations';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/glossary — list (spec §25).
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  // Phase A Wave 1: narrowed from the former coarse `!current.isSuperAdmin &&
  // current.roles.length === 0` check, which any single Resources role
  // cleared — including Analyst, who then received a misleading RLS-filtered
  // 200 instead of an honest denial (Admin Architecture Standard §4). Same
  // message and status code; only the predicate narrows.
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const { searchParams } = new URL(request.url);
    const filters = parseContentListFilters(searchParams);
    const result = await getGlossaryList(supabase, filters);
    return ok(result);
  } catch (err) {
    console.error('Resources glossary list error:', err);
    return bad("We couldn't load Glossary definitions. Try again.", 500);
  }
}

// POST /api/admin/resources/glossary — create-and-redirect (spec §26), same
// pattern as R1.3's New Content chooser. Duplicate-term protection (spec
// §29) happens here as a warning surfaced to the client, not a hard block —
// a brand-new draft has no title yet ("Untitled Glossary Term"), so the
// duplicate check that matters happens on save, not creation (see
// glossary/[id]/route.ts PATCH).
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canCreateSpecialistContent(current)) return bad("You don't have permission to create a glossary definition.", 403);

  try {
    const { id } = await createGlossaryDraft(supabase, user.id);
    return ok({ id });
  } catch (err) {
    console.error('Resources glossary create error:', err);
    return bad('Could not create this glossary definition.', 500);
  }
}
