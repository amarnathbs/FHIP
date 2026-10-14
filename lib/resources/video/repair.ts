// PO review F12 (06/10/2026) — safe repair for a video-typed Resource whose
// resource_videos row is missing.
//
// WHY THESE RECORDS EXIST (investigated, see the report): the R1.7/R1.7C
// content import deliberately created the 20 planned video SCRIPTS (VID-001 to
// VID-020) as resource_posts with content_type = 'video' and NO
// resource_videos row, because the source workbook contains no real YouTube
// ID for any of them and the table's youtube_video_id / youtube_url columns
// are NOT NULL (an invented ID would have been fabricated data; see
// scripts/resources/p0-content/load-p0-content.ts and the R1.7D closure
// report). The video editor then met "post without video row" and dead-ended.
// A second, smaller source is createVideoDraft's old compensating delete (see
// mutations.ts).
//
// WHAT THIS DOES: given the real YouTube URL / ID, it creates the one missing
// resource_videos row for that EXISTING post, with the same defaults a fresh
// "Add @GKTC Video" would use. It is deliberately narrow:
//
//   - input is validated by parseYouTubeVideoId (no outbound request);
//   - the post must exist, be content_type 'video', and have NO video row.
//     If a row exists the repair REFUSES, always — including when the same ID
//     is submitted — so it can never swap the video of a healthy record
//     (content identity is locked once created, spec §61);
//   - it is a single INSERT, so it is atomic; resource_videos is UNIQUE on
//     resource_post_id, so two concurrent repairs cannot both win — the loser
//     gets the same "already has details" refusal. Repeating a successful
//     repair therefore changes nothing (idempotent);
//   - it writes with the CALLER's request-scoped client, so the table's RLS
//     ("staff manage videos") stays the boundary; it never touches
//     resource_posts, status, workflow or content blocks;
//   - it writes an audit row (resource_audit_log, via the shared writer and
//     the service-role client, because that table has no authenticated INSERT
//     policy). The audit write is best-effort; it cannot undo the repair.

import type { SupabaseClient } from '@supabase/supabase-js';
import { logResourceAudit } from '@/lib/resources/admin/auditLog';
import { parseYouTubeVideoId, buildYouTubeThumbnailUrl } from './youtube';

export type RepairFailureKind = 'invalid' | 'not_found' | 'already_has_video' | 'forbidden' | 'error';

export type RepairVideoResult =
  | { ok: true; youtubeVideoId: string; youtubeUrl: string }
  | { ok: false; kind: RepairFailureKind; error: string };

export const REPAIR_ALREADY_HAS_MESSAGE = 'This video already has its YouTube details, so nothing was changed. The video of an existing record is never replaced; to use a different video, add it as a new video.';

export async function repairMissingVideoRow(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  input: { postId: string; youtubeInput: unknown; actorUserId: string }
): Promise<RepairVideoResult> {
  const parsed = parseYouTubeVideoId(input.youtubeInput);
  if (!parsed.ok) return { ok: false, kind: 'invalid', error: parsed.error };

  const { data: post, error: postErr } = await supabase.from('resource_posts').select('id, content_type, status, title, content_id').eq('id', input.postId).maybeSingle();
  if (postErr) return { ok: false, kind: 'error', error: 'Could not look up this video record.' };
  const row = post as { id: string; content_type: string; status: string; title: string; content_id: string | null } | null;
  if (!row || row.content_type !== 'video') return { ok: false, kind: 'not_found', error: 'Video not found.' };

  const { data: existing, error: existingErr } = await supabase.from('resource_videos').select('id').eq('resource_post_id', input.postId).maybeSingle();
  if (existingErr) return { ok: false, kind: 'error', error: 'Could not check whether this video already has YouTube details.' };
  if (existing) return { ok: false, kind: 'already_has_video', error: REPAIR_ALREADY_HAS_MESSAGE };

  const { error: insertErr } = await supabase.from('resource_videos').insert({
    resource_post_id: input.postId,
    youtube_video_id: parsed.videoId,
    youtube_url: parsed.normalizedUrl,
    youtube_channel_handle: '@GKTC',
    youtube_channel_url: 'https://www.youtube.com/@GKTC',
    thumbnail_url: buildYouTubeThumbnailUrl(parsed.videoId),
    chapters: [],
    embed_enabled: true,
  });
  if (insertErr) {
    // 23505 = the unique key on resource_post_id: someone repaired it between
    // the check above and this insert. Same outcome as the check.
    if (insertErr.code === '23505') return { ok: false, kind: 'already_has_video', error: REPAIR_ALREADY_HAS_MESSAGE };
    if (insertErr.code === '42501') return { ok: false, kind: 'forbidden', error: "You don't have permission to add YouTube details to this video." };
    console.error('Resources video repair insert error:', insertErr);
    return { ok: false, kind: 'error', error: 'Could not save the YouTube details. Nothing was changed.' };
  }

  // logResourceAudit is best-effort by design (it logs and swallows its own
  // failure, exactly like every other caller), so the repair result does not
  // claim more than that.
  await logResourceAudit(admin, {
    entity_type: 'resource_post',
    entity_id: input.postId,
    action: 'video_details_repaired',
    actor_user_id: input.actorUserId,
    before_state: { has_video_row: false },
    after_state: { has_video_row: true, youtube_video_id: parsed.videoId, youtube_url: parsed.normalizedUrl },
    metadata: { source: 'video-repair-form', title: row.title, content_id: row.content_id, status: row.status },
  });
  return { ok: true, youtubeVideoId: parsed.videoId, youtubeUrl: parsed.normalizedUrl };
}
