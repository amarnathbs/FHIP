// R1.4 Money Update mutation layer — spec §40-49, §99-101.

import type { SupabaseClient } from '@supabase/supabase-js';
import { updateResourceDraft, type SaveOutcome, type SaveDraftParams } from '@/lib/resources/editor/mutations';
import { updateResourcePostExtraColumns } from '@/lib/resources/specialist/mutations';
import { syncPostSources } from '@/lib/resources/sources/mutations';
import { sanitizePlainText } from '@/lib/resources/editor/sanitize';
import { starterTemplateForMoneyUpdate, starterTemplateForMoneyUpdateTemplate } from './blocks';
import type { EditorSavePatch } from '@/lib/resources/editor/types';
import type { MoneyUpdateContentType } from './types';

export interface CreateMoneyUpdateResult {
  id: string;
}

export async function createMoneyUpdateDraft(supabase: SupabaseClient, contentType: MoneyUpdateContentType, userId: string): Promise<CreateMoneyUpdateResult> {
  const titlePlaceholder = contentType === 'money_update_template' ? 'Untitled Money Update Template' : 'Untitled Money Update';
  const blocks = contentType === 'money_update_template' ? starterTemplateForMoneyUpdateTemplate() : starterTemplateForMoneyUpdate();

  const { data, error } = await supabase
    .from('resource_posts')
    .insert({
      title: titlePlaceholder,
      content_type: contentType,
      status: 'draft',
      compliance_classification: 'green',
      jurisdiction: 'global',
      // Money Updates are inherently time-sensitive by default (spec §46);
      // a Template is structural, not itself time-sensitive content.
      freshness_type: contentType === 'money_update_template' ? 'evergreen' : 'time_sensitive',
      visibility: 'private',
      is_indexable: false,
      content_blocks: blocks,
      created_by: userId,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export interface SaveMoneyUpdateParams {
  patch: EditorSavePatch;
  eventDate: string | null;
  affectedAudience: string;
  sourceIds: string[];
  categoryIds: string[];
  tagIds: string[];
  expectedUpdatedAt: string;
  userId: string;
  createVersion?: boolean;
  changeSummary?: string | null;
  versionSnapshot?: SaveDraftParams['versionSnapshot'];
}

export async function updateMoneyUpdateDraft(supabase: SupabaseClient, postId: string, params: SaveMoneyUpdateParams): Promise<SaveOutcome> {
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

  await updateResourcePostExtraColumns(supabase, postId, {
    event_date: params.eventDate,
    affected_audience: sanitizePlainText(params.affectedAudience, 300) || null,
  });

  await syncPostSources(supabase, postId, params.sourceIds);

  return outcome;
}

// Spec §45: "Create Update from Template." Copies structure only — content
// blocks, jurisdiction, compliance defaults, primary category, tags — into a
// brand-new Draft money_update post with its own id/slug. Never modifies the
// template itself (a plain SELECT of the template, then a fresh INSERT).
export async function createMoneyUpdateFromTemplate(supabase: SupabaseClient, templateId: string, userId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data: template, error: templateErr } = await supabase
    .from('resource_posts')
    .select('title, content_blocks, jurisdiction, compliance_classification, primary_category_id')
    .eq('id', templateId)
    .eq('content_type', 'money_update_template')
    .maybeSingle();
  if (templateErr) throw templateErr;
  if (!template) return { ok: false, error: 'Template not found.' };

  const { data: tagLinks } = await supabase.from('resource_post_tags').select('tag_id').eq('post_id', templateId);

  const { data: created, error: createErr } = await supabase
    .from('resource_posts')
    .insert({
      title: `Untitled Money Update (from ${template.title})`,
      content_type: 'money_update',
      status: 'draft',
      compliance_classification: template.compliance_classification,
      jurisdiction: template.jurisdiction,
      freshness_type: 'time_sensitive',
      visibility: 'private',
      is_indexable: false,
      content_blocks: template.content_blocks,
      primary_category_id: template.primary_category_id,
      created_by: userId,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (createErr) return { ok: false, error: 'Could not create a Money Update from this template.' };

  const tagIds = ((tagLinks ?? []) as { tag_id: string }[]).map((t) => t.tag_id);
  if (tagIds.length > 0) {
    await supabase.from('resource_post_tags').insert(tagIds.map((tagId) => ({ post_id: created.id, tag_id: tagId })));
  }

  return { ok: true, id: created.id as string };
}
