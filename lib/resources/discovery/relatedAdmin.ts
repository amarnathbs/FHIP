// R1.6 Related Content — Admin management (spec §39-40, §77).
//
// Standalone management surface at /admin/resources/related (spec §39: "or
// integrate into the content editor if cleaner... Do not require SQL/admin
// scripts for ordinary curation"). Kept standalone rather than a new panel
// inside the certified R1.3 ResourceEditor — spec §76 explicitly allows
// this ("If standalone management screens are safer for R1.6, use them.
// Document the choice.") and it avoids touching the certified core editor's
// autosave/version/workflow wiring at all. Documented choice, not an
// oversight.

import type { SupabaseClient } from '@supabase/supabase-js';
import { STATUS_LABELS, CONTENT_TYPE_LABELS } from '@/lib/resources/admin/labels';
import type { ResourceStatus, ResourceContentType } from '@/lib/resources/types';

export const RELATIONSHIP_TYPES = ['related', 'prerequisite', 'next_step', 'see_also'] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  related: 'Related',
  prerequisite: 'Prerequisite',
  next_step: 'Next Step',
  see_also: 'See Also',
};

export interface RelatableSearchResult {
  id: string;
  title: string;
  content_type: string;
  jurisdiction: string;
  status: string;
  slug: string | null;
}

// spec §77: "title search; content type; jurisdiction; status visible to
// staff. But should clearly mark unpublished items if Admin can select
// them." Every row here is staff-visible regardless of publication status
// (RLS "staff read all posts") — the caller's UI is responsible for showing
// the status label so an editor sees exactly what they're about to link;
// the *public renderer* (lib/resources/discovery/related.ts) is what
// actually suppresses non-public targets, unconditionally, independent of
// what an editor picked here (spec §34).
export async function searchRelatableContent(supabase: SupabaseClient, search: string, opts: { contentType?: string; jurisdiction?: string; excludePostId?: string } = {}): Promise<RelatableSearchResult[]> {
  let query = supabase.from('resource_posts').select('id, title, content_type, jurisdiction, status, slug').order('updated_at', { ascending: false }).limit(25);
  const q = search.trim().slice(0, 200).replace(/[%_]/g, '\\$&');
  if (q) query = query.ilike('title', `%${q}%`);
  if (opts.contentType && opts.contentType !== 'all') query = query.eq('content_type', opts.contentType);
  if (opts.jurisdiction && opts.jurisdiction !== 'all') query = query.eq('jurisdiction', opts.jurisdiction);
  if (opts.excludePostId) query = query.neq('id', opts.excludePostId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as RelatableSearchResult[];
}

export interface RelatedContentAdminRow {
  id: string;
  relationship_type: RelationshipType;
  sort_order: number;
  related: { id: string; title: string; content_type: string; status: string; slug: string | null } | null;
}

export async function listRelatedContentForSource(supabase: SupabaseClient, sourcePostId: string): Promise<RelatedContentAdminRow[]> {
  const { data, error } = await supabase
    .from('resource_related_content')
    .select('id, relationship_type, sort_order, related:resource_posts!related_post_id(id,title,content_type,status,slug)')
    .eq('source_post_id', sourcePostId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as RelatedContentAdminRow[];
}

export async function addRelatedContent(supabase: SupabaseClient, sourcePostId: string, relatedPostId: string, relationshipType: RelationshipType): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (sourcePostId === relatedPostId) return { ok: false, error: 'A Resource cannot be related to itself.' }; // spec §32, defence-in-depth ahead of the DB constraint
  const { data: maxRow } = await supabase.from('resource_related_content').select('sort_order').eq('source_post_id', sourcePostId).order('sort_order', { ascending: false }).limit(1);
  const nextSort = ((maxRow?.[0]?.sort_order as number | undefined) ?? -1) + 1;
  const { data, error } = await supabase
    .from('resource_related_content')
    .insert({ source_post_id: sourcePostId, related_post_id: relatedPostId, relationship_type: relationshipType, sort_order: nextSort })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'This relationship already exists.' }; // spec §33 dedupe, backed by uq_resource_related_content
    if (error.code === '23514') return { ok: false, error: 'A Resource cannot be related to itself.' };
    throw error;
  }
  return { ok: true, id: data.id as string };
}

export async function removeRelatedContent(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('resource_related_content').delete().eq('id', id);
  if (error) throw error;
}

// spec §39: "reorder if existing schema supports order" — it does
// (resource_related_content.sort_order).
//
// Admin A0.2 Wave 2 (Scope A). This used to be a Promise.all of N
// independent `.update()` calls — each its own PostgREST request and its own
// autocommitted transaction — with no transaction, no validation that the
// payload described the complete set, and no locking. A failure part-way
// through left the already-committed positions committed, so the ordering
// ended up duplicated, gapped, or a blend of two concurrent requests, while
// the caller received a bare HTTP 500. Reproduced against a real database in
// scripts/admin_a02_wave2_certification.mjs (SECTIONS 1-2) before this
// replacement was written.
//
// It is now a single call to public.admin_reorder_related_content (migration
// 0116), which is one transaction: it validates the payload as the COMPLETE
// ordered set for exactly one source, locks that set, writes every position
// in one statement, and returns the committed ordering read back from the
// table. It succeeds completely or changes nothing.
//
// The RPC's EXECUTE is granted to service_role only, so this must be called
// with a service-role client. That is deliberate and matches the Wave 1/1B
// pattern (migrations 0107/0109): the *authority* check lives in the route
// (canManageDiscovery), and the RPC is unreachable from a browser session
// key so it can never be invoked directly by an authenticated non-admin.

export const MAX_RELATED_REORDER_ITEMS = 100; // mirrors the RPC's own cap

export type ReorderFailureKind = 'invalid' | 'not_found' | 'conflict' | 'error';

export interface ReorderedRelatedContent {
  source_post_id: string;
  count: number;
  ordered: { id: string; sort_order: number }[];
}

export type ReorderResult = { ok: true; data: ReorderedRelatedContent } | { ok: false; kind: ReorderFailureKind; message: string };

// SQLSTATEs raised deliberately by admin_reorder_related_content. Anything
// else is an unexpected server fault and is never surfaced verbatim.
const REORDER_ERROR_KINDS: Record<string, ReorderFailureKind> = {
  '22023': 'invalid', // invalid_parameter_value — payload shape/content
  P0002: 'not_found', // source Resource does not exist
  '40001': 'conflict', // the link set changed since the client loaded it
};

// The RPC's messages are written for administrators and are safe to show, but
// they are prefixed with the function name for server logs. Strip that so the
// UI shows a clean sentence, and never pass through a message we did not
// author (i.e. an unexpected SQLSTATE).
function cleanRpcMessage(message: string): string {
  return message.replace(/^admin_reorder_related_content:\s*/, '').trim();
}

export async function reorderRelatedContent(supabase: SupabaseClient, sourcePostId: string, orderedIds: string[]): Promise<ReorderResult> {
  const { data, error } = await supabase.rpc('admin_reorder_related_content', {
    p_source_post_id: sourcePostId,
    p_ordered_ids: orderedIds,
  });

  if (error) {
    const kind = REORDER_ERROR_KINDS[error.code ?? ''];
    if (!kind) {
      // Unexpected SQLSTATE (or a transport failure). Log the detail
      // server-side; never leak a raw SQL error to the client.
      console.error('Resources related-content reorder RPC error:', error);
      return { ok: false, kind: 'error', message: 'Could not reorder related content.' };
    }
    return { ok: false, kind, message: cleanRpcMessage(error.message ?? '') || 'Could not reorder related content.' };
  }

  return { ok: true, data: data as ReorderedRelatedContent };
}

export function formatStatusForPicker(status: string): string {
  return STATUS_LABELS[status as ResourceStatus] ?? status;
}

export function formatContentTypeForPicker(contentType: string): string {
  return CONTENT_TYPE_LABELS[contentType as ResourceContentType] ?? contentType;
}
