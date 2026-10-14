// PO review F12 (06/10/2026) — "How to link the video to the content".
//
// Linking a video to content reuses the EXISTING relationship model rather
// than inventing a second one: a row in resource_related_content
// (source_post_id -> related_post_id, relationship_type, sort_order; migration
// 0049). The public renderer (lib/resources/discovery/related.ts) already reads
// that table, so a linked video shows up on the content's public page with no
// extra code — provided the video is itself publicly visible (spec §34).
//
// DIRECTION: source = the CONTENT, related = the VIDEO. The row means "this
// content shows that video". The video side therefore lists the INBOUND rows
// (related_post_id = video) and the content side lists the OUTBOUND rows whose
// related post is a video.
//
// RELATIONSHIP TYPE: 'related'. The CHECK constraint (0049) allows exactly
// related / prerequisite / next_step / see_also, and 'related' is the plain
// "show alongside" meaning, so NO migration and no constraint change is
// needed. Other types remain available on the Related Content screen.
//
// Every function takes the caller's own request-scoped client; the database's
// own policies on resource_related_content stay the boundary and the routes
// check canManageDiscovery() first. Writes reuse addRelatedContent /
// removeRelatedContent from relatedAdmin.ts (same dedupe, same zero-row
// contract), so there is exactly one write path for these rows.

import type { SupabaseClient } from '@supabase/supabase-js';
import { addRelatedContent, removeRelatedContent, type RelationshipType } from '@/lib/resources/discovery/relatedAdmin';

export const VIDEO_LINK_RELATIONSHIP: RelationshipType = 'related';

export interface LinkedPostSummary {
  id: string;
  title: string;
  content_type: string;
  status: string;
  slug: string | null;
}

/** A link as seen from a VIDEO: the content the video is linked to. */
export interface ContentLinkedToVideo {
  id: string;
  relationship_type: RelationshipType;
  sort_order: number;
  content: LinkedPostSummary | null;
}

/** A link as seen from CONTENT: a video that content shows. */
export interface VideoLinkedToContent {
  id: string;
  relationship_type: RelationshipType;
  sort_order: number;
  video: LinkedPostSummary | null;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value ?? null;
}

export async function listContentLinkedToVideo(supabase: SupabaseClient, videoPostId: string): Promise<ContentLinkedToVideo[]> {
  const { data, error } = await supabase
    .from('resource_related_content')
    .select('id, relationship_type, sort_order, source:resource_posts!source_post_id(id,title,content_type,status,slug)')
    .eq('related_post_id', videoPostId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as { id: string; relationship_type: RelationshipType; sort_order: number; source: LinkedPostSummary | LinkedPostSummary[] | null }[]).map((r) => ({
    id: r.id,
    relationship_type: r.relationship_type,
    sort_order: r.sort_order,
    content: one(r.source),
  }));
}

export async function listVideosLinkedToContent(supabase: SupabaseClient, contentPostId: string): Promise<VideoLinkedToContent[]> {
  const { data, error } = await supabase
    .from('resource_related_content')
    .select('id, relationship_type, sort_order, related:resource_posts!related_post_id(id,title,content_type,status,slug)')
    .eq('source_post_id', contentPostId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as { id: string; relationship_type: RelationshipType; sort_order: number; related: LinkedPostSummary | LinkedPostSummary[] | null }[])
    .map((r) => ({ id: r.id, relationship_type: r.relationship_type, sort_order: r.sort_order, video: one(r.related) }))
    .filter((r) => r.video?.content_type === 'video');
}

export type LinkVideoFailureKind = 'invalid' | 'not_found' | 'duplicate' | 'error';

export type LinkVideoResult =
  | { ok: true; id: string; video: { id: string; title: string }; content: { id: string; title: string; content_type: string } }
  | { ok: false; kind: LinkVideoFailureKind; error: string };

export async function linkVideoToContent(supabase: SupabaseClient, input: { videoPostId: string; contentPostId: string }): Promise<LinkVideoResult> {
  const { videoPostId, contentPostId } = input;
  if (!videoPostId || !contentPostId) return { ok: false, kind: 'invalid', error: 'Choose the content to link this video to.' };
  if (videoPostId === contentPostId) return { ok: false, kind: 'invalid', error: 'A video cannot be linked to itself.' };

  const { data: posts, error: readErr } = await supabase.from('resource_posts').select('id, title, content_type').in('id', [videoPostId, contentPostId]);
  if (readErr) return { ok: false, kind: 'error', error: 'Could not check the video and the content.' };
  const rows = (posts ?? []) as { id: string; title: string; content_type: string }[];
  const video = rows.find((r) => r.id === videoPostId);
  const content = rows.find((r) => r.id === contentPostId);
  if (!video || video.content_type !== 'video') return { ok: false, kind: 'not_found', error: 'Video not found.' };
  if (!content) return { ok: false, kind: 'not_found', error: 'The content you chose was not found.' };
  if (content.content_type === 'video') {
    return { ok: false, kind: 'invalid', error: 'Choose an article, guide, explainer, money update or glossary item. To relate two videos, use Related Content.' };
  }

  // Already linked (under ANY relationship type)? The table's own unique key
  // includes the type, so without this a second, differently-typed row for the
  // same pair could be created and show twice.
  const { data: existing, error: dupErr } = await supabase.from('resource_related_content').select('id').eq('source_post_id', contentPostId).eq('related_post_id', videoPostId).limit(1);
  if (dupErr) return { ok: false, kind: 'error', error: 'Could not check existing links.' };
  if ((existing ?? []).length > 0) return { ok: false, kind: 'duplicate', error: 'This video is already linked to that content.' };

  try {
    const added = await addRelatedContent(supabase, contentPostId, videoPostId, VIDEO_LINK_RELATIONSHIP);
    if (!added.ok) return { ok: false, kind: added.error.includes('already exists') ? 'duplicate' : 'invalid', error: added.error };
    return { ok: true, id: added.id, video: { id: video.id, title: video.title }, content: { id: content.id, title: content.title, content_type: content.content_type } };
  } catch {
    return { ok: false, kind: 'error', error: 'Could not link this video.' };
  }
}

// The audit row is a best-effort side write (see lib/resources/admin/
// auditLog.ts): it must never turn an already-committed link or unlink into a
// 500. This also covers createAdminClient() itself throwing when the
// service-role environment is not configured.
export async function auditBestEffort(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error('Resources video link audit write failed (non-fatal):', err);
  }
}

export type UnlinkVideoResult =
  | { ok: true; removed: { id: string; source_post_id: string; related_post_id: string; relationship_type: string } }
  | { ok: false; kind: 'not_found' | 'error'; error: string };

// The link must really be a link TO this video: a caller cannot use a video's
// URL to delete some unrelated relationship by guessing its id.
export async function unlinkVideoFromContent(supabase: SupabaseClient, input: { videoPostId: string; linkId: string }): Promise<UnlinkVideoResult> {
  const { data: link, error: readErr } = await supabase.from('resource_related_content').select('id, source_post_id, related_post_id, relationship_type').eq('id', input.linkId).maybeSingle();
  if (readErr) return { ok: false, kind: 'error', error: 'Could not look up this link.' };
  const row = link as { id: string; source_post_id: string; related_post_id: string; relationship_type: string } | null;
  if (!row || row.related_post_id !== input.videoPostId) return { ok: false, kind: 'not_found', error: 'This link no longer exists.' };
  try {
    const { deleted } = await removeRelatedContent(supabase, row.id);
    if (!deleted) return { ok: false, kind: 'not_found', error: 'This link no longer exists.' };
    return { ok: true, removed: row };
  } catch {
    return { ok: false, kind: 'error', error: 'Could not remove this link.' };
  }
}
