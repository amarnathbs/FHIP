// R1.4 Glossary mutation layer — spec §26-31, §99-101.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizePlainText } from '@/lib/resources/editor/sanitize';
import { updateResourceDraft, type SaveOutcome, type SaveDraftParams } from '@/lib/resources/editor/mutations';
import { updateResourcePostExtraColumns } from '@/lib/resources/specialist/mutations';
import type { EditorSavePatch } from '@/lib/resources/editor/types';

export interface CreateGlossaryResult {
  id: string;
}

export async function createGlossaryDraft(supabase: SupabaseClient, userId: string): Promise<CreateGlossaryResult> {
  const { data, error } = await supabase
    .from('resource_posts')
    .insert({
      title: 'Untitled Glossary Term',
      content_type: 'glossary',
      status: 'draft',
      compliance_classification: 'green',
      jurisdiction: 'global',
      freshness_type: 'evergreen',
      visibility: 'private',
      is_indexable: false,
      content_blocks: [],
      aliases: [],
      created_by: userId,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export interface SaveGlossaryParams {
  patch: EditorSavePatch;
  aliases: string[];
  relatedTermIds: string[];
  categoryIds: string[];
  tagIds: string[];
  expectedUpdatedAt: string;
  userId: string;
  createVersion?: boolean;
  changeSummary?: string | null;
  versionSnapshot?: SaveDraftParams['versionSnapshot'];
}

// Exported for unit testing (spec §113: "Glossary... alias normalisation").
export function normalizeAliases(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw) {
    const cleaned = sanitizePlainText(a, 100).trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

export async function updateGlossaryDraft(supabase: SupabaseClient, postId: string, params: SaveGlossaryParams): Promise<SaveOutcome> {
  const outcome = await updateResourceDraft(supabase, postId, {
    patch: params.patch,
    categoryIds: params.categoryIds,
    tagIds: params.tagIds,
    expectedUpdatedAt: params.expectedUpdatedAt,
    userId: params.userId,
    createVersion: params.createVersion,
    changeSummary: params.changeSummary,
    versionSnapshot: params.versionSnapshot,
  });
  if (outcome.status !== 'ok') return outcome;

  await updateResourcePostExtraColumns(supabase, postId, { aliases: normalizeAliases(params.aliases) });

  // Related terms sync (spec §30: relationships, delete-then-insert — same
  // documented non-atomicity pattern as taxonomy sync in R1.3's
  // updateResourceDraft). Self-reference and duplicate pairs are guarded by
  // resource_related_content's own DB constraints regardless (belt+braces);
  // this also strips the post's own id client-side so a stray self-select in
  // the UI never even reaches the DB as an error.
  const relatedIds = Array.from(new Set(params.relatedTermIds.filter((id) => id && id !== postId)));
  const { error: delErr } = await supabase.from('resource_related_content').delete().eq('source_post_id', postId).eq('relationship_type', 'related');
  if (delErr) throw delErr;
  if (relatedIds.length > 0) {
    const { error: insErr } = await supabase
      .from('resource_related_content')
      .insert(relatedIds.map((id) => ({ source_post_id: postId, related_post_id: id, relationship_type: 'related' as const })));
    if (insErr) throw insErr;
  }

  return outcome;
}
