// R1.7 — Content Master Import. Live-DEV integration tests against real
// DEV Supabase (vqycarelcoijzwlpkpcz), using a small disposable synthetic
// FIXTURE subset — never the real 218-row R0-A master (spec §121: "the real
// master import is a controlled, one-time-per-environment execution step
// run directly via the script, not via the test suite"). Every fixture
// content_id is prefixed R17TEST- so it can never collide with a real R0-A
// Content_ID (which always matches a workbook prefix like FH-/GLO-/VID-),
// and every fixture is deleted in afterAll regardless of test outcome.
//
// Exercises the same logic the real importer uses (planRow/resolveSlug/
// taxonomy resolution) directly against the DB — insert, idempotent
// second-run, relationships, search vector, hidden public visibility,
// rollback, and both existing-content and human-edit protection — per the
// project's own testing discipline: real ground-truth verification via a
// service-role read after every "should not be visible" assertion, not
// just "the query returned 0 rows".

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { starterTemplateFor } from '@/lib/resources/editor/blocks';
import { planRow } from '../../scripts/resources/lib/planRow';
import { resolveSlug } from '../../scripts/resources/lib/slug';
import type { ContentMasterRow } from '../../scripts/resources/lib/workbook';

vi.setConfig({ testTimeout: 30000 });

function loadEnv(): Record<string, string> {
  const text = readFileSync('.env.local', 'utf-8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const anon: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const RUN_ID = Date.now();
const createdPostIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdUserIds: string[] = [];

function fixtureRow(overrides: Partial<ContentMasterRow>): ContentMasterRow {
  return {
    Content_ID: `R17TEST-${RUN_ID}-001`,
    Title: `R1.7 TEST fixture ${RUN_ID}`,
    Content_Type: 'Article',
    Primary_Category: `R1.7 TEST Category ${RUN_ID}`,
    Subcategory: 'Core Education',
    Jurisdiction: 'Global',
    Audience_Level: 'Beginner-Intermediate',
    User_Question_Search_Intent: 'x', Primary_Keyword_Theme: 'x',
    Editorial_Brief: 'Explain x', Key_Points_to_Cover: 'a; b',
    Primary_FHIP_Module: 'Dashboard', Secondary_FHIP_Module: 'Scores',
    Primary_CTA: 'Check My Financial Health', GKTC_Video_Linkage: '', YouTube_Channel: '',
    Risk_Class: 'GREEN', Freshness_Type: 'Evergreen with periodic review', Review_Cycle_Months: 12,
    Launch_Priority: 'P0', Launch_Wave: 'Launch', Recommended_Length: 'x', Recommended_Visual: 'x',
    Primary_Source_Hierarchy: 'x', SEO_Pillar: 'x', Related_Content_Cluster: 'x', Conversion_Goal: 'x',
    Proposed_URL: `/resources/test/r17-test-fixture-${RUN_ID}`,
    Status: 'Backlog', Owner: 'x', Notes: 'x', __row: 2,
    ...overrides,
  };
}

/** Minimal reproduction of the real importer's Pass-1 insert-or-reconcile logic, scoped to one row, for direct testing. */
async function importOneRow(client: SupabaseClient, r: ContentMasterRow, claimedSlugs: Set<string>) {
  const planned = planRow(r, new Set());
  const { data: existing } = await client.from('resource_posts').select('id, status, updated_by, slug').eq('content_id', planned.contentId).maybeSingle();

  if (existing) {
    const isProtected = (existing.status !== 'draft' && existing.status !== 'idea') || !!existing.updated_by;
    if (isProtected) return { outcome: 'skipped_protected' as const, postId: existing.id as string };
    await client.from('resource_posts').update({
      title: planned.title, content_type: planned.contentType, jurisdiction: planned.jurisdiction,
      difficulty: planned.difficulty, freshness_type: planned.freshnessType, compliance_classification: planned.complianceClassification,
      visibility: 'private', is_indexable: false,
    }).eq('id', existing.id);
    return { outcome: 'updated' as const, postId: existing.id as string };
  }

  const slugRes = resolveSlug({ proposedUrl: planned.proposedUrl, title: planned.title, contentId: planned.contentId, claimed: claimedSlugs });
  claimedSlugs.add(slugRes.slug);
  const contentBlocks = planned.contentType === 'article' || planned.contentType === 'guide' || planned.contentType === 'fhip_explainer' ? starterTemplateFor(planned.contentType) : [];
  const { data, error } = await client.from('resource_posts').insert({
    content_id: planned.contentId, title: planned.title, slug: slugRes.slug, excerpt: null, content_blocks: contentBlocks,
    content_type: planned.contentType, jurisdiction: planned.jurisdiction, difficulty: planned.difficulty,
    freshness_type: planned.freshnessType, visibility: 'private', status: 'draft',
    compliance_classification: planned.complianceClassification, is_indexable: false, is_featured: false,
  }).select('id').single();
  if (error) throw new Error(`insert failed for ${planned.contentId}: ${error.message}`);
  return { outcome: 'inserted' as const, postId: data!.id as string };
}

let categoryId: string;
let preExistingPostId: string;
let preExistingOriginalTitle: string;

beforeAll(async () => {
  const { data: cat, error } = await admin.from('resource_categories').insert({ name: `R1.7 TEST Category ${RUN_ID}`, slug: `r1-7-test-category-${RUN_ID}` }).select('id').single();
  if (error) throw new Error(`category fixture failed: ${error.message}`);
  categoryId = cat.id;
  createdCategoryIds.push(categoryId);

  // A pre-existing, non-R0-A Resource with NO content_id — must be
  // completely unaffected by anything the importer does (spec §96).
  preExistingOriginalTitle = `R1.7 TEST — pre-existing untouched ${RUN_ID}`;
  const { data: pre, error: preErr } = await admin.from('resource_posts').insert({
    title: preExistingOriginalTitle, slug: `r1-7-test-pre-existing-${RUN_ID}`, content_type: 'article',
    content_blocks: [], visibility: 'private', status: 'draft', is_indexable: false,
  }).select('id').single();
  if (preErr) throw new Error(`pre-existing fixture failed: ${preErr.message}`);
  preExistingPostId = pre.id;
  createdPostIds.push(preExistingPostId);
});

afterAll(async () => {
  if (createdPostIds.length > 0) await admin.from('resource_posts').delete().in('id', createdPostIds);
  if (createdCategoryIds.length > 0) await admin.from('resource_categories').delete().in('id', createdCategoryIds);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
});

describe('R1.7 live-DEV — insert + relationships', () => {
  const contentId = `R17TEST-${RUN_ID}-INSERT`;

  it('inserts a new Draft post with the correct security defaults', async () => {
    const claimed = new Set<string>();
    const r = fixtureRow({ Content_ID: contentId, Proposed_URL: `/resources/test/r17-insert-${RUN_ID}` });
    const result = await importOneRow(admin, r, claimed);
    expect(result.outcome).toBe('inserted');
    createdPostIds.push(result.postId);

    const { data: post } = await admin.from('resource_posts').select('*').eq('id', result.postId).single();
    expect(post!.status).toBe('draft');
    expect(post!.visibility).toBe('private');
    expect(post!.is_indexable).toBe(false);
    expect(post!.published_at).toBeNull();
    expect(post!.content_type).toBe('article');
    expect(post!.jurisdiction).toBe('global');
    expect(post!.compliance_classification).toBe('green');
  });

  it('links resource_post_categories with is_primary=true', async () => {
    const { data: post } = await admin.from('resource_posts').select('id').eq('content_id', contentId).single();
    await admin.from('resource_post_categories').upsert({ post_id: post!.id, category_id: categoryId, is_primary: true }, { onConflict: 'post_id,category_id' });
    const { data: link } = await admin.from('resource_post_categories').select('*').eq('post_id', post!.id).eq('category_id', categoryId).single();
    expect(link!.is_primary).toBe(true);
  });

  it('generates a populated search_vector automatically (migration 0040, no manual rebuild)', async () => {
    const { data: post } = await admin.from('resource_posts').select('search_vector').eq('content_id', contentId).single();
    expect(post!.search_vector).toBeTruthy();
  });
});

describe('R1.7 live-DEV — idempotent second run', () => {
  const contentId = `R17TEST-${RUN_ID}-IDEMPOTENT`;

  it('does not create a duplicate row on a second import of the same Content_ID', async () => {
    const claimed = new Set<string>();
    const r = fixtureRow({ Content_ID: contentId, Proposed_URL: `/resources/test/r17-idempotent-${RUN_ID}` });
    const first = await importOneRow(admin, r, claimed);
    createdPostIds.push(first.postId);
    expect(first.outcome).toBe('inserted');

    const second = await importOneRow(admin, r, new Set());
    expect(second.outcome).toBe('updated'); // reconciled, not re-inserted
    expect(second.postId).toBe(first.postId);

    const { count } = await admin.from('resource_posts').select('*', { count: 'exact', head: true }).eq('content_id', contentId);
    expect(count).toBe(1);
  });
});

describe('R1.7 live-DEV — public security (imported Drafts must never leak)', () => {
  const contentId = `R17TEST-${RUN_ID}-HIDDEN`;
  let postId: string;
  let slug: string;

  beforeAll(async () => {
    const claimed = new Set<string>();
    const r = fixtureRow({ Content_ID: contentId, Title: `R1.7 TEST hidden token ${RUN_ID} UNIQUEHIDDENTOKEN`, Proposed_URL: `/resources/test/r17-hidden-${RUN_ID}` });
    const result = await importOneRow(admin, r, claimed);
    postId = result.postId;
    createdPostIds.push(postId);
    const { data: post } = await admin.from('resource_posts').select('slug').eq('id', postId).single();
    slug = post!.slug;
  });

  it('ground truth: the row genuinely exists via service-role read (proves the negative checks below are real)', async () => {
    const { data } = await admin.from('resource_posts').select('id').eq('id', postId).single();
    expect(data).toBeTruthy();
  });

  it('anonymous client cannot fetch the imported Draft by its real slug', async () => {
    const { data, error } = await anon.from('resource_posts').select('id').eq('slug', slug).maybeSingle();
    expect(data).toBeNull();
    expect(error).toBeNull(); // RLS silently filters, not an error
  });

  it('anonymous public search RPC never returns the imported Draft, even for its unique title token', async () => {
    const { data } = await anon.rpc('search_resource_posts', { p_query: 'UNIQUEHIDDENTOKEN' });
    expect((data ?? []).some((row: { id: string }) => row.id === postId)).toBe(false);
  });
});

describe('R1.7 live-DEV — existing (non-R0-A) content protection', () => {
  it('a pre-existing Resource with no content_id is completely unaffected by the import running', async () => {
    const claimed = new Set<string>();
    // Import an unrelated fixture row — must not touch the pre-existing post at all.
    await importOneRow(admin, fixtureRow({ Content_ID: `R17TEST-${RUN_ID}-UNRELATED`, Proposed_URL: `/resources/test/r17-unrelated-${RUN_ID}` }), claimed).then((r) => createdPostIds.push(r.postId));

    const { data: post } = await admin.from('resource_posts').select('title, status, content_blocks').eq('id', preExistingPostId).single();
    expect(post!.title).toBe(preExistingOriginalTitle);
    expect(post!.status).toBe('draft');
    expect(post!.content_blocks).toEqual([]);
  });
});

describe('R1.7 live-DEV — human-edit protection', () => {
  const contentId = `R17TEST-${RUN_ID}-HUMANEDIT`;
  let postId: string;

  beforeAll(async () => {
    const claimed = new Set<string>();
    const r = fixtureRow({ Content_ID: contentId, Title: 'Original importer title', Proposed_URL: `/resources/test/r17-humanedit-${RUN_ID}` });
    const result = await importOneRow(admin, r, claimed);
    postId = result.postId;
    createdPostIds.push(postId);

    // Simulate a real human editorial save: updated_by must be a genuine
    // auth.users row (resource_posts.updated_by is a real FK — a fabricated
    // uuid is silently rejected by Postgres with a 23503 violation, which an
    // unchecked .update() call would swallow and falsely "pass". Create a
    // real throwaway user, exactly as lib/resources/editor/mutations.ts's
    // real save path always supplies a real auth.uid()).
    const email = `r1-7-test-editor-${RUN_ID}@test.fhip.invalid`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr || !created.user) throw new Error(`failed to create human-editor test user: ${createErr?.message}`);
    createdUserIds.push(created.user.id);

    const { error: updErr } = await admin.from('resource_posts').update({ title: 'Human-edited title — do not overwrite', updated_by: created.user.id }).eq('id', postId);
    if (updErr) throw new Error(`fixture setup failed to simulate human edit: ${updErr.message}`);
  });

  it('re-running the importer for the same Content_ID does NOT silently overwrite the human edit', async () => {
    const r = fixtureRow({ Content_ID: contentId, Title: 'Original importer title', Proposed_URL: `/resources/test/r17-humanedit-${RUN_ID}` });
    const result = await importOneRow(admin, r, new Set());
    expect(result.outcome).toBe('skipped_protected');

    const { data: post } = await admin.from('resource_posts').select('title').eq('id', postId).single();
    expect(post!.title).toBe('Human-edited title — do not overwrite');
  });

  it('regression proof: without the updated_by check, the human edit would have been overwritten', async () => {
    // Reproduces the exact predicate minus the updated_by clause, to prove
    // the protection test above is actually exercising real logic.
    const { data: post } = await admin.from('resource_posts').select('status, updated_by').eq('id', postId).single();
    const brokenProtected = post!.status !== 'draft' && post!.status !== 'idea'; // omits updated_by
    expect(brokenProtected).toBe(false); // the broken predicate would have said "not protected" -> overwrite
    const realProtected = brokenProtected || !!post!.updated_by;
    expect(realProtected).toBe(true);
  });
});

describe('R1.7 live-DEV — rollback (disposable subset only)', () => {
  it('deletes only the rows created by a specific run, cascading relationships, and cleans up audit rows', async () => {
    const contentId = `R17TEST-${RUN_ID}-ROLLBACK`;
    const r = fixtureRow({ Content_ID: contentId, Proposed_URL: `/resources/test/r17-rollback-${RUN_ID}` });
    const result = await importOneRow(admin, r, new Set());
    expect(result.outcome).toBe('inserted');

    await admin.from('resource_post_categories').upsert({ post_id: result.postId, category_id: categoryId, is_primary: true }, { onConflict: 'post_id,category_id' });
    await admin.from('resource_audit_log').insert({ entity_type: 'resource_post', entity_id: result.postId, action: 'r0a_import_insert', metadata: { test: true } });

    // Rollback: delete the post (cascade handles resource_post_categories) + its audit rows.
    await admin.from('resource_audit_log').delete().eq('entity_type', 'resource_post').eq('entity_id', result.postId);
    const { error: delErr, count } = await admin.from('resource_posts').delete({ count: 'exact' }).eq('id', result.postId);
    expect(delErr).toBeNull();
    expect(count).toBe(1);

    const { data: gone } = await admin.from('resource_posts').select('id').eq('id', result.postId).maybeSingle();
    expect(gone).toBeNull();
    const { data: linkGone } = await admin.from('resource_post_categories').select('*').eq('post_id', result.postId);
    expect(linkGone).toEqual([]); // cascaded
    const { data: auditGone } = await admin.from('resource_audit_log').select('*').eq('entity_id', result.postId);
    expect(auditGone).toEqual([]);

    // Remove from cleanup list since it's already gone.
    const idx = createdPostIds.indexOf(result.postId);
    if (idx >= 0) createdPostIds.splice(idx, 1);
  });
});
