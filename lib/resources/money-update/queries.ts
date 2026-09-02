// R1.4 Money Update query layer — spec §41-50.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RelatedOption } from '@/lib/resources/editor/types';
import type { MoneyUpdateEditorPost, MoneyUpdateSource } from './types';

export interface MoneyUpdateListItem {
  id: string;
  title: string;
  // Admin A0.2 Wave 5 (§8.7 — a row must carry the identity the filter above
  // it implies). This list mixes Money Updates and Money Update Templates,
  // and offers a filter to separate them, but the row itself carried no
  // content type at all — so with the filter set to "Updates + Templates"
  // (the default) an editor could not tell which kind any row was, and both
  // kinds link to the same edit route. The column was already being filtered
  // on; it simply was not selected or returned.
  content_type: string;
  jurisdiction: string;
  event_date: string | null;
  status: string;
  compliance_classification: string;
  next_review_at: string | null;
  expires_at: string | null;
  updated_at: string;
}

export interface MoneyUpdateListFilters {
  search: string;
  jurisdiction: string;
  compliance: string;
  status: string;
  contentType: 'money_update' | 'money_update_template' | 'all';
  page: number;
  pageSize: number;
}

export interface MoneyUpdateListResult {
  items: MoneyUpdateListItem[];
  total: number;
  page: number;
  pageSize: number;
}

function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

export async function getMoneyUpdateList(supabase: SupabaseClient, filters: MoneyUpdateListFilters): Promise<MoneyUpdateListResult> {
  let query = supabase
    .from('resource_posts')
    .select('id, title, content_type, jurisdiction, event_date, status, compliance_classification, next_review_at, expires_at, updated_at', { count: 'exact' });

  if (filters.contentType === 'all') query = query.in('content_type', ['money_update', 'money_update_template']);
  else query = query.eq('content_type', filters.contentType);

  if (filters.jurisdiction !== 'all') query = query.eq('jurisdiction', filters.jurisdiction);
  if (filters.compliance !== 'all') query = query.eq('compliance_classification', filters.compliance);
  if (filters.status !== 'all') query = query.eq('status', filters.status);

  const q = sanitizeSearchTerm(filters.search);
  if (q) query = query.or(`title.ilike.%${q}%,excerpt.ilike.%${q}%`);

  query = query.order('event_date', { ascending: false, nullsFirst: false });

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { items: (data ?? []) as unknown as MoneyUpdateListItem[], total: count ?? 0, page: filters.page, pageSize: filters.pageSize };
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
  'event_date',
  'affected_audience',
].join(', ');

export async function getMoneyUpdateEditorPost(supabase: SupabaseClient, id: string): Promise<MoneyUpdateEditorPost | null> {
  const { data: post, error } = await supabase.from('resource_posts').select(EDITOR_POST_COLUMNS).eq('id', id).in('content_type', ['money_update', 'money_update_template']).maybeSingle();
  if (error) throw error;
  if (!post) return null;

  const [{ data: categoryLinks }, { data: tagLinks }, { data: sourceLinks }] = await Promise.all([
    supabase.from('resource_post_categories').select('category:resource_categories!category_id(id,name)').eq('post_id', id).eq('is_primary', false),
    supabase.from('resource_post_tags').select('tag:resource_tags!tag_id(id,name)').eq('post_id', id),
    supabase
      .from('resource_post_sources')
      .select('sort_order, source:resource_sources!source_id(id, source_name, document_title, url, source_type, publication_date)')
      .eq('post_id', id)
      .order('sort_order', { ascending: true }),
  ]);

  const p = post as unknown as Record<string, unknown>;
  return {
    ...(p as unknown as MoneyUpdateEditorPost),
    categories: ((categoryLinks ?? []) as unknown as { category: RelatedOption }[]).map((r) => r.category).filter(Boolean),
    tags: ((tagLinks ?? []) as unknown as { tag: RelatedOption }[]).map((r) => r.tag).filter(Boolean),
    sources: ((sourceLinks ?? []) as unknown as { sort_order: number; source: Omit<MoneyUpdateSource, 'sort_order'> }[]).map((r) => ({ ...r.source, sort_order: r.sort_order })).filter((s) => s.id),
  };
}

export async function getMoneyUpdateTemplateOptions(supabase: SupabaseClient): Promise<{ id: string; title: string }[]> {
  const { data, error } = await supabase.from('resource_posts').select('id, title').eq('content_type', 'money_update_template').order('title', { ascending: true });
  if (error) throw error;
  return (data ?? []) as { id: string; title: string }[];
}
