// R1.4 minimal Sources query layer — spec §49-50.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SourceOption } from './types';

function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

/**
 * The options an editor's SourcePicker should offer for ONE post: the first page of the shared library PLUS every
 * source already linked to this post. searchSources() alone returns only the first 25 by name, so a source linked
 * by a bulk upload (or by hand) that sorts later would be selected but invisible, and could not be reviewed or
 * removed. Reuses the same SourceOption shape and the same table: no second source library.
 * Returns the linked ids in sort order too, so the editor can start with them selected.
 */
export async function getSourceOptionsForPost(supabase: SupabaseClient, postId: string): Promise<{ options: SourceOption[]; linkedIds: string[] }> {
  const [first, linked] = await Promise.all([
    searchSources(supabase, ''),
    supabase
      .from('resource_post_sources')
      .select('sort_order, source:resource_sources!source_id(id, source_name, document_title, url, source_type, publication_date, is_public)')
      .eq('post_id', postId)
      .order('sort_order', { ascending: true }),
  ]);
  if (linked.error) throw linked.error;
  const linkedRows = ((linked.data ?? []) as unknown as { source: SourceOption | SourceOption[] | null }[])
    .map((r) => (Array.isArray(r.source) ? r.source[0] : r.source))
    .filter((s): s is SourceOption => !!s && !!s.id);
  const byId = new Map<string, SourceOption>();
  for (const s of linkedRows) byId.set(s.id, s);
  for (const s of first) if (!byId.has(s.id)) byId.set(s.id, s);
  return { options: Array.from(byId.values()), linkedIds: linkedRows.map((s) => s.id) };
}

export async function searchSources(supabase: SupabaseClient, search: string): Promise<SourceOption[]> {
  let query = supabase.from('resource_sources').select('id, source_name, document_title, url, source_type, publication_date, is_public').order('source_name', { ascending: true }).limit(25);
  const q = sanitizeSearchTerm(search);
  if (q) query = query.or(`source_name.ilike.%${q}%,document_title.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SourceOption[];
}
