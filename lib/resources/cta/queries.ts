// R1.6 CTA Library admin queries — spec §42-43.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CtaRow } from './types';

export async function listCtas(supabase: SupabaseClient, search?: string): Promise<CtaRow[]> {
  let query = supabase.from('resource_ctas').select('*').order('label', { ascending: true });
  if (search && search.trim()) {
    const q = search.trim().replace(/[%_]/g, '\\$&');
    query = query.or(`name.ilike.%${q}%,label.ilike.%${q}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CtaRow[];
}

export async function getCtaById(supabase: SupabaseClient, id: string): Promise<CtaRow | null> {
  const { data, error } = await supabase.from('resource_ctas').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as CtaRow | null) ?? null;
}

// spec §52: "Prevent... duplicate exact CTA where problematic" — a soft,
// case-insensitive check on (label, destination_type, destination_url)
// rather than a hard DB unique constraint (two genuinely different CTAs
// could legitimately share a label, e.g. "Check Your Financial Health" with
// two different destinations is fine; the exact same label+destination pair
// twice is very likely a mistake).
export async function findDuplicateCta(supabase: SupabaseClient, label: string, destinationType: string, destinationUrl: string, excludeId?: string): Promise<boolean> {
  let query = supabase.from('resource_ctas').select('id').ilike('label', label.trim()).eq('destination_type', destinationType).eq('destination_url', destinationUrl.trim());
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

// How many resource_posts reference a given CTA as primary or secondary —
// shown in the admin list/detail so an editor knows the blast radius before
// deactivating one (spec §48: "it should disappear without editing every
// linked Resource" — deactivating is safe by design, this count is purely
// informational).
export async function countCtaUsage(supabase: SupabaseClient, ctaId: string): Promise<number> {
  const [primary, secondary] = await Promise.all([
    supabase.from('resource_posts').select('id', { count: 'exact', head: true }).eq('primary_cta_id', ctaId),
    supabase.from('resource_posts').select('id', { count: 'exact', head: true }).eq('secondary_cta_id', ctaId),
  ]);
  if (primary.error) throw primary.error;
  if (secondary.error) throw secondary.error;
  return (primary.count ?? 0) + (secondary.count ?? 0);
}
