// R1.4 FAQ mutation layer — spec §32-39, §56-58.
//
// Autosave decision (spec §56): FAQ forms are small (question + short answer
// + a few metadata fields) — this module exposes only an explicit Save,
// deliberately no debounced autosave wiring. Spec §56 permits this
// explicitly ("For small FAQ/Glossary forms, autosave is optional if it adds
// needless complexity... reliability matters more") — documented here and in
// the completion report as the chosen behaviour, not an oversight. Glossary
// *does* reuse the R1.3 autosave path (via the same ResourceEditor-style
// component family the Video/Money Update editors use) since it shares the
// resource_posts editor shell; FAQ does not, because it isn't a
// resource_posts editor at all.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlainText, sanitizeBlocks } from '@/lib/resources/editor/sanitize';
import type { FaqSavePatch } from './types';

export interface CreateFaqResult {
  id: string;
}

export async function createFaq(supabase: SupabaseClient, patch: FaqSavePatch, userId: string): Promise<CreateFaqResult> {
  const { data, error } = await supabase
    .from('resource_faqs')
    .insert({
      question: sanitizePlainText(patch.question, 300),
      short_answer: sanitizePlainText(patch.short_answer, 600),
      answer_blocks: sanitizeBlocks(patch.answer_blocks),
      jurisdiction: patch.jurisdiction,
      is_active: patch.is_active,
      category_id: patch.category_id,
      compliance_classification: patch.compliance_classification,
      created_by: userId,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export type FaqSaveOutcome = { status: 'ok'; faq: Record<string, unknown> } | { status: 'conflict' } | { status: 'not_found' };

// Stale-write protection (spec §57/§98): resource_faqs has its own
// `updated_at` column (R1.1 foundation) — reused here with the identical
// eq(id).eq(updated_at, expected) gate R1.3 established for resource_posts,
// not a second bespoke implementation.
export async function updateFaq(supabase: SupabaseClient, id: string, patch: FaqSavePatch, expectedUpdatedAt: string, userId: string): Promise<FaqSaveOutcome> {
  const { data, error } = await supabase
    .from('resource_faqs')
    .update({
      question: sanitizePlainText(patch.question, 300),
      short_answer: sanitizePlainText(patch.short_answer, 600),
      answer_blocks: sanitizeBlocks(patch.answer_blocks),
      jurisdiction: patch.jurisdiction,
      is_active: patch.is_active,
      category_id: patch.category_id,
      compliance_classification: patch.compliance_classification,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('updated_at', expectedUpdatedAt)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { data: exists } = await supabase.from('resource_faqs').select('id').eq('id', id).maybeSingle();
    return exists ? { status: 'conflict' } : { status: 'not_found' };
  }
  return { status: 'ok', faq: data as Record<string, unknown> };
}

export async function setFaqActive(supabase: SupabaseClient, id: string, isActive: boolean, userId: string): Promise<void> {
  const { error } = await supabase.from('resource_faqs').update({ is_active: isActive, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// Spec §38: "Prefer is_active = false ... If delete is offered, show
// linked-content impact first." Hard delete is only attempted by the API
// route after the caller has already been shown the linked-post count and
// explicitly confirmed; this function itself still refuses to delete a FAQ
// with any live resource_post_faqs rows, as a defence-in-depth backstop
// against a caller that skips the confirmation step.
export async function deleteFaqIfUnlinked(supabase: SupabaseClient, id: string): Promise<{ ok: true } | { ok: false; linkedCount: number }> {
  const { count, error: countErr } = await supabase.from('resource_post_faqs').select('post_id', { count: 'exact', head: true }).eq('faq_id', id);
  if (countErr) throw countErr;
  if ((count ?? 0) > 0) return { ok: false, linkedCount: count ?? 0 };
  const { error } = await supabase.from('resource_faqs').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

// --- Linking (spec §36-37) --------------------------------------------------

export async function linkFaqToPost(supabase: SupabaseClient, faqId: string, postId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: maxRow } = await supabase.from('resource_post_faqs').select('sort_order').eq('post_id', postId).order('sort_order', { ascending: false }).limit(1);
  const nextSort = ((maxRow?.[0]?.sort_order as number | undefined) ?? -1) + 1;
  const { error } = await supabase.from('resource_post_faqs').insert({ post_id: postId, faq_id: faqId, sort_order: nextSort });
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'This FAQ is already linked to that content.' };
    throw error;
  }
  return { ok: true };
}

export async function unlinkFaqFromPost(supabase: SupabaseClient, faqId: string, postId: string): Promise<void> {
  const { error } = await supabase.from('resource_post_faqs').delete().eq('faq_id', faqId).eq('post_id', postId);
  if (error) throw error;
}

// Spec §37: "If the current relationship table supports ordering, allow
// post-specific FAQ order." resource_post_faqs.sort_order already exists —
// reordering is a plain update of the affected rows' sort_order, no new
// schema.
export async function reorderPostFaqs(supabase: SupabaseClient, postId: string, orderedFaqIds: string[]): Promise<void> {
  await Promise.all(
    orderedFaqIds.map((faqId, index) => supabase.from('resource_post_faqs').update({ sort_order: index }).eq('post_id', postId).eq('faq_id', faqId))
  ).then((results) => {
    const firstError = results.find((r) => (r as { error?: unknown }).error);
    if (firstError) throw (firstError as { error: unknown }).error;
  });
}
