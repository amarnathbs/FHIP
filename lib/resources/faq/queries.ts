// R1.4 FAQ query layer — spec §32-39.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FaqRow, FaqListItem, FaqLinkedPost } from './types';

export type { FaqListItem } from './types';

export interface FaqListFilters {
  search: string;
  jurisdiction: string; // 'all' or a jurisdiction value
  activeOnly: 'all' | 'active' | 'inactive';
  categoryId: string; // 'all' or a uuid
  page: number;
  pageSize: number;
}

function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

export interface FaqListResult {
  items: FaqListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getFaqList(supabase: SupabaseClient, filters: FaqListFilters): Promise<FaqListResult> {
  let query = supabase.from('resource_faqs').select('id, question, jurisdiction, is_active, updated_at, category:resource_categories!category_id(id,name)', { count: 'exact' });

  if (filters.jurisdiction !== 'all') query = query.eq('jurisdiction', filters.jurisdiction);
  if (filters.activeOnly === 'active') query = query.eq('is_active', true);
  if (filters.activeOnly === 'inactive') query = query.eq('is_active', false);
  if (filters.categoryId !== 'all') query = query.eq('category_id', filters.categoryId);

  const q = sanitizeSearchTerm(filters.search);
  if (q) query = query.ilike('question', `%${q}%`);

  query = query.order('updated_at', { ascending: false });

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const ids = rows.map((r) => r.id as string);

  // Linked-content counts (spec §33 list column) — one grouped query rather
  // than N+1 per-row queries.
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: links, error: linkErr } = await supabase.from('resource_post_faqs').select('faq_id').in('faq_id', ids);
    if (linkErr) throw linkErr;
    for (const l of (links ?? []) as { faq_id: string }[]) counts.set(l.faq_id, (counts.get(l.faq_id) ?? 0) + 1);
  }

  const items: FaqListItem[] = rows.map((r) => ({
    id: r.id as string,
    question: r.question as string,
    jurisdiction: r.jurisdiction as string,
    is_active: r.is_active as boolean,
    category: (r.category as { id: string; name: string } | null) ?? null,
    updated_at: r.updated_at as string,
    linkedCount: counts.get(r.id as string) ?? 0,
  }));

  return { items, total: count ?? 0, page: filters.page, pageSize: filters.pageSize };
}

export async function getFaqById(supabase: SupabaseClient, id: string): Promise<FaqRow | null> {
  const { data, error } = await supabase.from('resource_faqs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as FaqRow | null) ?? null;
}

export async function getFaqLinkedPosts(supabase: SupabaseClient, faqId: string): Promise<FaqLinkedPost[]> {
  const { data, error } = await supabase
    .from('resource_post_faqs')
    .select('post_id, sort_order, post:resource_posts!post_id(title, content_type, status)')
    .eq('faq_id', faqId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as { post_id: string; sort_order: number; post: { title: string; content_type: string; status: string } | null }[]).map((r) => ({
    post_id: r.post_id,
    title: r.post?.title ?? '(untitled)',
    content_type: r.post?.content_type ?? '',
    status: r.post?.status ?? '',
    sort_order: r.sort_order,
  }));
}

// For the FAQ-to-post linking picker (spec §36) — any post the caller's RLS
// scope can see, regardless of content type ("Article, Guide, FHIP
// Explainer, Video, Glossary, Money Update" per spec §36's own list).
export async function searchLinkablePosts(supabase: SupabaseClient, search: string): Promise<{ id: string; title: string; content_type: string }[]> {
  let query = supabase.from('resource_posts').select('id, title, content_type').order('updated_at', { ascending: false }).limit(20);
  const q = sanitizeSearchTerm(search);
  if (q) query = query.ilike('title', `%${q}%`);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as { id: string; title: string; content_type: string }[];
}
