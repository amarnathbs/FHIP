// R1.6 CTA Library admin mutations — spec §42-43, §48, §52.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlainText } from '@/lib/resources/editor/sanitize';
import type { CtaSavePatch } from './types';

export async function createCta(supabase: SupabaseClient, patch: CtaSavePatch): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('resource_ctas')
    .insert({
      name: sanitizePlainText(patch.name, 120),
      label: sanitizePlainText(patch.label, 60),
      description: patch.description ? sanitizePlainText(patch.description, 300) : null,
      destination_type: patch.destination_type,
      destination_url: patch.destination_url.trim(),
      is_active: patch.is_active,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export async function updateCta(supabase: SupabaseClient, id: string, patch: CtaSavePatch): Promise<void> {
  const { error } = await supabase
    .from('resource_ctas')
    .update({
      name: sanitizePlainText(patch.name, 120),
      label: sanitizePlainText(patch.label, 60),
      description: patch.description ? sanitizePlainText(patch.description, 300) : null,
      destination_type: patch.destination_type,
      destination_url: patch.destination_url.trim(),
      is_active: patch.is_active,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

// spec §48: deactivating (not deleting) is the primary lever — a CTA
// referenced by resource_posts.primary_cta_id/secondary_cta_id cannot be
// hard-deleted anyway (those FKs are ON DELETE SET NULL, so deleting would
// silently strip a Resource's configured CTA rather than erroring — setting
// is_active=false is the safe, reversible, and honest action instead).
export async function setCtaActive(supabase: SupabaseClient, id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('resource_ctas').update({ is_active: isActive, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
