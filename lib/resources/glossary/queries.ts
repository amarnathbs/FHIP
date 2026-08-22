// R1.4 Glossary query layer — spec §25-31.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContentListFilters } from '@/lib/resources/admin/filters';
import type { RelatedOption } from '@/lib/resources/editor/types';
import type { GlossaryEditorPost, SimilarTermMatch } from './types';

export interface GlossaryListItem {
  id: string;
  title: string;
  excerpt: string | null;
  jurisdiction: string;
  status: string;
  updated_at: string;
  next_review_at: string | null;
  primary_category: RelatedOption | null;
}

export interface GlossaryListResult {
  items: GlossaryListItem[];
  total: number;
  page: number;
  pageSize: number;
}

function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

const LIST_COLUMNS = 'id, title, excerpt, jurisdiction, status, updated_at, next_review_at, primary_category:resource_categories!primary_category_id(id,name), aliases';

// Spec §25: "Support search by: term, aliases, definition." title/excerpt
// use ordinary `ilike` substring matching. `aliases` is a text[] column —
// PostgREST's array-contains operator (`cs`, Postgres `@>`) is an exact
// element match, not a substring match, so a search term must match a
// stored alias exactly (case-sensitively) to hit via that branch; a partial
// alias search still succeeds through the title/excerpt branches whenever
// the alias also appears there. A true substring-in-array search would need
// a server-side function/RPC (unnest + ilike) — not justified for a table
// this small (spec §1: 50 glossary definitions total) or narrow enough to
// add as an R1.4 RPC per spec §105's "do not introduce a generic ... RPC"
// caution; documented here and in the completion report as a narrow,
// intentional limitation rather than silently glossed over.
export async function getGlossaryList(supabase: SupabaseClient, filters: Pick<ContentListFilters, 'search' | 'status' | 'jurisdiction' | 'sort' | 'page' | 'pageSize'>): Promise<GlossaryListResult> {
  let query = supabase.from('resource_posts').select(LIST_COLUMNS, { count: 'exact' }).eq('content_type', 'glossary');

  if (filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.jurisdiction !== 'all') query = query.eq('jurisdiction', filters.jurisdiction);

  const q = sanitizeSearchTerm(filters.search);
  if (q) query = query.or(`title.ilike.%${q}%,excerpt.ilike.%${q}%,aliases.cs.{${q}}`);

  const sortMap: Record<string, { column: string; ascending: boolean }> = {
    updated_desc: { column: 'updated_at', ascending: false },
    updated_asc: { column: 'updated_at', ascending: true },
    title_asc: { column: 'title', ascending: true },
    review_asc: { column: 'next_review_at', ascending: true },
  };
  const { column, ascending } = sortMap[filters.sort] ?? sortMap.updated_desc;
  query = query.order(column, { ascending, nullsFirst: false });

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { items: (data ?? []) as unknown as GlossaryListItem[], total: count ?? 0, page: filters.page, pageSize: filters.pageSize };
}

const EDITOR_POST_COLUMNS = [
  'id',
  'content_id',
  'title',
  'slug',
  'excerpt',
  'content_blocks',
  'content_type',
  'jurisdiction',
  'difficulty',
  'freshness_type',
  'visibility',
  'primary_category_id',
  'featured_image_id',
  'author_id',
  'reviewer_id',
  'compliance_reviewer_id',
  'status',
  'compliance_classification',
  'scheduled_at',
  'published_at',
  'expires_at',
  'last_reviewed_at',
  'next_review_at',
  'seo_title',
  'seo_description',
  'canonical_url',
  'social_image_id',
  'is_indexable',
  'primary_cta_id',
  'secondary_cta_id',
  'is_featured',
  'featured_priority',
  'editorial_approved_by',
  'editorial_approved_at',
  'compliance_approved_by',
  'compliance_approved_at',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'aliases',
].join(', ');

export async function getGlossaryEditorPost(supabase: SupabaseClient, id: string): Promise<GlossaryEditorPost | null> {
  const { data: post, error } = await supabase.from('resource_posts').select(EDITOR_POST_COLUMNS).eq('id', id).eq('content_type', 'glossary').maybeSingle();
  if (error) throw error;
  if (!post) return null;

  const [{ data: categoryLinks }, { data: tagLinks }, { data: relatedLinks }] = await Promise.all([
    supabase.from('resource_post_categories').select('category:resource_categories!category_id(id,name)').eq('post_id', id).eq('is_primary', false),
    supabase.from('resource_post_tags').select('tag:resource_tags!tag_id(id,name)').eq('post_id', id),
    supabase.from('resource_related_content').select('related:resource_posts!related_post_id(id,name:title)').eq('source_post_id', id).eq('relationship_type', 'related'),
  ]);

  const p = post as unknown as Record<string, unknown>;
  return {
    ...(p as unknown as GlossaryEditorPost),
    aliases: (p.aliases as string[] | null) ?? [],
    categories: ((categoryLinks ?? []) as unknown as { category: RelatedOption }[]).map((r) => r.category).filter(Boolean),
    tags: ((tagLinks ?? []) as unknown as { tag: RelatedOption }[]).map((r) => r.tag).filter(Boolean),
    relatedTerms: ((relatedLinks ?? []) as unknown as { related: RelatedOption }[]).map((r) => r.related).filter(Boolean),
  };
}

// Spec §29: "Prevent duplicate term/slug. Case-insensitive term detection
// recommended. Warn if a similar term already exists. Do not silently merge
// definitions." Never trusted client-side only — this is called from the
// glossary API route before create/save, same principle as isSlugAvailable.
//
// Two distinct queries for two distinct purposes:
//   - findExactDuplicateGlossaryTerm: case-insensitive EXACT match — the
//     hard-reject check the PATCH route runs before saving (spec §29:
//     "Prevent duplicate term").
//   - findSimilarGlossaryTerms: substring/partial match — the softer
//     check-as-you-type "a similar term already exists" warning surfaced to
//     the editor, which does not block saving on its own.
export async function findExactDuplicateGlossaryTerm(supabase: SupabaseClient, term: string, excludeId?: string): Promise<SimilarTermMatch | null> {
  const cleaned = term.trim();
  if (!cleaned) return null;
  let query = supabase.from('resource_posts').select('id, title, status').eq('content_type', 'glossary').ilike('title', cleaned).limit(1);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? [])[0] as SimilarTermMatch | undefined) ?? null;
}

export async function findSimilarGlossaryTerms(supabase: SupabaseClient, term: string, excludeId?: string): Promise<SimilarTermMatch[]> {
  const cleaned = term.trim().replace(/[%,()*]/g, '');
  if (!cleaned) return [];
  let query = supabase.from('resource_posts').select('id, title, status').eq('content_type', 'glossary').ilike('title', `%${cleaned}%`).limit(10);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SimilarTermMatch[];
}

// All other active Glossary terms, for the Related Terms picker (spec §30 —
// relationships, not free text; self-reference/duplicate pairs are guarded
// by resource_related_content's own DB constraints regardless of what this
// picker offers, this list is just what's presented as *available*).
export async function getGlossaryTermOptions(supabase: SupabaseClient, excludeId?: string): Promise<RelatedOption[]> {
  let query = supabase.from('resource_posts').select('id, name:title').eq('content_type', 'glossary').order('title', { ascending: true });
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as RelatedOption[];
}
