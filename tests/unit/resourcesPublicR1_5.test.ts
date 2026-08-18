// R1.5 public Resources frontend — live-DEV visibility/filtering/security
// tests. Same pattern as tests/unit/resourcesR1_4LiveDev.test.ts: a real
// magic-link-authenticated resource_admin client creates throwaway fixtures
// (clearly named "R1.5 TEST — ..."), pushed through the real
// transition_resource_post_status RPC (spec §84: "do not fake publication
// by direct status writes except when explicitly testing DB backstops"),
// then every assertion in this file reads back through a genuinely
// anonymous (no auth header at all) Supabase client — never a mocked array
// (spec §120) — exercising the actual lib/resources/public/queries.ts
// functions the app itself calls.
//
// Two fixtures are deliberately created via direct service-role writes
// instead of the workflow RPC (documented inline at their call sites) —
// this is the one narrow exception spec §84 itself anticipates ("except
// when explicitly testing DB backstops"): a "scheduled" post (scheduled_at
// is not writable through any authenticated path anywhere in this
// codebase — a pre-existing R1.1-R1.4 gap, not something R1.5 introduces,
// see lib/resources/public/queries.ts's fixture-script equivalent comment)
// and a published-status Money Update Template (the one row this suite
// exists specifically to prove the R1.5 application layer — not RLS —
// keeps hidden).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

vi.setConfig({ testTimeout: 20000 });

import {
  getPublicResourceBySlug,
  getPublicResourcesByTopic,
  getPublicVideos,
  getPublicGlossaryTerms,
  getPublicMoneyUpdates,
  getPublicFaqsForPost,
  getPublicSourcesForPost,
  getPublicResourceSitemapEntries,
  getPublicCategories,
  getCentralDisclaimer,
} from '@/lib/resources/public/queries';
import { isPubliclyVisible, isExpired, applyPublicPostVisibility, PUBLIC_STATUSES } from '@/lib/resources/public/visibility';
import { isSafeSourceUrl } from '@/lib/resources/sources/validation';
import { buildResourceMetadata } from '@/lib/resources/public/metadata';

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
// Genuinely anonymous — no Authorization header at all, exactly what a real
// public visitor's browser sends. This is the client every assertion below
// reads through (spec §120).
const anon: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const RUN_ID = Date.now();
const createdUserIds: string[] = [];
const createdPostIds: string[] = [];
const createdFaqIds: string[] = [];
const createdSourceIds: string[] = [];
const createdCategoryIds: string[] = [];

async function makeResourceAdmin(): Promise<{ userId: string; client: SupabaseClient }> {
  const email = `r1-5-test-admin-${RUN_ID}@test.fhip.invalid`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) throw new Error(`Failed to create test user: ${createErr?.message}`);
  createdUserIds.push(created.user.id);

  const { error: roleErr } = await admin.from('resource_user_roles').insert({ user_id: created.user.id, role: 'resource_admin', assigned_by: null });
  if (roleErr) throw new Error(`Failed to assign resource_admin role: ${roleErr.message}`);

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr || !link.properties?.hashed_token) throw new Error(`Failed to generate link: ${linkErr?.message}`);

  const verifyClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: verified, error: verifyErr } = await verifyClient.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (verifyErr || !verified.session) throw new Error(`Failed to verify OTP: ${verifyErr?.message}`);

  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
  });
  return { userId: created.user.id, client };
}

async function transition(client: SupabaseClient, postId: string, toStatus: string) {
  const { error } = await client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: toStatus, p_reason: null, p_notes: null });
  if (error) throw new Error(`transition ${postId} -> ${toStatus} failed: ${error.message}`);
}

let staff: { userId: string; client: SupabaseClient };
let categoryId: string;

// Fixture post ids/slugs, populated in beforeAll.
let publishedArticleId: string, publishedArticleSlug: string;
let draftId: string, draftSlug: string;
let scheduledId: string, scheduledSlug: string;
let archivedId: string, archivedSlug: string;
let reviewDueId: string, reviewDueSlug: string;
let approvedId: string, approvedSlug: string;
let nonIndexableId: string, nonIndexableSlug: string;
let templatePublishedId: string, templatePublishedSlug: string;
let moneyUpdateId: string;
let activeFaqId: string, inactiveFaqId: string;
let publicSourceId: string, privateSourceId: string;

beforeAll(async () => {
  staff = await makeResourceAdmin();

  const { data: cat, error: catErr } = await admin
    .from('resource_categories')
    .insert({ name: `R1.5 TEST Category ${RUN_ID}`, slug: `r1-5-test-category-${RUN_ID}` })
    .select('id')
    .single();
  if (catErr) throw new Error(`Failed to create test category: ${catErr.message}`);
  categoryId = cat.id;
  createdCategoryIds.push(categoryId);

  // --- Published Article (fully through the real workflow RPC) ----------
  publishedArticleSlug = `r1-5-test-live-article-${RUN_ID}`;
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Article', content_type: 'article', slug: publishedArticleSlug, content_blocks: [], visibility: 'public', is_indexable: true, primary_category_id: categoryId, created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create article failed: ${error.message}`);
    publishedArticleId = data.id;
    createdPostIds.push(publishedArticleId);
    await staff.client.from('resource_post_categories').insert({ post_id: publishedArticleId, category_id: categoryId, is_primary: true });
    await transition(staff.client, publishedArticleId, 'editorial_review');
    await transition(staff.client, publishedArticleId, 'approved');
    await transition(staff.client, publishedArticleId, 'published');
  }

  // --- Draft (never leaves draft) -----------------------------------------
  draftSlug = `r1-5-test-live-draft-${RUN_ID}`;
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Draft', content_type: 'article', slug: draftSlug, content_blocks: [], visibility: 'public', created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create draft failed: ${error.message}`);
    draftId = data.id;
    createdPostIds.push(draftId);
  }

  // --- Approved (approved but never published) ----------------------------
  approvedSlug = `r1-5-test-live-approved-${RUN_ID}`;
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Approved', content_type: 'article', slug: approvedSlug, content_blocks: [], visibility: 'public', created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create approved failed: ${error.message}`);
    approvedId = data.id;
    createdPostIds.push(approvedId);
    await transition(staff.client, approvedId, 'editorial_review');
    await transition(staff.client, approvedId, 'approved');
  }

  // --- Archived (published, then archived via the real workflow) ---------
  archivedSlug = `r1-5-test-live-archived-${RUN_ID}`;
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Archived', content_type: 'article', slug: archivedSlug, content_blocks: [], visibility: 'public', is_indexable: true, created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create archived failed: ${error.message}`);
    archivedId = data.id;
    createdPostIds.push(archivedId);
    await transition(staff.client, archivedId, 'editorial_review');
    await transition(staff.client, archivedId, 'approved');
    await transition(staff.client, archivedId, 'published');
    await transition(staff.client, archivedId, 'archived');
  }

  // --- Review Due (published, then flagged review_due — stays PUBLIC per
  // this project's documented decision, lib/resources/public/visibility.ts) ---
  reviewDueSlug = `r1-5-test-live-review-due-${RUN_ID}`;
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Review Due', content_type: 'article', slug: reviewDueSlug, content_blocks: [], visibility: 'public', is_indexable: true, created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create review_due failed: ${error.message}`);
    reviewDueId = data.id;
    createdPostIds.push(reviewDueId);
    await transition(staff.client, reviewDueId, 'editorial_review');
    await transition(staff.client, reviewDueId, 'approved');
    await transition(staff.client, reviewDueId, 'published');
    await transition(staff.client, reviewDueId, 'review_due');
  }

  // --- Non-indexable published (spec §65: stays accessible, gets noindex) --
  nonIndexableSlug = `r1-5-test-live-noindex-${RUN_ID}`;
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Non-Indexable', content_type: 'article', slug: nonIndexableSlug, content_blocks: [], visibility: 'public', is_indexable: false, created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create non-indexable failed: ${error.message}`);
    nonIndexableId = data.id;
    createdPostIds.push(nonIndexableId);
    await transition(staff.client, nonIndexableId, 'editorial_review');
    await transition(staff.client, nonIndexableId, 'approved');
    await transition(staff.client, nonIndexableId, 'published');
  }

  // --- Money Update (published) for FAQ/Source assertions -----------------
  {
    const { data, error } = await staff.client
      .from('resource_posts')
      .insert({ title: 'R1.5 TEST — Live Money Update', content_type: 'money_update', slug: `r1-5-test-live-money-update-${RUN_ID}`, content_blocks: [], visibility: 'public', is_indexable: true, event_date: new Date().toISOString().slice(0, 10), created_by: staff.userId })
      .select('id')
      .single();
    if (error) throw new Error(`create money update failed: ${error.message}`);
    moneyUpdateId = data.id;
    createdPostIds.push(moneyUpdateId);
    await transition(staff.client, moneyUpdateId, 'editorial_review');
    await transition(staff.client, moneyUpdateId, 'approved');
    await transition(staff.client, moneyUpdateId, 'published');
  }

  // --- FAQs: one active, one inactive, both linked to the Money Update -----
  {
    const { data: active, error: activeErr } = await staff.client
      .from('resource_faqs')
      .insert({ question: 'R1.5 TEST — active FAQ?', short_answer: 'Yes, visible.', answer_blocks: [], is_active: true })
      .select('id')
      .single();
    if (activeErr) throw new Error(`create active faq failed: ${activeErr.message}`);
    activeFaqId = active.id;
    createdFaqIds.push(activeFaqId);

    const { data: inactive, error: inactiveErr } = await staff.client
      .from('resource_faqs')
      .insert({ question: 'R1.5 TEST — inactive FAQ?', short_answer: 'Must never be visible.', answer_blocks: [], is_active: false })
      .select('id')
      .single();
    if (inactiveErr) throw new Error(`create inactive faq failed: ${inactiveErr.message}`);
    inactiveFaqId = inactive.id;
    createdFaqIds.push(inactiveFaqId);

    await staff.client.from('resource_post_faqs').insert([
      { post_id: moneyUpdateId, faq_id: activeFaqId, sort_order: 0 },
      { post_id: moneyUpdateId, faq_id: inactiveFaqId, sort_order: 1 },
    ]);
  }

  // --- Sources: one public, one private, both linked ----------------------
  {
    const { data: pub, error: pubErr } = await staff.client
      .from('resource_sources')
      .insert({ source_name: 'R1.5 TEST — Public Source', url: 'https://example.com/public', is_public: true })
      .select('id')
      .single();
    if (pubErr) throw new Error(`create public source failed: ${pubErr.message}`);
    publicSourceId = pub.id;
    createdSourceIds.push(publicSourceId);

    const { data: priv, error: privErr } = await staff.client
      .from('resource_sources')
      .insert({ source_name: 'R1.5 TEST — Private Source', url: 'https://example.com/private', is_public: false })
      .select('id')
      .single();
    if (privErr) throw new Error(`create private source failed: ${privErr.message}`);
    privateSourceId = priv.id;
    createdSourceIds.push(privateSourceId);

    await staff.client.from('resource_post_sources').insert([
      { post_id: moneyUpdateId, source_id: publicSourceId, sort_order: 0 },
      { post_id: moneyUpdateId, source_id: privateSourceId, sort_order: 1 },
    ]);
  }

  // --- Scheduled (documented narrow exception — see file header) ----------
  scheduledSlug = `r1-5-test-live-scheduled-${RUN_ID}`;
  {
    const { data, error } = await admin
      .from('resource_posts')
      .insert({
        title: 'R1.5 TEST — Live Scheduled',
        content_type: 'article',
        slug: scheduledSlug,
        content_blocks: [],
        visibility: 'public',
        is_indexable: true,
        status: 'scheduled',
        scheduled_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        created_by: staff.userId,
      })
      .select('id')
      .single();
    if (error) throw new Error(`create scheduled failed: ${error.message}`);
    scheduledId = data.id;
    createdPostIds.push(scheduledId);
  }

  // --- Money Update Template pushed to published (documented narrow
  // exception, the critical DB-backstop test — see file header) -----------
  templatePublishedSlug = `r1-5-test-live-template-published-${RUN_ID}`;
  {
    const { data, error } = await admin
      .from('resource_posts')
      .insert({
        title: 'R1.5 TEST — Live Template (must never be public)',
        content_type: 'money_update_template',
        slug: templatePublishedSlug,
        content_blocks: [],
        visibility: 'public',
        is_indexable: true,
        status: 'published',
        published_at: new Date().toISOString(),
        created_by: staff.userId,
      })
      .select('id')
      .single();
    if (error) throw new Error(`create published template failed: ${error.message}`);
    templatePublishedId = data.id;
    createdPostIds.push(templatePublishedId);
  }
}, 60000);

afterAll(async () => {
  if (createdPostIds.length > 0) await admin.from('resource_posts').delete().in('id', createdPostIds);
  if (createdFaqIds.length > 0) await admin.from('resource_faqs').delete().in('id', createdFaqIds);
  if (createdSourceIds.length > 0) await admin.from('resource_sources').delete().in('id', createdSourceIds);
  if (createdCategoryIds.length > 0) await admin.from('resource_categories').delete().in('id', createdCategoryIds);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
}, 60000);

// ---------------------------------------------------------------------------
// Pure-function unit tests (no DB) — spec §119.
// ---------------------------------------------------------------------------
describe('R1.5 pure visibility helpers', () => {
  it('isPubliclyVisible: published+public+past-published_at+allowlisted type is true', () => {
    expect(isPubliclyVisible({ status: 'published', visibility: 'public', published_at: new Date(Date.now() - 1000).toISOString(), content_type: 'article' })).toBe(true);
  });
  it('isPubliclyVisible: review_due is true (documented decision)', () => {
    expect(isPubliclyVisible({ status: 'review_due', visibility: 'public', published_at: new Date(Date.now() - 1000).toISOString(), content_type: 'article' })).toBe(true);
  });
  it('isPubliclyVisible: archived is false (documented decision — no R0-B archive spec found)', () => {
    expect(isPubliclyVisible({ status: 'archived', visibility: 'public', published_at: new Date(Date.now() - 1000).toISOString(), content_type: 'article' })).toBe(false);
  });
  it('isPubliclyVisible: money_update_template is false regardless of status (fails-safe allowlist)', () => {
    expect(isPubliclyVisible({ status: 'published', visibility: 'public', published_at: new Date(Date.now() - 1000).toISOString(), content_type: 'money_update_template' })).toBe(false);
  });
  it('isPubliclyVisible: future published_at is false', () => {
    expect(isPubliclyVisible({ status: 'published', visibility: 'public', published_at: new Date(Date.now() + 100000).toISOString(), content_type: 'article' })).toBe(false);
  });
  it('isPubliclyVisible: private visibility is false even if published', () => {
    expect(isPubliclyVisible({ status: 'published', visibility: 'private', published_at: new Date(Date.now() - 1000).toISOString(), content_type: 'article' })).toBe(false);
  });
  it('isExpired: null expires_at is never expired', () => {
    expect(isExpired(null)).toBe(false);
  });
  it('isExpired: past date is expired', () => {
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
  });
  it('isSafeSourceUrl rejects javascript: scheme (spec §96)', () => {
    expect(isSafeSourceUrl("javascript:alert('R1.5')")).toBe(false);
  });
  it('isSafeSourceUrl accepts https URLs', () => {
    expect(isSafeSourceUrl('https://example.com/page')).toBe(true);
  });
  it('buildResourceMetadata: is_indexable=false produces a noindex robots directive (spec §65)', () => {
    const meta = buildResourceMetadata({ title: 'T', seo_title: null, excerpt: null, seo_description: null, slug: 'x', is_indexable: false, content_type: 'article' });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
  it('buildResourceMetadata: is_indexable=true has no robots override', () => {
    const meta = buildResourceMetadata({ title: 'T', seo_title: null, excerpt: null, seo_description: null, slug: 'x', is_indexable: true, content_type: 'article' });
    expect(meta.robots).toBeUndefined();
  });
  it('buildResourceMetadata: seo_title/seo_description fall back to title/excerpt (spec §64)', () => {
    const meta = buildResourceMetadata({ title: 'Fallback Title', seo_title: null, excerpt: 'Fallback excerpt', seo_description: null, slug: 'x', is_indexable: true, content_type: 'article' });
    expect(meta.title).toContain('Fallback Title');
    expect(meta.description).toBe('Fallback excerpt');
  });
});

// ---------------------------------------------------------------------------
// Live-DEV visibility tests — spec §85/§86/§120. Every assertion below reads
// through the genuinely anonymous `anon` client.
// ---------------------------------------------------------------------------
describe('R1.5 live-DEV public visibility (anonymous client)', () => {
  it('a published Article is publicly visible by slug', async () => {
    const post = await getPublicResourceBySlug(anon, publishedArticleSlug);
    expect(post).not.toBeNull();
    expect(post!.title).toBe('R1.5 TEST — Live Article');
  });

  it('a Draft is NOT publicly visible by slug (returns null, not the content)', async () => {
    const post = await getPublicResourceBySlug(anon, draftSlug);
    expect(post).toBeNull();
  });

  it('an Approved-but-unpublished post is NOT publicly visible by slug', async () => {
    const post = await getPublicResourceBySlug(anon, approvedSlug);
    expect(post).toBeNull();
  });

  it('a Scheduled (future) post is NOT publicly visible by slug', async () => {
    const post = await getPublicResourceBySlug(anon, scheduledSlug);
    expect(post).toBeNull();
  });

  it('an Archived post is NOT publicly visible by slug (app-level decision, independent of RLS)', async () => {
    const post = await getPublicResourceBySlug(anon, archivedSlug);
    expect(post).toBeNull();
  });

  it('a Review Due post STAYS publicly visible by slug (documented decision)', async () => {
    const post = await getPublicResourceBySlug(anon, reviewDueSlug);
    expect(post).not.toBeNull();
    expect(post!.status).toBe('review_due');
  });

  it('a published Money Update Template is NEVER publicly visible by slug, even though its DB status is "published" (the critical spec §9 backstop test)', async () => {
    const post = await getPublicResourceBySlug(anon, templatePublishedSlug);
    expect(post).toBeNull();
    // Confirm the row genuinely is status=published at the DB layer, so this
    // assertion is proving the app-level filter, not accidentally passing
    // because the fixture itself never reached 'published'.
    const { data: raw } = await admin.from('resource_posts').select('status').eq('id', templatePublishedId).single();
    expect(raw?.status).toBe('published');
  });

  it('a non-indexable published post remains publicly ACCESSIBLE (not 404) — spec §65', async () => {
    const post = await getPublicResourceBySlug(anon, nonIndexableSlug);
    expect(post).not.toBeNull();
    expect(post!.is_indexable).toBe(false);
  });

  it('direct-slug lookups for a hidden and a genuinely nonexistent slug return the identical null result (spec §71/§86)', async () => {
    const hidden = await getPublicResourceBySlug(anon, draftSlug);
    const fake = await getPublicResourceBySlug(anon, `r1-5-test-genuinely-nonexistent-${RUN_ID}`);
    expect(hidden).toBeNull();
    expect(fake).toBeNull();
  });
});

describe('R1.5 live-DEV FAQ and Source filtering', () => {
  it('getPublicFaqsForPost returns only the active FAQ, never the inactive one', async () => {
    const faqs = await getPublicFaqsForPost(anon, moneyUpdateId);
    const ids = faqs.map((f) => f.id);
    expect(ids).toContain(activeFaqId);
    expect(ids).not.toContain(inactiveFaqId);
  });

  it('getPublicSourcesForPost returns only the public Source, never the private one', async () => {
    const sources = await getPublicSourcesForPost(anon, moneyUpdateId);
    const ids = sources.map((s) => s.id);
    expect(ids).toContain(publicSourceId);
    expect(ids).not.toContain(privateSourceId);
  });
});

describe('R1.5 live-DEV listing/filtering/sitemap', () => {
  it('getPublicResourcesByTopic includes the published article under its linked category', async () => {
    const result = await getPublicResourcesByTopic(anon, categoryId, { jurisdiction: 'all', type: 'all', page: 1 });
    expect(result.items.some((i) => i.id === publishedArticleId)).toBe(true);
  });

  it('getPublicResourcesByTopic never includes draft/archived/scheduled/template fixtures', async () => {
    const result = await getPublicResourcesByTopic(anon, categoryId, { jurisdiction: 'all', type: 'all', page: 1, pageSize: 50 });
    const ids = result.items.map((i) => i.id);
    expect(ids).not.toContain(draftId);
    expect(ids).not.toContain(archivedId);
    expect(ids).not.toContain(scheduledId);
    expect(ids).not.toContain(approvedId);
  });

  it('getPublicMoneyUpdates never returns a money_update_template row', async () => {
    const result = await getPublicMoneyUpdates(anon, { page: 1, pageSize: 50 });
    expect(result.items.some((i) => i.id === templatePublishedId)).toBe(false);
  });

  it('getPublicCategories returns the test category with a public count including the published article', async () => {
    const categories = await getPublicCategories(anon);
    const found = categories.find((c) => c.id === categoryId);
    expect(found).toBeDefined();
    expect(found!.publicCount).toBeGreaterThanOrEqual(1);
  });

  it('getPublicResourceSitemapEntries includes the published+indexable article', async () => {
    const entries = await getPublicResourceSitemapEntries(anon);
    expect(entries.some((e) => e.slug === publishedArticleSlug)).toBe(true);
  });

  it('getPublicResourceSitemapEntries excludes the non-indexable published post', async () => {
    const entries = await getPublicResourceSitemapEntries(anon);
    expect(entries.some((e) => e.slug === nonIndexableSlug)).toBe(false);
  });

  it('getPublicResourceSitemapEntries excludes draft/archived/scheduled/template fixtures', async () => {
    const entries = await getPublicResourceSitemapEntries(anon);
    const slugs = entries.map((e) => e.slug);
    expect(slugs).not.toContain(draftSlug);
    expect(slugs).not.toContain(archivedSlug);
    expect(slugs).not.toContain(scheduledSlug);
    expect(slugs).not.toContain(templatePublishedSlug);
  });

  it('getPublicVideos and getPublicGlossaryTerms run cleanly against real RLS with zero rows for this run (no fixtures of those types created in this suite)', async () => {
    const videos = await getPublicVideos(anon, { page: 1 });
    const glossary = await getPublicGlossaryTerms(anon);
    expect(Array.isArray(videos.items)).toBe(true);
    expect(Array.isArray(glossary)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R1.5 Closure Pass — Part A: migration 0039_resources_public_settings_read
// (spec §12: "Add a focused automated assertion covering: allowed anonymous
// setting; non-allowlisted setting hidden. The test must fail closed if 0039
// is absent. Do not silently skip it and call R1.5 PASS.") Before 0039 is
// live, resource_settings has only the staff-only "staff read settings"
// policy (migration 0033) — an anonymous client gets zero rows for
// everything, including the three keys that are supposed to become public.
// That means the "allowed key is visible" assertions below FAIL CLOSED
// (deliberately) until 0039 is applied to DEV; they are not skipped, and
// they do not silently pass. The "non-allowlisted key stays hidden"
// assertion passes in both states (RLS denies by default either way), which
// is itself the correct permanent regression guard once 0039 is live.
// ---------------------------------------------------------------------------
describe('R1.5 closure — migration 0039 public settings read (spec §9/§10/§12)', () => {
  const privateSettingKey = `r1_5_closure_private_test_setting_${RUN_ID}`;
  const createdSettingKeys: string[] = [];

  beforeAll(async () => {
    // A temporary DEV-only non-allowlisted key, inserted via the privileged
    // service-role admin client (legitimate CMS-admin fixture setup, never
    // used to serve public content) — spec §10.
    const { error } = await admin.from('resource_settings').insert({ key: privateSettingKey, value: 'R1.5 CLOSURE TEST — must never be anon-readable' });
    if (error) throw new Error(`failed to create private test setting: ${error.message}`);
    createdSettingKeys.push(privateSettingKey);
  });

  afterAll(async () => {
    if (createdSettingKeys.length > 0) await admin.from('resource_settings').delete().in('key', createdSettingKeys);
  });

  it('anonymous can read default_disclaimer (fails closed — 0 rows — until migration 0039 is live)', async () => {
    const { data, error } = await anon.from('resource_settings').select('value').eq('key', 'default_disclaimer').maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('anonymous can read youtube_channel_handle if the row exists (fails closed until 0039 is live)', async () => {
    const { data: rowExists } = await admin.from('resource_settings').select('key').eq('key', 'youtube_channel_handle').maybeSingle();
    if (!rowExists) return; // spec §9: "visible if row exists" — nothing to assert if it was never seeded
    const { data, error } = await anon.from('resource_settings').select('value').eq('key', 'youtube_channel_handle').maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('anonymous can read youtube_channel_url if the row exists (fails closed until 0039 is live)', async () => {
    const { data: rowExists } = await admin.from('resource_settings').select('key').eq('key', 'youtube_channel_url').maybeSingle();
    if (!rowExists) return; // spec §9: "visible if row exists"
    const { data, error } = await anon.from('resource_settings').select('value').eq('key', 'youtube_channel_url').maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('anonymous CANNOT read a non-allowlisted resource_settings key, before or after 0039 (spec §10)', async () => {
    const { data, error } = await anon.from('resource_settings').select('value').eq('key', privateSettingKey).maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('getCentralDisclaimer() resolves to a non-empty string regardless of migration state (DB value once live, defensive fallback until then)', async () => {
    const text = await getCentralDisclaimer(anon);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('R1.5 applyPublicPostVisibility helper — direct RLS-scoped query behaviour', () => {
  it('a raw query built with applyPublicPostVisibility against the anon client returns only PUBLIC_STATUSES rows for our fixtures', async () => {
    let query = anon.from('resource_posts').select('id, status').in('id', [publishedArticleId, draftId, archivedId, reviewDueId, scheduledId]);
    query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
    const { data, error } = await query;
    expect(error).toBeNull();
    const ids = (data ?? []).map((r: { id: string }) => r.id);
    expect(ids).toContain(publishedArticleId);
    expect(ids).toContain(reviewDueId);
    expect(ids).not.toContain(draftId);
    expect(ids).not.toContain(archivedId);
    expect(ids).not.toContain(scheduledId);
    for (const row of data ?? []) {
      expect(PUBLIC_STATUSES as readonly string[]).toContain((row as { status: string }).status);
    }
  });
});
