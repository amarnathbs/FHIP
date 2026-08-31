import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { getGlossaryEditorPost, getGlossaryTermOptions, findExactDuplicateGlossaryTerm } from '@/lib/resources/glossary/queries';
import { getEditorReferenceData, getResourcePostVersions, isSlugAvailable } from '@/lib/resources/editor/queries';
import { updateGlossaryDraft } from '@/lib/resources/glossary/mutations';
import { validateGlossaryForDraftSave } from '@/lib/resources/glossary/validation';
import { validateCtaAssignment } from '@/lib/resources/editor/validation';
import type { EditorSavePatch, PostVersionSnapshot } from '@/lib/resources/editor/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

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
    const post = await getGlossaryEditorPost(supabase, id);
    if (!post) return bad('Glossary definition not found.', 404);
    const [reference, versions, termOptions] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), getResourcePostVersions(supabase, id), getGlossaryTermOptions(supabase, id)]);
    return ok({ post, reference, versions, termOptions });
  } catch (err) {
    console.error('Resources glossary editor load error:', err);
    return bad("We couldn't load this glossary definition. Try again.", 500);
  }
}

// PATCH — spec §26-31/§99-101. Runs the spec §29 duplicate-term check
// (case-insensitive, excluding this record itself) before saving: a hard
// reject on an exact case-insensitive match to a *different* term (never
// silently merges), a soft warning is left to the client-side check-as-you
// type flow via GET .../similar.
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
    const aliases: string[] = Array.isArray(body?.aliases) ? body.aliases.filter((a: unknown) => typeof a === 'string') : [];
    const relatedTermIds: string[] = Array.isArray(body?.relatedTermIds) ? body.relatedTermIds : [];
    const categoryIds: string[] = Array.isArray(body?.categoryIds) ? body.categoryIds : [];
    const tagIds: string[] = Array.isArray(body?.tagIds) ? body.tagIds : [];
    const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
    const createVersion = Boolean(body?.createVersion);
    const changeSummary = typeof body?.changeSummary === 'string' ? body.changeSummary : null;
    const versionSnapshot = body?.versionSnapshot as PostVersionSnapshot | undefined;

    if (!patch || !expectedUpdatedAt) return bad('Malformed save request.', 400);

    const draftCheck = validateGlossaryForDraftSave({ title: patch.title ?? '' });
    if (!draftCheck.valid) return Response.json({ error: 'Validation failed.', fields: draftCheck.errors }, { status: 422 });

    const ctaCheck = validateCtaAssignment({ primary_cta_id: patch.primary_cta_id ?? null, secondary_cta_id: patch.secondary_cta_id ?? null });
    if (!ctaCheck.valid) return Response.json({ error: 'Validation failed.', fields: ctaCheck.errors }, { status: 422 });

    // Exact (case-insensitive) duplicate term reject (spec §29: "Prevent
    // duplicate term ... Do not silently merge definitions"). A near-match
    // (e.g. different capitalisation of a different word) is surfaced as a
    // warning by the client's own /similar check, not blocked here.
    //
    // R1.4 closure-pass fix (P2, found live-testing the Responsive Matrix
    // Completion Pass): this check must run BEFORE the slug-availability
    // check below, not after. The editor auto-derives an untouched slug
    // deterministically from the title (see GlossaryEditor.tsx's
    // `slugify(title)`), so an exact-duplicate title always produces an
    // exact-duplicate auto-slug too — meaning the slug check below always
    // fired first and masked the intended, friendlier "A glossary term with
    // this name already exists" message behind a generic, confusing "That
    // slug is already in use" one in the single most common real-world
    // trigger of this rule (typing the same term title verbatim). The save
    // was still correctly blocked either way — this fixes the message, not
    // a security/data-integrity gap.
    if (patch.title?.trim()) {
      const exactMatch = await findExactDuplicateGlossaryTerm(supabase, patch.title.trim(), id);
      if (exactMatch) {
        return Response.json({ error: 'A glossary term with this name already exists.', fields: { title: 'A glossary term with this exact name already exists.' } }, { status: 422 });
      }
    }

    if (patch.slug) {
      const available = await isSlugAvailable(supabase, patch.slug, id);
      if (!available) return Response.json({ error: 'That slug is already in use by another Resource.', fields: { slug: 'This slug is already taken.' } }, { status: 422 });
    }

    const outcome = await updateGlossaryDraft(supabase, id, {
      patch,
      aliases,
      relatedTermIds,
      categoryIds,
      tagIds,
      expectedUpdatedAt,
      userId: user.id,
      createVersion,
      changeSummary,
      versionSnapshot,
    });

    if (outcome.status === 'not_found') return bad('Glossary definition not found.', 404);
    if (outcome.status === 'conflict') return Response.json({ error: 'This glossary definition was updated by someone else. Reload before saving your changes.' }, { status: 409 });
    return ok(outcome.post);
  } catch (err) {
    console.error('Resources glossary save error:', err);
    return bad('Could not save your changes.', 500);
  }
}
