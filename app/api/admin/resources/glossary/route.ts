import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { parseContentListFilters } from '@/lib/resources/admin/filters';
import { getGlossaryList } from '@/lib/resources/glossary/queries';
import { createGlossaryDraft } from '@/lib/resources/glossary/mutations';
import { validateForDraftSave } from '@/lib/resources/editor/validation';
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

// POST /api/admin/resources/glossary { title } — PO review F3 (06/10/2026): called
// only when the author presses Save in the editor, with the term they typed.
// Opening the New Glossary Definition screen creates nothing, and a request
// without a real title is refused (no 'Untitled' drafts). Originally this was
// create-and-redirect (spec §26), same pattern as R1.3's New Content chooser. Duplicate-term protection (spec
// §29) happens here as a warning surfaced to the client, not a hard block —
// a brand-new draft has no title yet ("Untitled Glossary Term"), so the
// duplicate check that matters happens on save, not creation (see
// glossary/[id]/route.ts PATCH).
export async function POST(request: Request) {
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
    const body = await request.json().catch(() => ({}));
    const rawTitle = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!rawTitle) return Response.json({ error: 'Enter the term before saving.', fields: { title: 'The term is required to save.' } }, { status: 422 });
    const titleCheck = validateForDraftSave({ title: rawTitle });
    if (!titleCheck.valid) return Response.json({ error: 'Validation failed.', fields: titleCheck.errors }, { status: 422 });

    const { id, updated_at } = await createGlossaryDraft(supabase, user.id, rawTitle);
    return ok({ id, updated_at });
  } catch (err) {
    console.error('Resources glossary create error:', err);
    return bad('Could not create this glossary definition.', 500);
  }
}
