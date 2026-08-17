// R1.4 Video mutation layer — spec §16-20, §99-101 (R1.3 conventions carried
// forward). Every function takes the caller's own request-scoped,
// RLS-authenticated client (never service-role). Reuses the R1.3 generic
// post-field save path (updateResourceDraft) rather than reimplementing it —
// see the header comment on updateSpecialistPostExtra in
// lib/resources/specialist/mutations.ts for why the video-specific columns
// are written as a small second call rather than folded into that function.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlainText } from '@/lib/resources/editor/sanitize';
import { updateResourceDraft, type SaveOutcome, type SaveDraftParams } from '@/lib/resources/editor/mutations';
import type { EditorSavePatch } from '@/lib/resources/editor/types';
import type { VideoSideSaveInput } from './types';
import { parseYouTubeVideoId, buildYouTubeThumbnailUrl } from './youtube';

export interface CreateVideoResult {
  id: string;
}

// Video creation (spec §14-16): the *only* required input is a YouTube URL
// or bare video ID. Everything else defaults exactly per spec §16 (draft /
// private / not indexable — FHIP publication is a separate editorial
// decision from the underlying YouTube video already being public).
export async function createVideoDraft(supabase: SupabaseClient, youtubeInput: string, userId: string): Promise<{ ok: true; result: CreateVideoResult } | { ok: false; error: string }> {
  const parsed = parseYouTubeVideoId(youtubeInput);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { data: post, error: postErr } = await supabase
    .from('resource_posts')
    .insert({
      title: 'Untitled Video',
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

  const { error: videoErr } = await supabase.from('resource_videos').insert({
    resource_post_id: post.id,
    youtube_video_id: parsed.videoId,
    youtube_url: parsed.normalizedUrl,
    youtube_channel_handle: '@GKTC',
    youtube_channel_url: 'https://www.youtube.com/@GKTC',
    thumbnail_url: buildYouTubeThumbnailUrl(parsed.videoId),
    chapters: [],
    embed_enabled: true,
  });
  if (videoErr) {
    // Roll back the orphaned post row rather than leaving a video-typed post
    // with no resource_videos row behind (spec §105: "consider a narrow
    // transaction/RPC if needed to prevent partial state" — here the
    // simpler, equally-safe option is a compensating delete, since this is
    // a single all-or-nothing creation step, not a multi-field save).
    await supabase.from('resource_posts').delete().eq('id', post.id);
    return { ok: false, error: 'Could not save this video’s YouTube details.' };
  }

  return { ok: true, result: { id: post.id as string } };
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
