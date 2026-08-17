// R1.3 mutation layer — spec §99-101. Every Supabase write used by the
// editor API routes lives here, not scattered across route handlers or UI
// components (spec §99: "Do not spread direct Supabase mutations across UI
// components"). Every function takes the caller's own request-scoped,
// RLS-authenticated client (spec §97/§98) — never service-role. status/the
// four approval columns/scheduled_at/published_at are never written here;
// see lib/resources/workflow.ts for the one sanctioned path for those
// (spec §65).
//
// Atomicity note (spec §100): resource_posts, resource_post_categories,
// resource_post_tags and resource_post_versions are written as separate
// sequential Supabase calls, not inside one DB transaction/RPC. This
// project's Supabase access is PostgREST-only (no linked CLI/direct
// Postgres connection — see docs/resources/R1.1-database-foundation.md
// §"Applying the migrations"), which makes writing and *testing* a new
// multi-statement RPC materially riskier in this environment than the
// sequential-calls approach: a bug in an untested SQL function that this
// session cannot execute or iterate on directly (DDL can only be applied by
// pasting into the Supabase Dashboard SQL editor, per that same doc) is a
// worse failure mode than a documented, narrow non-atomicity window. The
// accepted risk is scoped and non-corrupting: if the post-row UPDATE
// succeeds but a taxonomy write then fails, the post's own fields are
// correct and saved; only the category/tag *links* may be stale until the
// next successful save (self-heals, and never a security or data-integrity
// issue — no constraint depends on this being atomic). This is documented
// here and in the R1.3 completion report's Technical Debt section rather
// than silently accepted.

import type { SupabaseClient } from '@supabase/supabase-js';
import { starterTemplateFor } from './blocks';
import { sanitizeBlocks, sanitizePlainText } from './sanitize';
import type { EditableContentType, EditorSavePatch, PostVersionSnapshot } from './types';

export interface CreateDraftResult {
  id: string;
}

// Draft creation (spec §12/§13). Every default matches the spec's initial
// field list exactly. `title` is not in that list, but resource_posts.title
// is NOT NULL at the DB level (migration 0033) — a friendly, obviously-a-
// placeholder default is used so the chooser can create-and-redirect
// immediately, with the title editable as the very first thing the author
// sees in the editor.
export async function createResourceDraft(supabase: SupabaseClient, contentType: EditableContentType, userId: string): Promise<CreateDraftResult> {
  const titlePlaceholder: Record<EditableContentType, string> = {
    article: 'Untitled Article',
    guide: 'Untitled Guide',
    fhip_explainer: 'Untitled FHIP Explainer',
  };

  const { data, error } = await supabase
    .from('resource_posts')
    .insert({
      title: titlePlaceholder[contentType],
      content_type: contentType,
      status: 'draft',
      compliance_classification: 'green',
      jurisdiction: 'global',
      freshness_type: 'evergreen',
      visibility: 'private', // §13: never publicly readable by default
      is_indexable: false, // §12: until publish readiness
      content_blocks: starterTemplateFor(contentType),
      created_by: userId,
      updated_by: userId,
    })
    .select('id')
    .single();

  if (error) throw error;
  return { id: data.id as string };
}

export type SaveOutcome = { status: 'ok'; post: Record<string, unknown> } | { status: 'conflict' } | { status: 'not_found' };

export interface SaveDraftParams {
  patch: EditorSavePatch;
  categoryIds: string[]; // additional categories (not including primary)
  tagIds: string[];
  expectedUpdatedAt: string;
  userId: string;
  createVersion?: boolean;
  changeSummary?: string | null;
  versionSnapshot?: PostVersionSnapshot;
}

function sanitizePatch(patch: EditorSavePatch): EditorSavePatch {
  return {
    ...patch,
    title: sanitizePlainText(patch.title, 300),
    excerpt: patch.excerpt ? sanitizePlainText(patch.excerpt, 500) : patch.excerpt,
    content_blocks: sanitizeBlocks(patch.content_blocks),
    seo_title: patch.seo_title ? sanitizePlainText(patch.seo_title, 300) : patch.seo_title,
    seo_description: patch.seo_description ? sanitizePlainText(patch.seo_description, 400) : patch.seo_description,
    canonical_url: patch.canonical_url ? sanitizePlainText(patch.canonical_url, 500) : patch.canonical_url,
  };
}

// Updates the post row's ordinary content columns (optimistic-concurrency
// guarded, spec §41), then best-effort syncs taxonomy join rows, then
// optionally writes a revision snapshot (spec §43-45). Never touches
// status/approval columns — those columns aren't even in the authenticated
// UPDATE grant (migration 0033/0037), so attempting to set them here would
// simply be silently ignored by PostgREST; they are intentionally absent
// from EditorSavePatch entirely so that can't happen by omission.
export async function updateResourceDraft(supabase: SupabaseClient, postId: string, params: SaveDraftParams): Promise<SaveOutcome> {
  const patch = sanitizePatch(params.patch);

  const { data: updated, error: updateErr } = await supabase
    .from('resource_posts')
    .update({
      title: patch.title,
      slug: patch.slug || null,
      excerpt: patch.excerpt || null,
      content_blocks: patch.content_blocks,
      jurisdiction: patch.jurisdiction,
      difficulty: patch.difficulty,
      freshness_type: patch.freshness_type,
      visibility: patch.visibility,
      compliance_classification: patch.compliance_classification,
      primary_category_id: patch.primary_category_id,
      author_id: patch.author_id,
      reviewer_id: patch.reviewer_id,
      compliance_reviewer_id: patch.compliance_reviewer_id,
      expires_at: patch.expires_at,
      next_review_at: patch.next_review_at,
      seo_title: patch.seo_title || null,
      seo_description: patch.seo_description || null,
      canonical_url: patch.canonical_url || null,
      is_indexable: patch.is_indexable,
      primary_cta_id: patch.primary_cta_id,
      secondary_cta_id: patch.secondary_cta_id,
      updated_by: params.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', postId)
    .eq('updated_at', params.expectedUpdatedAt)
    .select('id')
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updated) {
    // Either a genuinely stale write (another editor saved since this
    // client loaded the post — spec §41), or the row doesn't exist / isn't
    // visible under RLS. Distinguish so the UI shows the right message.
    const { data: exists } = await supabase.from('resource_posts').select('id').eq('id', postId).maybeSingle();
    return exists ? { status: 'conflict' } : { status: 'not_found' };
  }

  // Taxonomy sync — delete-then-insert (see file header re: atomicity).
  const categoryIds = Array.from(new Set(params.categoryIds.filter(Boolean)));
  const primaryId = patch.primary_category_id;
  const { error: delCatErr } = await supabase.from('resource_post_categories').delete().eq('post_id', postId);
  if (delCatErr) throw delCatErr;
  const categoryRows = [
    ...(primaryId ? [{ post_id: postId, category_id: primaryId, is_primary: true }] : []),
    ...categoryIds.filter((id) => id !== primaryId).map((id) => ({ post_id: postId, category_id: id, is_primary: false })),
  ];
  if (categoryRows.length > 0) {
    const { error: insCatErr } = await supabase.from('resource_post_categories').insert(categoryRows);
    if (insCatErr) throw insCatErr;
  }

  const tagIds = Array.from(new Set(params.tagIds.filter(Boolean)));
  const { error: delTagErr } = await supabase.from('resource_post_tags').delete().eq('post_id', postId);
  if (delTagErr) throw delTagErr;
  if (tagIds.length > 0) {
    const { error: insTagErr } = await supabase.from('resource_post_tags').insert(tagIds.map((id) => ({ post_id: postId, tag_id: id })));
    if (insTagErr) throw insTagErr;
  }

  if (params.createVersion && params.versionSnapshot) {
    await createResourceVersion(supabase, postId, params.versionSnapshot, params.userId, params.changeSummary ?? null);
  }

  const { data: fresh, error: freshErr } = await supabase.from('resource_posts').select('*').eq('id', postId).single();
  if (freshErr) throw freshErr;
  return { status: 'ok', post: fresh as never };
}

// Revision snapshot (spec §43-45). Not triggered on every autosave — the
// caller (the PATCH route) decides createVersion based on the save's origin
// (first save, manual Save, workflow submission, pre-publish save — never
// bare autosave). version_number is computed client-side-of-the-DB (a
// SELECT max() then INSERT) rather than a DB sequence/trigger, matching
// R1.1's stated reason for not adding an automatic snapshot trigger (spec
// §36 in the migration: change_summary has no sensible default, so
// snapshot-taking has to be caller-driven either way). A unique constraint
// (uq_resource_post_versions on (post_id, version_number), migration 0033)
// is the real collision guard; on the rare concurrent-save race this
// retries once with a recomputed number rather than failing the whole save.
export async function createResourceVersion(supabase: SupabaseClient, postId: string, snapshot: PostVersionSnapshot, userId: string, changeSummary: string | null, attempt = 0): Promise<void> {
  const { data: existing, error: maxErr } = await supabase.from('resource_post_versions').select('version_number').eq('post_id', postId).order('version_number', { ascending: false }).limit(1);
  if (maxErr) throw maxErr;
  const nextVersion = ((existing?.[0]?.version_number as number | undefined) ?? 0) + 1;

  const { error: insErr } = await supabase.from('resource_post_versions').insert({
    post_id: postId,
    version_number: nextVersion,
    snapshot,
    change_summary: changeSummary || null,
    created_by: userId,
  });

  if (insErr) {
    if (insErr.code === '23505' && attempt < 2) {
      // Unique-constraint collision — another save landed a version between
      // our SELECT and INSERT. Retry once/twice with a fresh number.
      return createResourceVersion(supabase, postId, snapshot, userId, changeSummary, attempt + 1);
    }
    throw insErr;
  }
}

// Derives SEO title/description fallbacks (spec §37: "SEO title or a
// defined fallback"). Applied by the API route just before publish-gate
// validation runs, not persisted into the actual seo_title/seo_description
// columns unless the author explicitly filled them in — so the editor never
// silently overwrites a blank SEO field with a guess the author didn't ask
// for.
export function deriveSeoFallback(title: string, excerpt: string | null): { seoTitle: string; seoDescription: string } {
  return {
    seoTitle: title.slice(0, 60),
    seoDescription: (excerpt ?? '').slice(0, 160),
  };
}
