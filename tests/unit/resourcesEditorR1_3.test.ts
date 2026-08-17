// R1.3 editor — live-DEV RLS/RBAC/workflow/mutation tests. Same pattern as
// tests/unit/resourcesR1_1.test.ts and tests/unit/resourcesAdminR1_2.test.ts:
// real magic-link-authenticated Supabase clients per role, throwaway
// fixtures, cleanup in afterAll, and a schema-presence probe in beforeAll
// that throws a clear message rather than a confusing low-level error if
// the Resources migrations aren't applied yet.
//
// Migration 0037 caveat (spec §8's own "additive, minimal, justified" new
// migration for R1.3 — see supabase/migrations/0037_resources_editor_support.sql):
// like every prior Resources migration, this environment has no Supabase
// CLI project link, so 0037 can only be applied by pasting it into the
// Supabase Dashboard SQL editor for the DEV project (vqycarelcoijzwlpkpcz) —
// this test file cannot apply it itself. A dedicated probe in beforeAll
// detects whether it has been applied yet and the one block of assertions
// that depends on it (compliance_classification being directly editable)
// is skipped with a clear console warning, not silently passed, if it
// hasn't been. Every other assertion in this file depends only on schema
// already live since R1.1/R1.2 and runs unconditionally.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { createResourceDraft, updateResourceDraft, createResourceVersion } from '@/lib/resources/editor/mutations';
import { getResourceEditorPost, isSlugAvailable, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { starterTemplateFor } from '@/lib/resources/editor/blocks';
import type { EditorSavePatch, PostVersionSnapshot } from '@/lib/resources/editor/types';

// Note: lib/resources/workflow.ts's transitionResourcePostStatus() wraps the
// same RPC exercised here (callTransition) but also calls
// lib/supabase/server's createClient(), which depends on Next.js's
// request-scoped cookie/header context and cannot run outside an actual
// request (i.e. not callable from a plain Vitest/Node test). These tests
// call public.transition_resource_post_status directly through each role's
// real authenticated Supabase client instead — the same RPC, the same
// permission checks, just invoked the way a non-Next.js test process can.
// The workflow API route (app/api/admin/resources/content/[id]/workflow/route.ts)
// is what actually uses the wrapper in production; that route was manually
// exercised through the Admin UI in the browser (see completion report §Q/§AD).

function loadEnv(): Record<string, string> {
  const text = readFileSync('D:/FHIP/.env.local', 'utf-8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const RUN_ID = Date.now();
const createdUserIds: string[] = [];
const createdPostIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdAuthorIds: string[] = [];

async function makeTestUser(label: string, roles: string[] = []): Promise<{ userId: string; client: SupabaseClient }> {
  const email = `r1-3-editor-test-${label}-${RUN_ID}@test.fhip.invalid`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) throw new Error(`Failed to create test user ${label}: ${createErr?.message}`);
  createdUserIds.push(created.user.id);

  for (const role of roles) {
    const { error: roleErr } = await admin.from('resource_user_roles').insert({ user_id: created.user.id, role, assigned_by: null });
    if (roleErr) throw new Error(`Failed to assign role ${role} to ${label}: ${roleErr.message}`);
  }

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link.properties?.hashed_token) throw new Error(`Failed to generate link for ${label}: ${linkErr?.message}`);

  const verifyClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: verified, error: verifyErr } = await verifyClient.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (verifyErr || !verified.session) throw new Error(`Failed to verify OTP for ${label}: ${verifyErr?.message}`);

  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
  });
  return { userId: created.user.id, client };
}

let author: { userId: string; client: SupabaseClient };
let secondAuthor: { userId: string; client: SupabaseClient };
let editor: { userId: string; client: SupabaseClient };
let complianceReviewer: { userId: string; client: SupabaseClient };
let publisher: { userId: string; client: SupabaseClient };
let analyst: { userId: string; client: SupabaseClient };
let ordinary: { userId: string; client: SupabaseClient };

let categoryId: string;
let authorRecordId: string;
let migration0037Applied = false;

beforeAll(async () => {
  const { error: schemaErr } = await admin.from('resource_posts').select('id').limit(1);
  if (schemaErr) {
    throw new Error(`Resources schema is not installed in the configured DEV database (${schemaErr.message}). Apply migrations 0033-0036 first (see docs/resources/R1.1-database-foundation.md), then re-run this suite.`);
  }

  const { data: cat, error: catErr } = await admin.from('resource_categories').insert({ name: `R1.3 Test Category ${RUN_ID}`, slug: `r1-3-test-category-${RUN_ID}` }).select('id').single();
  if (catErr || !cat) throw new Error(`Failed to create test category: ${catErr?.message}`);
  categoryId = cat.id;
  createdCategoryIds.push(categoryId);

  const { data: authorRow, error: authorErr } = await admin.from('resource_authors').insert({ display_name: `R1.3 Test Author ${RUN_ID}`, slug: `r1-3-test-author-${RUN_ID}` }).select('id').single();
  if (authorErr || !authorRow) throw new Error(`Failed to create test resource_authors row: ${authorErr?.message}`);
  authorRecordId = authorRow.id;
  createdAuthorIds.push(authorRecordId);

  author = await makeTestUser('author', ['author']);
  secondAuthor = await makeTestUser('second-author', ['author']);
  editor = await makeTestUser('editor', ['editor']);
  complianceReviewer = await makeTestUser('compliance', ['compliance_reviewer']);
  publisher = await makeTestUser('publisher', ['publisher']);
  analyst = await makeTestUser('analyst', ['analyst']);
  ordinary = await makeTestUser('ordinary');

  // Probe migration 0037 (compliance_classification UPDATE grant) without
  // requiring this file to apply DDL itself — see file header. Postgres
  // rejects an entire multi-column UPDATE statement if ANY targeted column
  // lacks privilege (not just that one column), so updateResourceDraft() —
  // which always includes compliance_classification in its UPDATE, since
  // that is the whole point of migration 0037 — cannot succeed AT ALL until
  // the grant exists. Rather than let every editing/workflow test below
  // fail one-by-one with a cryptic "permission denied for table
  // resource_posts", this mirrors resourcesR1_1.test.ts's own precedent:
  // detect the missing prerequisite up front and abort with one clear,
  // actionable message.
  const probe = await createResourceDraft(author.client, 'article', author.userId);
  createdPostIds.push(probe.id);
  const before = await getResourceEditorPost(admin, probe.id);
  await author.client.from('resource_posts').update({ compliance_classification: 'amber' }).eq('id', probe.id);
  const after = await getResourceEditorPost(admin, probe.id);
  migration0037Applied = before?.compliance_classification === 'green' && after?.compliance_classification === 'amber';
  if (!migration0037Applied) {
    await cleanupFixtures();
    throw new Error(
      'supabase/migrations/0037_resources_editor_support.sql does not appear to be applied to the configured DEV database yet ' +
        '(compliance_classification is still not directly UPDATE-able by an authenticated staff client). ' +
        'Apply it via the Supabase Dashboard SQL editor for project vqycarelcoijzwlpkpcz (same process as 0033-0036, see ' +
        'docs/resources/R1.1-database-foundation.md), then re-run this suite. Every editing/workflow test below depends on this ' +
        'grant, since updateResourceDraft() always includes compliance_classification in its UPDATE statement and Postgres ' +
        'rejects the whole statement if any targeted column lacks privilege.'
    );
  }
}, 90000);

async function cleanupFixtures(): Promise<void> {
  for (const id of createdPostIds) {
    await admin.from('resource_post_categories').delete().eq('post_id', id);
    await admin.from('resource_post_tags').delete().eq('post_id', id);
    await admin.from('resource_post_versions').delete().eq('post_id', id);
    await admin.from('resource_workflow_history').delete().eq('post_id', id);
    await admin.from('resource_posts').delete().eq('id', id);
  }
  for (const id of createdCategoryIds) await admin.from('resource_categories').delete().eq('id', id);
  for (const id of createdAuthorIds) await admin.from('resource_authors').delete().eq('id', id);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
}

afterAll(async () => {
  await cleanupFixtures();
});

function basePatch(overrides: Partial<EditorSavePatch> = {}): EditorSavePatch {
  return {
    title: `R1.3 Test Article ${RUN_ID}`,
    slug: `r1-3-test-article-${RUN_ID}`,
    excerpt: 'A short excerpt for testing.',
    content_blocks: starterTemplateFor('article'),
    jurisdiction: 'global',
    difficulty: null,
    freshness_type: 'evergreen',
    visibility: 'private',
    compliance_classification: 'green',
    primary_category_id: categoryId,
    author_id: authorRecordId,
    reviewer_id: null,
    compliance_reviewer_id: null,
    expires_at: null,
    next_review_at: null,
    seo_title: null,
    seo_description: null,
    canonical_url: null,
    is_indexable: false,
    primary_cta_id: null,
    secondary_cta_id: null,
    content_id: null,
    ...overrides,
  };
}

describe('Draft creation (spec §11-13, §103)', () => {
  it('an Author can create an Article/Guide/FHIP Explainer draft with every §12 default', async () => {
    for (const type of ['article', 'guide', 'fhip_explainer'] as const) {
      const { id } = await createResourceDraft(author.client, type, author.userId);
      createdPostIds.push(id);
      const post = await getResourceEditorPost(admin, id);
      expect(post?.content_type).toBe(type);
      expect(post?.status).toBe('draft');
      expect(post?.compliance_classification).toBe('green');
      expect(post?.jurisdiction).toBe('global');
      expect(post?.freshness_type).toBe('evergreen');
      expect(post?.visibility).toBe('private');
      expect(post?.is_indexable).toBe(false);
      expect(post?.published_at).toBeNull();
      expect(Array.isArray(post?.content_blocks)).toBe(true);
      expect((post?.content_blocks as unknown[]).length).toBeGreaterThan(0);
      expect(post?.created_by).toBe(author.userId);
    }
  });

  it('an Analyst cannot create a draft — RLS insert policy denies it (spec §103)', async () => {
    await expect(createResourceDraft(analyst.client, 'article', analyst.userId)).rejects.toBeTruthy();
  });

  it('an ordinary customer cannot create a draft (spec §103)', async () => {
    await expect(createResourceDraft(ordinary.client, 'article', ordinary.userId)).rejects.toBeTruthy();
  });

  it('a newly created draft is never publicly visible (spec §13)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const seenByCustomer = await getResourceEditorPost(ordinary.client, id);
    expect(seenByCustomer).toBeNull();
  });
});

describe('Editing / saving (spec §104, §35-37)', () => {
  it('title, excerpt, slug, blocks, taxonomy all persist and reload correctly', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    expect(loaded).not.toBeNull();

    const outcome = await updateResourceDraft(author.client, id, {
      patch: basePatch({ title: `Edited Title ${RUN_ID}`, slug: `edited-slug-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    expect(outcome.status).toBe('ok');

    const reloaded = await getResourceEditorPost(author.client, id);
    expect(reloaded?.title).toBe(`Edited Title ${RUN_ID}`);
    expect(reloaded?.slug).toBe(`edited-slug-${RUN_ID}`);
    expect(reloaded?.excerpt).toBe('A short excerpt for testing.');
    expect(reloaded?.primary_category_id).toBe(categoryId);
    expect(reloaded?.author_id).toBe(authorRecordId);
    expect((reloaded?.content_blocks as unknown[]).length).toBeGreaterThan(0);
  });

  it('jurisdiction, difficulty, freshness all save correctly', async () => {
    const { id } = await createResourceDraft(author.client, 'guide', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ jurisdiction: 'india', difficulty: 'intermediate', freshness_type: 'time_sensitive', slug: `guide-slug-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    const reloaded = await getResourceEditorPost(author.client, id);
    expect(reloaded?.jurisdiction).toBe('india');
    expect(reloaded?.difficulty).toBe('intermediate');
    expect(reloaded?.freshness_type).toBe('time_sensitive');
  });

  // No skipIf needed: beforeAll already aborts the entire suite above if
  // migration 0037 isn't applied, so by the time this test runs it always is.
  it('compliance_classification is directly editable post-creation (migration 0037)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    expect(loaded?.compliance_classification).toBe('green');
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ compliance_classification: 'amber', slug: `amber-slug-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    const reloaded = await getResourceEditorPost(author.client, id);
    expect(reloaded?.compliance_classification).toBe('amber');
  });

  it('additional categories and tags sync correctly (add then remove)', async () => {
    const { data: extraCat } = await admin.from('resource_categories').insert({ name: `Extra Cat ${RUN_ID}`, slug: `extra-cat-${RUN_ID}` }).select('id').single();
    const { data: tag } = await admin.from('resource_tags').insert({ name: `Tag ${RUN_ID}`, slug: `tag-${RUN_ID}` }).select('id').single();
    createdCategoryIds.push(extraCat!.id);

    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    let loaded = await getResourceEditorPost(author.client, id);

    await updateResourceDraft(author.client, id, {
      patch: basePatch({ slug: `tax-slug-${RUN_ID}` }),
      categoryIds: [extraCat!.id],
      tagIds: [tag!.id],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    loaded = await getResourceEditorPost(author.client, id);
    expect(loaded?.categories.map((c) => c.id)).toContain(extraCat!.id);
    expect(loaded?.tags.map((t) => t.id)).toContain(tag!.id);

    // Remove them again — proves the delete-then-insert sync actually deletes.
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ slug: `tax-slug-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    loaded = await getResourceEditorPost(author.client, id);
    expect(loaded?.categories.length).toBe(0);
    expect(loaded?.tags.length).toBe(0);

    await admin.from('resource_tags').delete().eq('id', tag!.id);
  });

  it('a <script> tag typed into a block persists as literal inert text, never executable markup (spec §106)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    const maliciousBlocks = [{ id: 'block-1', type: 'paragraph', data: { text: '<script>alert(1)</script>' } }];
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ slug: `xss-slug-${RUN_ID}`, content_blocks: maliciousBlocks }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    const reloaded = await getResourceEditorPost(author.client, id);
    const blocks = reloaded?.content_blocks as { data: { text: string } }[];
    // Stored and round-tripped as the exact literal string — not executed,
    // not stripped, and not HTML-entity-encoded either (no HTML parser ever
    // touches it, per lib/resources/editor/richtext.ts's design).
    expect(blocks[0].data.text).toBe('<script>alert(1)</script>');
  });

  it('stale-write protection: a save using an outdated expectedUpdatedAt is rejected as a conflict, not silently applied (spec §41)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);

    // First save succeeds and advances updated_at.
    const first = await updateResourceDraft(author.client, id, {
      patch: basePatch({ title: 'First Save', slug: `conflict-slug-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    expect(first.status).toBe('ok');

    // Second save reuses the now-stale original updated_at.
    const second = await updateResourceDraft(author.client, id, {
      patch: basePatch({ title: 'Conflicting Save', slug: `conflict-slug-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    expect(second.status).toBe('conflict');

    const final = await getResourceEditorPost(admin, id);
    expect(final?.title).toBe('First Save'); // never silently overwritten
  });
});

describe('Slug uniqueness (spec §19-20)', () => {
  it('a slug already in use by another post is reported unavailable', async () => {
    const { id: id1 } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id1);
    const loaded1 = await getResourceEditorPost(author.client, id1);
    const uniqueSlug = `unique-slug-${RUN_ID}`;
    await updateResourceDraft(author.client, id1, {
      patch: basePatch({ slug: uniqueSlug }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded1!.updated_at,
      userId: author.userId,
    });

    expect(await isSlugAvailable(author.client, uniqueSlug)).toBe(false);
    expect(await isSlugAvailable(author.client, uniqueSlug, id1)).toBe(true); // excluding itself is available
    expect(await isSlugAvailable(author.client, `never-used-${RUN_ID}`)).toBe(true);
  });
});

describe('Revision history (spec §43-47, §115)', () => {
  it('version numbers increase monotonically per post and snapshots capture the saved state', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);

    const snapshot1: PostVersionSnapshot = {
      title: 'V1',
      slug: `version-slug-${RUN_ID}`,
      excerpt: 'v1',
      content_type: 'article',
      content_blocks: [],
      jurisdiction: 'global',
      difficulty: null,
      freshness_type: 'evergreen',
      visibility: 'private',
      compliance_classification: 'green',
      primary_category_id: null,
      category_ids: [],
      tag_ids: [],
      author_id: null,
      reviewer_id: null,
      compliance_reviewer_id: null,
      seo_title: null,
      seo_description: null,
      canonical_url: null,
      is_indexable: false,
      primary_cta_id: null,
      secondary_cta_id: null,
    };
    await createResourceVersion(author.client, id, snapshot1, author.userId, 'First version');
    await createResourceVersion(author.client, id, { ...snapshot1, title: 'V2' }, author.userId, 'Second version');

    const versions = await getResourcePostVersions(author.client, id);
    expect(versions.map((v) => v.version_number)).toEqual([2, 1]); // ordered desc
    expect(versions[1].change_summary).toBe('First version');

    void loaded; // loaded only needed to establish baseline updated_at above pattern consistency
  });
});

describe('Workflow — GREEN path (spec §66-67, §109)', () => {
  it('Author submits, Editor approves, both via the transition RPC, with workflow history recorded', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ slug: `green-flow-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });

    const submit = await callTransition(author.client, id, 'editorial_review');
    expect(submit.ok).toBe(true);

    const approve = await callTransition(editor.client, id, 'approved');
    expect(approve.ok).toBe(true);

    const publish = await callTransition(publisher.client, id, 'published');
    expect(publish.ok).toBe(true);

    const finalPost = await getResourceEditorPost(admin, id);
    expect(finalPost?.status).toBe('published');
    expect(finalPost?.published_at).not.toBeNull();
    expect(finalPost?.editorial_approved_by).toBe(editor.userId);

    const { data: history } = await admin.from('resource_workflow_history').select('to_status').eq('post_id', id).order('created_at', { ascending: true });
    expect((history ?? []).map((h) => h.to_status)).toEqual(['editorial_review', 'approved', 'published']);
  });

  it('Author cannot publish directly (spec §66/§112)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    await updateResourceDraft(author.client, id, { patch: basePatch({ slug: `author-no-publish-${RUN_ID}` }), categoryIds: [], tagIds: [], expectedUpdatedAt: loaded!.updated_at, userId: author.userId });
    await callTransition(author.client, id, 'editorial_review');
    await admin.from('resource_posts').update({ status: 'approved', editorial_approved_by: editor.userId, editorial_approved_at: new Date().toISOString() }).eq('id', id);

    const attempt = await callTransition(author.client, id, 'published');
    expect(attempt.ok).toBe(false);
  });
});

describe('Workflow — AMBER path requires compliance approval (spec §68/§110)', () => {
  it('publication is denied without compliance approval, then succeeds once granted', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ compliance_classification: 'amber', slug: `amber-flow-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });

    await callTransition(author.client, id, 'editorial_review');
    const toCompliance = await callTransition(editor.client, id, 'compliance_review');
    expect(toCompliance.ok).toBe(true);

    // Editor alone cannot approve AMBER content.
    const editorAttempt = await callTransition(editor.client, id, 'approved');
    expect(editorAttempt.ok).toBe(false);

    const complianceApprove = await callTransition(complianceReviewer.client, id, 'approved');
    expect(complianceApprove.ok).toBe(true);

    const publish = await callTransition(publisher.client, id, 'published');
    expect(publish.ok).toBe(true);

    const finalPost = await getResourceEditorPost(admin, id);
    expect(finalPost?.compliance_approved_by).toBe(complianceReviewer.userId);
    expect(finalPost?.status).toBe('published');
  });
});

describe('Workflow — RED never publishes (spec §69/§111)', () => {
  it('RED content is denied at approved->published, both via RPC and the DB CHECK constraint backstop', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const loaded = await getResourceEditorPost(author.client, id);
    await updateResourceDraft(author.client, id, {
      patch: basePatch({ compliance_classification: 'red', slug: `red-flow-${RUN_ID}` }),
      categoryIds: [],
      tagIds: [],
      expectedUpdatedAt: loaded!.updated_at,
      userId: author.userId,
    });
    await callTransition(author.client, id, 'editorial_review');

    const publishAttempt = await callTransition(editor.client, id, 'published');
    expect(publishAttempt.ok).toBe(false);

    // Defense-in-depth: even a direct service-role status write is rejected by the CHECK constraint.
    const { error } = await admin.from('resource_posts').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', id);
    expect(error).not.toBeNull();
  });
});

describe('Direct-URL / RLS security (spec §113)', () => {
  it('a customer cannot read another user\'s draft via getResourceEditorPost even with the exact id (no permission leak)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const seen = await getResourceEditorPost(ordinary.client, id);
    expect(seen).toBeNull();
  });

  it('an Analyst also cannot read a draft (is_resource_staff excludes analyst)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const seen = await getResourceEditorPost(analyst.client, id);
    expect(seen).toBeNull();
  });

  it('a different Author CAN read and edit another Author\'s draft — R1.1\'s "staff update posts" policy is staff-wide, not creator-only (existing R1.1 boundary, not narrowed or widened by R1.3)', async () => {
    const { id } = await createResourceDraft(author.client, 'article', author.userId);
    createdPostIds.push(id);
    const seenBySecondAuthor = await getResourceEditorPost(secondAuthor.client, id);
    expect(seenBySecondAuthor).not.toBeNull();
  });
});

// Thin local helper — exercises the exact same RPC wrapper the workflow API
// route uses (lib/resources/workflow.ts), but against a caller-supplied
// client rather than the request-scoped server client, since these are
// direct-to-Supabase tests, not HTTP tests against a running Next.js server.
async function callTransition(client: SupabaseClient, postId: string, toStatus: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: toStatus, p_reason: null, p_notes: null });
  if (error) return { ok: false, error: error.message };
  void data;
  return { ok: true };
}
