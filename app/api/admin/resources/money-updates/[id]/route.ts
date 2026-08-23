import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { getMoneyUpdateEditorPost } from '@/lib/resources/money-update/queries';
import { getEditorReferenceData, getResourcePostVersions, isSlugAvailable } from '@/lib/resources/editor/queries';
import { updateMoneyUpdateDraft } from '@/lib/resources/money-update/mutations';
import { validateMoneyUpdateForDraftSave } from '@/lib/resources/money-update/validation';
import { searchSources } from '@/lib/resources/sources/queries';
import type { EditorSavePatch, PostVersionSnapshot } from '@/lib/resources/editor/types';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { id } = await params;
  try {
    const post = await getMoneyUpdateEditorPost(supabase, id);
    if (!post) return bad('Money Update not found.', 404);
    const [reference, versions, sourceOptions] = await Promise.all([getEditorReferenceData(supabase), getResourcePostVersions(supabase, id), searchSources(supabase, '')]);
    return ok({ post, reference, versions, sourceOptions });
  } catch (err) {
    console.error('Resources money update editor load error:', err);
    return bad("We couldn't load this Money Update. Try again.", 500);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to edit Resources content.", 403);

  const { id } = await params;
  try {
    const body = await request.json();
    const patch = body?.patch as EditorSavePatch | undefined;
    const eventDate = typeof body?.eventDate === 'string' && body.eventDate ? body.eventDate : null;
    const affectedAudience = typeof body?.affectedAudience === 'string' ? body.affectedAudience : '';
    const sourceIds: string[] = Array.isArray(body?.sourceIds) ? body.sourceIds : [];
    const categoryIds: string[] = Array.isArray(body?.categoryIds) ? body.categoryIds : [];
    const tagIds: string[] = Array.isArray(body?.tagIds) ? body.tagIds : [];
    const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
    const createVersion = Boolean(body?.createVersion);
    const changeSummary = typeof body?.changeSummary === 'string' ? body.changeSummary : null;
    const versionSnapshot = body?.versionSnapshot as PostVersionSnapshot | undefined;

    if (!patch || !expectedUpdatedAt) return bad('Malformed save request.', 400);

    const draftCheck = validateMoneyUpdateForDraftSave({ title: patch.title ?? '' });
    if (!draftCheck.valid) return Response.json({ error: 'Validation failed.', fields: draftCheck.errors }, { status: 422 });

    if (patch.slug) {
      const available = await isSlugAvailable(supabase, patch.slug, id);
      if (!available) return Response.json({ error: 'That slug is already in use by another Resource.', fields: { slug: 'This slug is already taken.' } }, { status: 422 });
    }

    const outcome = await updateMoneyUpdateDraft(supabase, id, {
      patch,
      eventDate,
      affectedAudience,
      sourceIds,
      categoryIds,
      tagIds,
      expectedUpdatedAt,
      userId: user.id,
      createVersion,
      changeSummary,
      versionSnapshot,
    });

    if (outcome.status === 'not_found') return bad('Money Update not found.', 404);
    if (outcome.status === 'conflict') return Response.json({ error: 'This Money Update was updated by someone else. Reload before saving your changes.' }, { status: 409 });
    return ok(outcome.post);
  } catch (err) {
    console.error('Resources money update save error:', err);
    return bad('Could not save your changes.', 500);
  }
}
