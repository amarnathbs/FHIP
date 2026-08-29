import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { getVideoEditorPost } from '@/lib/resources/video/queries';
import { getEditorReferenceData, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { updateVideoDraft } from '@/lib/resources/video/mutations';
import { validateForDraftSave, validateCtaAssignment } from '@/lib/resources/editor/validation';
import { validateChapters } from '@/lib/resources/video/youtube';
import type { EditorSavePatch, PostVersionSnapshot } from '@/lib/resources/editor/types';
import type { VideoSideSaveInput } from '@/lib/resources/video/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/videos/[id] — full editor payload, same shape
// convention as R1.3's content/[id] GET (spec §17).
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
    const post = await getVideoEditorPost(supabase, id);
    if (!post) return bad('Video not found.', 404);
    const [reference, versions] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), getResourcePostVersions(supabase, id)]);
    return ok({ post, reference, versions });
  } catch (err) {
    console.error('Resources video editor load error:', err);
    return bad("We couldn't load this Video. Try again.", 500);
  }
}

// PATCH /api/admin/resources/videos/[id] — spec §17-20/§99-101.
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
    const video = body?.video as VideoSideSaveInput | undefined;
    const categoryIds: string[] = Array.isArray(body?.categoryIds) ? body.categoryIds : [];
    const tagIds: string[] = Array.isArray(body?.tagIds) ? body.tagIds : [];
    const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
    const createVersion = Boolean(body?.createVersion);
    const changeSummary = typeof body?.changeSummary === 'string' ? body.changeSummary : null;
    const versionSnapshot = body?.versionSnapshot as PostVersionSnapshot | undefined;

    if (!patch || !video || !expectedUpdatedAt) return bad('Malformed save request.', 400);

    const draftCheck = validateForDraftSave({ title: patch.title ?? '' });
    if (!draftCheck.valid) return Response.json({ error: 'Validation failed.', fields: draftCheck.errors }, { status: 422 });

    const ctaCheck = validateCtaAssignment({ primary_cta_id: patch.primary_cta_id ?? null, secondary_cta_id: patch.secondary_cta_id ?? null });
    if (!ctaCheck.valid) return Response.json({ error: 'Validation failed.', fields: ctaCheck.errors }, { status: 422 });

    const chapterCheck = validateChapters(video.chapters ?? []);
    if (!chapterCheck.valid) return Response.json({ error: 'One or more chapters need attention.', fields: { chapters: 'Fix the highlighted chapters before saving.' }, chapterErrors: chapterCheck.errors }, { status: 422 });

    const outcome = await updateVideoDraft(supabase, id, {
      patch,
      video,
      categoryIds,
      tagIds,
      expectedUpdatedAt,
      userId: user.id,
      createVersion,
      changeSummary,
      versionSnapshot,
    });

    if (outcome.status === 'not_found') return bad('Video not found.', 404);
    if (outcome.status === 'conflict') return Response.json({ error: 'This video was updated by someone else. Reload before saving your changes.' }, { status: 409 });
    return ok(outcome.post);
  } catch (err) {
    console.error('Resources video save error:', err);
    return bad('Could not save your changes.', 500);
  }
}
