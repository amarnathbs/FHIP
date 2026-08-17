// R1.4 minimal Sources query layer — spec §49-50.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SourceOption } from './types';

function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

export async function searchSources(supabase: SupabaseClient, search: string): Promise<SourceOption[]> {
  let query = supabase.from('resource_sources').select('id, source_name, document_title, url, source_type, publication_date, is_public').order('source_name', { ascending: true }).limit(25);
  const q = sanitizeSearchTerm(search);
  if (q) query = query.or(`source_name.ilike.%${q}%,document_title.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SourceOption[];
}
