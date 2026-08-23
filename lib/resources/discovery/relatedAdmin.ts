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
// (resource_related_content.sort_order). Plain sequential update, same
// pattern as reorderPostFaqs in lib/resources/faq/mutations.ts.
export async function reorderRelatedContent(supabase: SupabaseClient, sourcePostId: string, orderedIds: string[]): Promise<void> {
  const results = await Promise.all(orderedIds.map((id, index) => supabase.from('resource_related_content').update({ sort_order: index }).eq('id', id).eq('source_post_id', sourcePostId)));
  const firstError = results.find((r) => r.error);
  if (firstError?.error) throw firstError.error;
}

export function formatStatusForPicker(status: string): string {
  return STATUS_LABELS[status as ResourceStatus] ?? status;
}

export function formatContentTypeForPicker(contentType: string): string {
  return CONTENT_TYPE_LABELS[contentType as ResourceContentType] ?? contentType;
}
