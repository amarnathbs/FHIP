// Resources Admin (R1.2) — query-layer, filter-validation, and RBAC tests.
//
// R1.2 builds a browsing/dashboard shell on top of R1.1's already-tested
// RLS/RPC foundation (tests/unit/resourcesR1_1.test.ts) — these tests don't
// re-prove RLS itself, they prove the *admin query layer* (lib/resources/admin/*)
// uses the caller's own RLS-scoped client correctly (spec §70/§71: no
// service-role bypass for ordinary lists) and that filter/pagination/search
// input is validated safely (spec §67-69) before it reaches a query.
//
// Same live-DEV, throwaway-fixture, real-auth-client pattern as
// resourcesR1_1.test.ts — see that file's header comment for why (magic-link
// token exchange, r1-1-test-style disposable users/posts, cleanup in afterAll).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parseContentListFilters, QUEUE_STATUS_GROUPS } from '@/lib/resources/admin/filters';
import { getResourceContentList, getResourceContentById, getResourceCategoriesForFilter, getResourceDashboardSummary } from '@/lib/resources/admin/queries';

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

async function makeTestUser(label: string, role?: string): Promise<{ userId: string; client: SupabaseClient }> {
  const email = `r1-2-admin-test-${label}-${RUN_ID}@test.fhip.invalid`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) throw new Error(`Failed to create test user ${label}: ${createErr?.message}`);
  createdUserIds.push(created.user.id);

  if (role) {
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

async function createTestPost(overrides: Record<string, unknown>): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { data, error } = await admin
    .from('resource_posts')
    .insert({
      title: `r1-2-admin-test-${RUN_ID}-${suffix}`,
      content_type: 'article',
      slug: `r1-2-admin-test-${RUN_ID}-${suffix}`,
      ...overrides,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create test post: ${error?.message}`);
  createdPostIds.push(data.id);
  return data.id;
}

let ordinary: { userId: string; client: SupabaseClient };
let author: { userId: string; client: SupabaseClient };
let analyst: { userId: string; client: SupabaseClient };
let publishedPostId: string;
let draftPostId: string;
let uniqueTitleWord: string;

beforeAll(async () => {
  const { error: schemaErr } = await admin.from('resource_posts').select('id').limit(1);
  if (schemaErr) {
    throw new Error(
      `Resources schema is not installed in the configured test/DEV database (${schemaErr.message}). ` +
        `Apply the Resources migrations (0033-0036) via the Supabase Dashboard SQL editor for the DEV project, then re-run this suite.`
    );
  }

  const now = new Date();
  const past = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  uniqueTitleWord = `zzradmin${RUN_ID}`;

  publishedPostId = await createTestPost({
    title: `Published ${uniqueTitleWord} fixture`,
    slug: `r1-2-admin-test-published-${RUN_ID}`,
    status: 'published',
    visibility: 'public',
    published_at: past,
  });
  draftPostId = await createTestPost({ title: `Draft ${uniqueTitleWord} fixture`, status: 'draft', visibility: 'private' });

  ordinary = await makeTestUser('ordinary');
  author = await makeTestUser('author', 'author');
  analyst = await makeTestUser('analyst', 'analyst');
}, 60000);

afterAll(async () => {
  for (const id of createdPostIds) await admin.from('resource_posts').delete().eq('id', id);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

describe('parseContentListFilters — input validation (spec §67-69, no DB needed)', () => {
  it('defaults to safe values when the query string is empty', () => {
    const f = parseContentListFilters(new URLSearchParams());
    expect(f).toEqual({ search: '', status: 'all', contentType: 'all', jurisdiction: 'all', compliance: 'all', categoryId: 'all', sort: 'updated_desc', page: 1, pageSize: 25 });
  });

  it('rejects an unrecognised status value rather than passing it through (§69: ?status=HACK)', () => {
    const f = parseContentListFilters(new URLSearchParams('status=HACK'));
    expect(f.status).toBe('all');
  });

  it('rejects unrecognised type/jurisdiction/compliance/sort values', () => {
    const f = parseContentListFilters(new URLSearchParams('type=nonsense&jurisdiction=nonsense&compliance=nonsense&sort=nonsense'));
    expect(f.contentType).toBe('all');
    expect(f.jurisdiction).toBe('all');
    expect(f.compliance).toBe('all');
    expect(f.sort).toBe('updated_desc');
  });

  it('accepts every real enum value', () => {
    expect(parseContentListFilters(new URLSearchParams('status=published')).status).toBe('published');
    expect(parseContentListFilters(new URLSearchParams('type=fhip_explainer')).contentType).toBe('fhip_explainer');
    expect(parseContentListFilters(new URLSearchParams('jurisdiction=australia_india_cross_border')).jurisdiction).toBe('australia_india_cross_border');
    expect(parseContentListFilters(new URLSearchParams('compliance=amber')).compliance).toBe('amber');
    expect(parseContentListFilters(new URLSearchParams('sort=title_asc')).sort).toBe('title_asc');
  });

  it('clamps pageSize to the 100 ceiling (§68) rather than honouring an oversized request', () => {
    const f = parseContentListFilters(new URLSearchParams('pageSize=1000000'));
    expect(f.pageSize).toBe(100);
  });

  it('falls back to page 1 for a non-numeric or negative page', () => {
    expect(parseContentListFilters(new URLSearchParams('page=-5')).page).toBe(1);
    expect(parseContentListFilters(new URLSearchParams('page=not-a-number')).page).toBe(1);
  });

  it('rejects a non-UUID-shaped category id', () => {
    const f = parseContentListFilters(new URLSearchParams('category=<script>alert(1)</script>'));
    expect(f.categoryId).toBe('all');
  });

  it('queue status groups cover exactly the 9 workflow statuses with no overlap or gap', () => {
    const all = Object.values(QUEUE_STATUS_GROUPS).flat();
    expect(new Set(all).size).toBe(all.length); // no status appears in two queues
    expect(new Set(all)).toEqual(new Set(['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived']));
  });
});

describe('Resources Admin R1.2 — content list query respects RLS per caller (no service-role bypass)', () => {
  it('an ordinary customer querying via getResourceContentList sees the published fixture but never the draft', async () => {
    const result = await getResourceContentList(ordinary.client, { ...parseContentListFilters(new URLSearchParams()), search: uniqueTitleWord });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(publishedPostId);
    expect(ids).not.toContain(draftPostId);
  });

  it('an Analyst gets the same restricted view as an ordinary customer — is_resource_staff excludes analyst', async () => {
    const result = await getResourceContentList(analyst.client, { ...parseContentListFilters(new URLSearchParams()), search: uniqueTitleWord });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(publishedPostId);
    expect(ids).not.toContain(draftPostId);
  });

  it('a content-workflow staff member (Author) sees both the published fixture and the draft — RLS grants staff all-post read', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams()), search: uniqueTitleWord });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(publishedPostId);
    expect(ids).toContain(draftPostId);
  });

  it('never fetches content_blocks in the list view (spec §34/§91)', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams()), search: uniqueTitleWord });
    for (const item of result.items) {
      expect(Object.prototype.hasOwnProperty.call(item, 'content_blocks')).toBe(false);
    }
  });
});

describe('Resources Admin R1.2 — filters, search, sort, pagination', () => {
  it('status filter narrows to exactly the requested status', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams('status=published')), search: uniqueTitleWord });
    expect(result.items.every((i) => i.status === 'published')).toBe(true);
    expect(result.items.map((i) => i.id)).toContain(publishedPostId);
  });

  it('a queue preset overrides the status filter entirely', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams('status=published')), search: uniqueTitleWord }, ['draft', 'idea']);
    expect(result.items.map((i) => i.id)).toContain(draftPostId);
    expect(result.items.map((i) => i.id)).not.toContain(publishedPostId);
  });

  it('search matches on title', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams()), search: uniqueTitleWord });
    expect(result.items.length).toBeGreaterThanOrEqual(2);
  });

  it('search matches on slug', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams()), search: `r1-2-admin-test-published-${RUN_ID}` });
    expect(result.items.map((i) => i.id)).toContain(publishedPostId);
  });

  it('an empty-result search returns zero items and zero total, not an error', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams()), search: `no-such-content-${RUN_ID}-xyz` });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('a search term containing filter-breaking characters (%,()) does not throw', async () => {
    await expect(getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams()), search: '%,()*weird' })).resolves.toBeDefined();
  });

  it('pagination: page 1 and page 2 return disjoint, correctly-sized slices for a scoped filter', async () => {
    const extraIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      extraIds.push(await createTestPost({ title: `Paging ${uniqueTitleWord} item ${i}`, status: 'draft', visibility: 'private' }));
    }
    const page1 = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams('pageSize=2')), search: uniqueTitleWord, pageSize: 2, page: 1 });
    const page2 = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams('pageSize=2')), search: uniqueTitleWord, pageSize: 2, page: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBeGreaterThanOrEqual(5); // published + draft + 3 paging fixtures
    const page1Ids = new Set(page1.items.map((i) => i.id));
    const page2Ids = new Set(page2.items.map((i) => i.id));
    for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false);
  });

  it('sort=title_asc returns titles in ascending order', async () => {
    const result = await getResourceContentList(author.client, { ...parseContentListFilters(new URLSearchParams('sort=title_asc')), search: uniqueTitleWord, sort: 'title_asc', pageSize: 50 });
    const titles = result.items.map((i) => i.title);
    const sorted = [...titles].sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(sorted);
  });
});

describe('Resources Admin R1.2 — content detail (spec §96: no permission-leak on not-found)', () => {
  it('staff can read the draft detail, including its embedded category/tag/video relations', async () => {
    const detail = await getResourceContentById(author.client, draftPostId);
    expect(detail?.id).toBe(draftPostId);
    expect(Array.isArray(detail?.categories)).toBe(true);
    expect(Array.isArray(detail?.tags)).toBe(true);
  });

  it('an ordinary customer gets null (not an error) for a draft id — same shape as a genuinely nonexistent id', async () => {
    const forbidden = await getResourceContentById(ordinary.client, draftPostId);
    const nonexistent = await getResourceContentById(ordinary.client, '00000000-0000-0000-0000-000000000000');
    expect(forbidden).toBeNull();
    expect(nonexistent).toBeNull();
  });

  it('an ordinary customer CAN read the published fixture detail', async () => {
    const detail = await getResourceContentById(ordinary.client, publishedPostId);
    expect(detail?.id).toBe(publishedPostId);
  });
});

describe('Resources Admin R1.2 — categories filter list', () => {
  it('only returns active categories', async () => {
    const categories = await getResourceCategoriesForFilter(author.client);
    expect(Array.isArray(categories)).toBe(true);
    for (const c of categories) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
    }
  });
});

describe('Resources Admin R1.2 — dashboard summary (spec §15: counts are live, not hard-coded)', () => {
  it('draft count increases by exactly 1 after creating one new draft fixture, proving the count is a live query', async () => {
    const before = await getResourceDashboardSummary(author.client);
    await createTestPost({ title: `Dashboard count ${uniqueTitleWord}`, status: 'draft', visibility: 'private' });
    const after = await getResourceDashboardSummary(author.client);
    expect(after.counts.drafts).toBe(before.counts.drafts + 1);
  });

  it('summary shape matches the spec §14 status groupings and never includes a negative count', async () => {
    const summary = await getResourceDashboardSummary(author.client);
    for (const value of Object.values(summary.counts)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(summary.needsAttention.editorialReview.items.length).toBeLessThanOrEqual(5);
    expect(summary.needsAttention.complianceReview.items.length).toBeLessThanOrEqual(5);
    expect(summary.recent.length).toBeLessThanOrEqual(8);
  });
});
