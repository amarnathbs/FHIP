// R1.4 minimal Sources mutation layer — spec §49-51.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlainText } from '@/lib/resources/editor/sanitize';
import { validateSourceUrl } from './validation';
import type { CreateSourceInput } from './types';

export async function createSource(supabase: SupabaseClient, input: CreateSourceInput, userId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = sanitizePlainText(input.source_name, 200).trim();
  if (!name) return { ok: false, error: 'A source name is required.' };

  const urlCheck = validateSourceUrl(input.url);
  if (!urlCheck.valid) return { ok: false, error: urlCheck.error ?? 'Enter a valid https:// URL.' };

  const { data, error } = await supabase
    .from('resource_sources')
    .insert({
      source_name: name,
      document_title: sanitizePlainText(input.document_title, 300) || null,
      url: input.url.trim() || null,
      source_type: sanitizePlainText(input.source_type, 100) || null,
      publication_date: input.publication_date || null,
      is_public: input.is_public,
      created_by: userId,
    })
    .select('id')
    .single();
  if (error) return { ok: false, error: 'Could not create this source.' };
  return { ok: true, id: data.id as string };
}

export async function linkSourceToPost(supabase: SupabaseClient, postId: string, sourceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: maxRow } = await supabase.from('resource_post_sources').select('sort_order').eq('post_id', postId).order('sort_order', { ascending: false }).limit(1);
  const nextSort = ((maxRow?.[0]?.sort_order as number | undefined) ?? -1) + 1;
  const { error } = await supabase.from('resource_post_sources').insert({ post_id: postId, source_id: sourceId, sort_order: nextSort });
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'This source is already linked to this content.' };
    throw error;
  }
  return { ok: true };
}

export async function unlinkSourceFromPost(supabase: SupabaseClient, postId: string, sourceId: string): Promise<void> {
  const { error } = await supabase.from('resource_post_sources').delete().eq('post_id', postId).eq('source_id', sourceId);
  if (error) throw error;
}

// Full sync (delete-then-insert), used by the Money Update save flow so the
// editor's source list is the single source of truth for what's linked —
// same documented non-atomicity pattern as taxonomy/related-terms sync.
export async function syncPostSources(supabase: SupabaseClient, postId: string, sourceIdsInOrder: string[]): Promise<void> {
  const { error: delErr } = await supabase.from('resource_post_sources').delete().eq('post_id', postId);
  if (delErr) throw delErr;
  const ids = Array.from(new Set(sourceIdsInOrder.filter(Boolean)));
  if (ids.length === 0) return;
  const { error: insErr } = await supabase.from('resource_post_sources').insert(ids.map((id, i) => ({ post_id: postId, source_id: id, sort_order: i })));
  if (insErr) throw insErr;
}
