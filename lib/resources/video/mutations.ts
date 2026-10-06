// R1.4 Video mutation layer — spec §16-20, §99-101 (R1.3 conventions carried
// forward). Every function takes the caller's own request-scoped,
// RLS-authenticated client (never service-role). Reuses the R1.3 generic
// post-field save path (updateResourceDraft) rather than reimplementing it —
// see the header comment on updateSpecialistPostExtra in
// lib/resources/specialist/mutations.ts for why the video-specific columns
// are written as a small second call rather than folded into that function.
//
// The one deliberate exception is the narrow orphan clean-up in
// removeOrphanVideoPost below (it accepts an optional service-role client).

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlainText } from '@/lib/resources/editor/sanitize';
import { updateResourceDraft, type SaveOutcome, type SaveDraftParams } from '@/lib/resources/editor/mutations';
import type { EditorSavePatch } from '@/lib/resources/editor/types';
import type { VideoSideSaveInput } from './types';
import { parseYouTubeVideoId, buildYouTubeThumbnailUrl } from './youtube';

export interface CreateVideoResult {
  id: string;
}

export const UNTITLED_VIDEO_TITLE = 'Untitled Video';

// Video creation (spec §14-16): the *only* required input is a YouTube URL
// or bare video ID. Everything else defaults exactly per spec §16 (draft /
// private / not indexable — FHIP publication is a separate editorial
// decision from the underlying YouTube video already being public).
//
// PO review F12 (06/10/2026) — root cause of orphan video posts created
// through THIS path. The two inserts (post, then resource_videos row) are not
// one transaction. When the second failed, the old compensating
// `delete().eq('id', post.id)` ran under the caller's RLS, where only
// MANAGERS may delete resource_posts ("managers delete posts"). For an Author
// or Editor PostgREST deletes ZERO rows and returns NO error, and the result
// was never inspected — so the video-typed post stayed behind with no video
// row (an "Untitled Video" that the editor then refused to open). Fixed here
// without a migration:
//   1. one retry of the second insert (a transient failure is the common case);
//   2. if a video row turns out to exist after all, the creation SUCCEEDED
//      (lost response) and is reported as such, never rolled back;
//   3. the compensating delete is VERIFIED (rows actually removed). If the
//      caller's own client cannot remove it (non-manager), the server's
//      service-role client removes exactly that one row, and only while it is
//      still the untouched draft this function just created (id + created_by +
//      content_type + status + title) and has no video row — never anything else;
//   4. if even that fails, the caller is told honestly that a draft was left
//      behind, and the repair form on the video edit page finishes it.
// A single SECURITY DEFINER RPC doing both inserts would make this fully
// atomic; it is not essential now that the leftover case is closed and
// repairable, so no migration is added (see the F12 report).
export async function createVideoDraft(
  supabase: SupabaseClient,
  youtubeInput: string,
  userId: string,
  admin?: SupabaseClient
): Promise<{ ok: true; result: CreateVideoResult } | { ok: false; error: string }> {
  const parsed = parseYouTubeVideoId(youtubeInput);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { data: post, error: postErr } = await supabase
    .from('resource_posts')
    .insert({
      title: UNTITLED_VIDEO_TITLE,
      content_type: 'video',
      status: 'draft',
      compliance_classification: 'green',
      jurisdiction: 'global',
      freshness_type: 'evergreen',
      visibility: 'private',
      is_indexable: false,
      content_blocks: [],
      created_by: userId,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (postErr) return { ok: false, error: 'Could not create the video record.' };
  const postId = post.id as string;

  const insertVideoRow = () =>
    supabase.from('resource_videos').insert({
      resource_post_id: postId,
      youtube_video_id: parsed.videoId,
      youtube_url: parsed.normalizedUrl,
      youtube_channel_handle: '@GKTC',
      youtube_channel_url: 'https://www.youtube.com/@GKTC',
      thumbnail_url: buildYouTubeThumbnailUrl(parsed.videoId),
      chapters: [],
      embed_enabled: true,
    });

  let { error: videoErr } = await insertVideoRow();
  if (videoErr) ({ error: videoErr } = await insertVideoRow());
  if (!videoErr) return { ok: true, result: { id: postId } };

  // Lost-response case: the row may be there even though the call errored.
  const { data: landed } = await supabase.from('resource_videos').select('id').eq('resource_post_id', postId).maybeSingle();
  if (landed) return { ok: true, result: { id: postId } };

  const removed = await removeOrphanVideoPost(supabase, admin, postId, userId);
  if (removed) return { ok: false, error: 'Could not save this video’s YouTube details.' };
  console.error('Resources video create: orphan video post left behind (compensating delete failed):', postId);
  return {
    ok: false,
    error: 'Could not save this video’s YouTube details, and the draft could not be cleaned up. Open the newest "Untitled Video" in the Videos list and use "Add the YouTube details" to finish it.',
  };
}

// Returns true only when the orphan post is verifiably gone.
export async function removeOrphanVideoPost(supabase: SupabaseClient, admin: SupabaseClient | undefined, postId: string, userId: string): Promise<boolean> {
  // Caller's own client first. `.select('id')` is what makes a zero-row
  // (RLS-filtered) delete visible; without it that case looks like success.
  const own = await supabase.from('resource_posts').delete().eq('id', postId).select('id');
  if (!own.error && (own.data ?? []).length > 0) return true;
  if (!admin) return false;

  // Never remove a post that has (gained) a video row.
  const { data: vid, error: vidErr } = await admin.from('resource_videos').select('id').eq('resource_post_id', postId).maybeSingle();
  if (vidErr || vid) return false;

  const scoped = await admin
    .from('resource_posts')
    .delete()
    .eq('id', postId)
    .eq('created_by', userId)
    .eq('content_type', 'video')
    .eq('status', 'draft')
    .eq('title', UNTITLED_VIDEO_TITLE)
    .select('id');
  return !scoped.error && (scoped.data ?? []).length > 0;
}

export interface SaveVideoParams {
  patch: EditorSavePatch;
  video: VideoSideSaveInput;
  categoryIds: string[];
  tagIds: string[];
  expectedUpdatedAt: string;
  userId: string;
  createVersion?: boolean;
  changeSummary?: string | null;
  versionSnapshot?: SaveDraftParams['versionSnapshot'];
}

// Saves the common resource_posts fields via the existing R1.3 path, then
// the video-specific resource_videos columns via a second, narrowly-scoped
// update. youtube_video_id/youtube_url are deliberately never written here
// (spec §61: content-identity lock — the linked video cannot be silently
// swapped by editing metadata).
export async function updateVideoDraft(supabase: SupabaseClient, postId: string, params: SaveVideoParams): Promise<SaveOutcome> {
  const outcome = await updateResourceDraft(supabase, postId, {
    patch: params.patch,
    categoryIds: params.categoryIds,
    tagIds: params.tagIds,
    expectedUpdatedAt: params.expectedUpdatedAt,
    userId: params.userId,
    createVersion: params.createVersion,
    changeSummary: params.changeSummary,
    versionSnapshot: params.versionSnapshot,
  });
  if (outcome.status !== 'ok') return outcome;

  const { error: videoErr } = await supabase
    .from('resource_videos')
    .update({
      duration_seconds: params.video.duration_seconds,
      thumbnail_url: params.video.thumbnail_url,
      youtube_published_at: params.video.youtube_published_at,
      transcript: sanitizePlainText(params.video.transcript, 200000),
      chapters: params.video.chapters,
      embed_enabled: params.video.embed_enabled,
      youtube_channel_handle: sanitizePlainText(params.video.youtube_channel_handle, 100) || '@GKTC',
      youtube_channel_url: params.video.youtube_channel_url,
      updated_at: new Date().toISOString(),
    })
    .eq('resource_post_id', postId);
  if (videoErr) throw videoErr;

  return outcome;
}
