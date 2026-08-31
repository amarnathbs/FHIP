import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { getResourceEditorPost, getEditorReferenceData, getResourcePostVersions, isSlugAvailable } from '@/lib/resources/editor/queries';
import { updateResourceDraft } from '@/lib/resources/editor/mutations';
import { validateForDraftSave, validateCtaAssignment } from '@/lib/resources/editor/validation';
import type { EditorSavePatch, PostVersionSnapshot } from '@/lib/resources/editor/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/content/[id] — full editor payload: the post
// (including content_blocks — spec §129, one post's worth, not the whole
// table), reference-data pickers, and revision history in one round trip.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { id } = await params;
  try {
    const post = await getResourceEditorPost(supabase, id);
    // Spec §96: RLS-denied and genuinely-nonexistent both resolve to the
    // same generic 404 — never confirm "this draft exists but you can't see it".
    if (!post) return bad('Resource not found.', 404);

    const [reference, versions] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), getResourcePostVersions(supabase, id)]);
    return ok({ post, reference, versions });
  } catch (err) {
    console.error('Resources editor load error:', err);
    return bad('Could not load this Resource for editing.', 500);
  }
}

// PATCH /api/admin/resources/content/[id]
// Body: { patch: EditorSavePatch, categoryIds: string[], tagIds: string[],
//         expectedUpdatedAt: string, createVersion?: boolean, changeSummary?: string }
//
// Ordinary content-field save (spec §35/§40/§99) — never status or an
// approval column (see lib/resources/editor/mutations.ts header; those
// columns aren't reachable through this path even if a client sent them,
// since updateResourceDraft() only ever writes the fixed EditorSavePatch
// column list).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to edit Resources content.", 403);

  const { id } = await params;
  try {
    const body = await request.json();
    const patch = body?.patch as EditorSavePatch | undefined;
    const categoryIds: string[] = Array.isArray(body?.categoryIds) ? body.categoryIds : [];
    const tagIds: string[] = Array.isArray(body?.tagIds) ? body.tagIds : [];
    const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
    const createVersion = Boolean(body?.createVersion);
    const changeSummary = typeof body?.changeSummary === 'string' ? body.changeSummary : null;
    const versionSnapshot = body?.versionSnapshot as PostVersionSnapshot | undefined;

    if (!patch || !expectedUpdatedAt) return bad('Malformed save request.', 400);

    // Draft-save validation only (spec §36) — stronger validation happens at
    // the workflow-submission step, not here. This just stops obviously-bad
    // input (e.g. an oversized title) rather than silently truncating it (spec §17).
    const draftCheck = validateForDraftSave({ title: patch.title ?? '' });
    if (!draftCheck.valid) return Response.json({ error: 'Validation failed.', fields: draftCheck.errors }, { status: 422 });

    const ctaCheck = validateCtaAssignment({ primary_cta_id: patch.primary_cta_id ?? null, secondary_cta_id: patch.secondary_cta_id ?? null });
    if (!ctaCheck.valid) return Response.json({ error: 'Validation failed.', fields: ctaCheck.errors }, { status: 422 });

    if (patch.slug) {
      const available = await isSlugAvailable(supabase, patch.slug, id);
      if (!available) return Response.json({ error: 'That slug is already in use by another Resource.', fields: { slug: 'This slug is already taken.' } }, { status: 422 });
    }

    const outcome = await updateResourceDraft(supabase, id, {
      patch,
      categoryIds,
      tagIds,
      expectedUpdatedAt,
      userId: user.id,
      createVersion,
      changeSummary,
      versionSnapshot,
    });

    if (outcome.status === 'not_found') return bad('Resource not found.', 404);
    if (outcome.status === 'conflict') {
      // Spec §41 — never silently overwrite a concurrent edit.
      return Response.json({ error: 'This Resource was updated by someone else. Reload before saving your changes.' }, { status: 409 });
    }
    return ok(outcome.post);
  } catch (err) {
    console.error('Resources editor save error:', err);
    return bad('Could not save your changes.', 500);
  }
}
