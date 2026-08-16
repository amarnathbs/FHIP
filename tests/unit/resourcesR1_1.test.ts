// Resources / Financial Knowledge & Insights — R1.1 database/security tests.
//
// R1.1 closure pass: these now run as genuine PASS/FAIL tests against the
// live DEV Supabase project (schema was applied via the Dashboard SQL
// editor — see docs/resources/R1.1-database-foundation.md). A missing
// schema is now a hard FAIL (beforeAll throws), not a graceful skip — the
// closure brief's own instruction (§10): "Missing Resources schema = FAIL,
// not PASS." The pre-closure version of this file skipped cleanly while the
// schema didn't exist yet; that grace period is over.
//
// Every fixture (posts, categories, tags, sources, test users) is created
// with a `r1-1-test-` prefix or an isolated throwaway auth user and is
// cleaned up in `afterAll`, using the service-role client, so a run against
// DEV never leaves data behind for the (unrelated) 50-user regression
// fixture personas.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

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
const anonClient: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const RUN_ID = Date.now();
const createdUserIds: string[] = [];
const createdPostIds: string[] = [];

// Creates a throwaway auth user, optionally assigns one Resources role, and
// returns a Supabase client authenticated as that user (via a magic-link
// token exchanged server-side — never navigated through a browser; see
// docs/phase0d2b_coverage_ledger.md for why that path is specifically
// avoided in this project).
async function makeTestUser(label: string, role?: string): Promise<{ userId: string; client: SupabaseClient }> {
  const email = `r1-1-test-${label}-${RUN_ID}@test.fhip.invalid`;
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
      title: `r1-1-test-${RUN_ID}-${suffix}`,
      content_type: 'article',
      // chk_resource_posts_slug_before_publish requires a slug for any
      // status beyond idea/draft (spec §22) — default every fixture to a
      // unique slug so workflow-transition tests don't trip over it; tests
      // that specifically exercise slug behavior override this explicitly.
      slug: `r1-1-test-${RUN_ID}-${suffix}`,
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
let editor: { userId: string; client: SupabaseClient };
let compliance: { userId: string; client: SupabaseClient };
let publisher: { userId: string; client: SupabaseClient };
let analyst: { userId: string; client: SupabaseClient };
let publishedPostId: string;
let scheduledPostId: string;
let draftPostId: string;

beforeAll(async () => {
  const { error: schemaErr } = await admin.from('resource_posts').select('id').limit(1);
  if (schemaErr) {
    throw new Error(
      `Resources R1.1 schema is not installed in the configured test/DEV database (${schemaErr.message}). ` +
        `Apply supabase/migrations/0033_resources_foundation.sql, 0034_resources_seed.sql, and 0035_resources_analyst_role_delta.sql via the Supabase Dashboard SQL editor for the DEV project, then re-run this suite.`
    );
  }

  const now = new Date();
  const past = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  publishedPostId = await createTestPost({ slug: `r1-1-test-published-${RUN_ID}`, status: 'published', visibility: 'public', published_at: past });
  scheduledPostId = await createTestPost({ slug: `r1-1-test-scheduled-${RUN_ID}`, status: 'scheduled', visibility: 'public', scheduled_at: future });
  draftPostId = await createTestPost({ status: 'draft', visibility: 'private' });

  ordinary = await makeTestUser('ordinary');
  author = await makeTestUser('author', 'author');
  editor = await makeTestUser('editor', 'editor');
  compliance = await makeTestUser('compliance', 'compliance_reviewer');
  publisher = await makeTestUser('publisher', 'publisher');
  analyst = await makeTestUser('analyst', 'analyst');
}, 60000);

afterAll(async () => {
  for (const id of createdPostIds) await admin.from('resource_posts').delete().eq('id', id);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

describe('Resources R1.1 — RLS: draft protection & public read', () => {
  it('anonymous CANNOT read a draft', async () => {
    const { data } = await anonClient.from('resource_posts').select('id').eq('id', draftPostId).maybeSingle();
    expect(data).toBeNull();
  });

  it('anonymous CAN read a published+public+past-dated post', async () => {
    const { data } = await anonClient.from('resource_posts').select('id').eq('id', publishedPostId).maybeSingle();
    expect(data?.id).toBe(publishedPostId);
  });

  it('anonymous CANNOT read scheduled (future) content even though visibility=public', async () => {
    const { data } = await anonClient.from('resource_posts').select('id').eq('id', scheduledPostId).maybeSingle();
    expect(data).toBeNull();
  });

  it('an ordinary authenticated FHIP customer gets the same read result as anonymous — logged in grants no extra CMS access', async () => {
    const { data: draftRead } = await ordinary.client.from('resource_posts').select('id').eq('id', draftPostId).maybeSingle();
    expect(draftRead).toBeNull();
    const { data: publishedRead } = await ordinary.client.from('resource_posts').select('id').eq('id', publishedPostId).maybeSingle();
    expect(publishedRead?.id).toBe(publishedPostId);
  });
});

describe('Resources R1.1 — Customer CMS isolation', () => {
  it('an ordinary customer cannot edit content, transition workflow, read audit log, read workflow history, or read Resources roles', async () => {
    // RLS on UPDATE filters rows via the USING clause silently — a customer
    // whose row doesn't match "staff update posts" gets a *successful*
    // response with zero rows affected, not a thrown error. `error` alone
    // is not sufficient evidence; assert the actual row was left unchanged.
    const { error: editErr, data: editData } = await ordinary.client.from('resource_posts').update({ title: 'hacked' }).eq('id', publishedPostId).select('id');
    expect(editErr).toBeNull(); // no error — this is expected Postgres RLS behavior, not a bypass
    expect(editData).toEqual([]); // zero rows affected — the real proof the write was blocked
    const { data: unchanged } = await admin.from('resource_posts').select('title').eq('id', publishedPostId).single();
    expect(unchanged?.title).not.toBe('hacked');

    const { error: rpcErr } = await ordinary.client.rpc('transition_resource_post_status', {
      p_post_id: draftPostId,
      p_to_status: 'editorial_review',
      p_reason: null,
      p_notes: null,
    });
    expect(rpcErr).not.toBeNull();

    const { data: auditRead } = await ordinary.client.from('resource_audit_log').select('id').limit(1);
    expect(auditRead).toEqual([]);

    const { data: historyRead } = await ordinary.client.from('resource_workflow_history').select('id').limit(1);
    expect(historyRead).toEqual([]);

    const { data: rolesRead } = await ordinary.client.from('resource_user_roles').select('id').neq('user_id', ordinary.userId).limit(1);
    expect(rolesRead).toEqual([]);
  });

  it('role escalation is denied — an ordinary customer cannot insert/update resource_user_roles for any role, including analyst', async () => {
    for (const role of ['resource_admin', 'publisher', 'compliance_reviewer', 'analyst']) {
      const { error } = await ordinary.client.from('resource_user_roles').insert({ user_id: ordinary.userId, role });
      expect(error).not.toBeNull();
    }
  });
});

describe('Resources R1.1 — Author cannot publish', () => {
  it('Author can create+edit a draft and submit for editorial review, but cannot publish directly or write status via PostgREST', async () => {
    const myDraftId = await createTestPost({ status: 'idea', visibility: 'private', created_by: author.userId });

    const { error: editErr } = await author.client.from('resource_posts').update({ title: 'Author-edited title' }).eq('id', myDraftId);
    expect(editErr).toBeNull();

    const { error: submitErr } = await author.client.rpc('transition_resource_post_status', {
      p_post_id: myDraftId, p_to_status: 'editorial_review', p_reason: null, p_notes: null,
    });
    expect(submitErr).toBeNull();

    const { error: publishRpcErr } = await author.client.rpc('transition_resource_post_status', {
      p_post_id: myDraftId, p_to_status: 'published', p_reason: null, p_notes: null,
    });
    expect(publishRpcErr).not.toBeNull();

    const { error: directWriteErr } = await author.client.from('resource_posts').update({ status: 'published' }).eq('id', myDraftId);
    expect(directWriteErr).not.toBeNull(); // column-level grant lockdown — no UPDATE grant on `status` for authenticated
  });
});

describe('Resources R1.1 — GREEN workflow (full live run)', () => {
  it('draft → editorial_review → approved → published succeeds with the right roles and records history + published_at', async () => {
    const postId = await createTestPost({ status: 'draft', visibility: 'public', compliance_classification: 'green', created_by: author.userId });

    let res = await editor.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'editorial_review', p_reason: 'ready', p_notes: null });
    expect(res.error).toBeNull();

    res = await editor.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'approved', p_reason: null, p_notes: null });
    expect(res.error).toBeNull();

    res = await publisher.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'published', p_reason: null, p_notes: null });
    expect(res.error).toBeNull();

    const { data: finalPost } = await admin.from('resource_posts').select('status, published_at, editorial_approved_by, compliance_approved_by').eq('id', postId).single();
    expect(finalPost?.status).toBe('published');
    expect(finalPost?.published_at).not.toBeNull();
    expect(finalPost?.editorial_approved_by).toBe(editor.userId);
    expect(finalPost?.compliance_approved_by).toBeNull(); // GREEN never requires compliance approval

    const { data: history } = await admin.from('resource_workflow_history').select('from_status, to_status, actor_user_id, action').eq('post_id', postId).order('created_at');
    expect(history?.map((h) => h.to_status)).toEqual(['editorial_review', 'approved', 'published']);
    expect(history?.every((h) => h.action === 'status_transition')).toBe(true);

    const { data: audit } = await admin.from('resource_audit_log').select('action, entity_type').eq('entity_id', postId);
    expect(audit?.length).toBe(3);
    expect(audit?.every((a) => a.entity_type === 'resource_post')).toBe(true);
  });
});

describe('Resources R1.1 — AMBER workflow (full live run + compliance enforcement)', () => {
  it('AMBER cannot reach approved via editorial approval alone; requires a real Compliance Reviewer approval before publish', async () => {
    const postId = await createTestPost({ status: 'draft', visibility: 'public', compliance_classification: 'amber', created_by: author.userId });

    let res = await editor.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'editorial_review', p_reason: null, p_notes: null });
    expect(res.error).toBeNull();

    // Editor alone attempting 'approved' on AMBER content must be denied.
    const editorApproveAttempt = await editor.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'approved', p_reason: null, p_notes: null });
    expect(editorApproveAttempt.error).not.toBeNull();

    res = await editor.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'compliance_review', p_reason: null, p_notes: null });
    expect(res.error).toBeNull();

    res = await compliance.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'approved', p_reason: null, p_notes: null });
    expect(res.error).toBeNull();

    res = await publisher.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'published', p_reason: null, p_notes: null });
    expect(res.error).toBeNull();

    const { data: finalPost } = await admin.from('resource_posts').select('status, compliance_approved_by, compliance_approved_at').eq('id', postId).single();
    expect(finalPost?.status).toBe('published');
    expect(finalPost?.compliance_approved_by).toBe(compliance.userId);
    expect(finalPost?.compliance_approved_at).not.toBeNull();
  });

  it('AMBER direct-write backstop: even a privileged service-role UPDATE cannot set published/approved on AMBER content without compliance fields — the CHECK constraint fires regardless of caller', async () => {
    const postId = await createTestPost({ status: 'compliance_review', visibility: 'public', compliance_classification: 'amber', created_by: author.userId });
    const { error } = await admin.from('resource_posts').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', postId);
    expect(error).not.toBeNull(); // chk_resource_posts_amber_requires_compliance
  });
});

describe('Resources R1.1 — RED workflow (structurally blocked from publication)', () => {
  it('RED cannot be scheduled or published via the RPC, even by a Publisher/Resource Admin-equivalent role, regardless of review state', async () => {
    const postId = await createTestPost({ status: 'compliance_review', visibility: 'public', compliance_classification: 'red', created_by: author.userId });

    const scheduleAttempt = await publisher.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'scheduled', p_reason: null, p_notes: null });
    expect(scheduleAttempt.error).not.toBeNull();

    const publishAttempt = await publisher.client.rpc('transition_resource_post_status', { p_post_id: postId, p_to_status: 'published', p_reason: null, p_notes: null });
    expect(publishAttempt.error).not.toBeNull();
  });

  it('RED direct-write backstop: a privileged service-role UPDATE cannot force RED into scheduled or published — CHECK constraint fires unconditionally', async () => {
    const postId = await createTestPost({ status: 'compliance_review', visibility: 'public', compliance_classification: 'red', created_by: author.userId });
    const scheduledResult = await admin.from('resource_posts').update({ status: 'scheduled', scheduled_at: new Date().toISOString() }).eq('id', postId);
    expect(scheduledResult.error).not.toBeNull();
    const publishedResult = await admin.from('resource_posts').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', postId);
    expect(publishedResult.error).not.toBeNull();
  });
});

describe('Resources R1.1 — Analyst role isolation', () => {
  it('Analyst cannot read drafts, cannot publish, cannot approve, cannot manage taxonomy, cannot manage roles', async () => {
    const { data: draftRead } = await analyst.client.from('resource_posts').select('id').eq('id', draftPostId).maybeSingle();
    expect(draftRead).toBeNull(); // is_resource_staff() deliberately excludes 'analyst'

    const publishAttempt = await analyst.client.rpc('transition_resource_post_status', { p_post_id: publishedPostId, p_to_status: 'archived', p_reason: null, p_notes: null });
    expect(publishAttempt.error).not.toBeNull();

    const amberPostId = await createTestPost({ status: 'compliance_review', visibility: 'public', compliance_classification: 'amber', created_by: author.userId });
    const approveAttempt = await analyst.client.rpc('transition_resource_post_status', { p_post_id: amberPostId, p_to_status: 'approved', p_reason: null, p_notes: null });
    expect(approveAttempt.error).not.toBeNull();

    const { error: categoryErr } = await analyst.client.from('resource_categories').insert({ name: 'Analyst test category', slug: `analyst-should-not-create-${RUN_ID}` });
    expect(categoryErr).not.toBeNull();

    const { error: roleErr } = await analyst.client.from('resource_user_roles').insert({ user_id: analyst.userId, role: 'resource_admin' });
    expect(roleErr).not.toBeNull();
  });
});

describe('Resources R1.1 — relationship & integrity constraints', () => {
  it('rejects a self-referencing related-content row', async () => {
    const { error } = await admin.from('resource_related_content').insert({ source_post_id: publishedPostId, related_post_id: publishedPostId });
    expect(error).not.toBeNull();
  });

  it('rejects a duplicate post/category mapping', async () => {
    const { data: category } = await admin.from('resource_categories').select('id').limit(1).single();
    if (!category) throw new Error('No category fixture available for this test');
    const first = await admin.from('resource_post_categories').insert({ post_id: publishedPostId, category_id: category.id });
    expect(first.error).toBeNull();
    const dup = await admin.from('resource_post_categories').insert({ post_id: publishedPostId, category_id: category.id });
    expect(dup.error).not.toBeNull();
    await admin.from('resource_post_categories').delete().eq('post_id', publishedPostId).eq('category_id', category.id);
  });

  it('rejects a duplicate post/tag mapping', async () => {
    const { data: tag } = await admin.from('resource_tags').insert({ name: `r1-1-test-tag-${RUN_ID}`, slug: `r1-1-test-tag-${RUN_ID}` }).select('id').single();
    if (!tag) throw new Error('Failed to create tag fixture');
    const first = await admin.from('resource_post_tags').insert({ post_id: publishedPostId, tag_id: tag.id });
    expect(first.error).toBeNull();
    const dup = await admin.from('resource_post_tags').insert({ post_id: publishedPostId, tag_id: tag.id });
    expect(dup.error).not.toBeNull();
    await admin.from('resource_post_tags').delete().eq('post_id', publishedPostId).eq('tag_id', tag.id);
    await admin.from('resource_tags').delete().eq('id', tag.id);
  });

  it('rejects an invalid foreign key (non-existent category on a post/category mapping)', async () => {
    const { error } = await admin.from('resource_post_categories').insert({ post_id: publishedPostId, category_id: '00000000-0000-0000-0000-000000000000' });
    expect(error).not.toBeNull();
  });

  it('rejects a duplicate 1:1 video record for the same post', async () => {
    const first = await admin.from('resource_videos').insert({ resource_post_id: publishedPostId, youtube_video_id: `test1-${RUN_ID}`, youtube_url: 'https://youtube.com/watch?v=test1' });
    expect(first.error).toBeNull();
    const dup = await admin.from('resource_videos').insert({ resource_post_id: publishedPostId, youtube_video_id: `test2-${RUN_ID}`, youtube_url: 'https://youtube.com/watch?v=test2' });
    expect(dup.error).not.toBeNull();
    await admin.from('resource_videos').delete().eq('resource_post_id', publishedPostId);
  });
});

describe('Resources R1.1 — slug & metadata integrity constraints', () => {
  it('rejects a duplicate post slug', async () => {
    const slug = `r1-1-test-dup-slug-${RUN_ID}`;
    const first = await admin.from('resource_posts').insert({ title: 'first', content_type: 'article', slug, status: 'draft' }).select('id').single();
    expect(first.error).toBeNull();
    if (first.data) createdPostIds.push(first.data.id);
    const dup = await admin.from('resource_posts').insert({ title: 'second', content_type: 'article', slug, status: 'draft' });
    expect(dup.error).not.toBeNull();
  });

  it('rejects a duplicate category slug', async () => {
    const slug = `r1-1-test-dup-cat-${RUN_ID}`;
    const first = await admin.from('resource_categories').insert({ name: 'first', slug });
    expect(first.error).toBeNull();
    const dup = await admin.from('resource_categories').insert({ name: 'second', slug });
    expect(dup.error).not.toBeNull();
    await admin.from('resource_categories').delete().eq('slug', slug);
  });

  it('rejects a duplicate tag slug', async () => {
    const slug = `r1-1-test-dup-tag-${RUN_ID}`;
    const first = await admin.from('resource_tags').insert({ name: 'first', slug });
    expect(first.error).toBeNull();
    const dup = await admin.from('resource_tags').insert({ name: 'second', slug });
    expect(dup.error).not.toBeNull();
    await admin.from('resource_tags').delete().eq('slug', slug);
  });

  it('rejects status=scheduled without scheduled_at', async () => {
    const { error } = await admin.from('resource_posts').insert({ title: 'bad-scheduled', content_type: 'article', slug: `r1-1-test-bad-sched-${RUN_ID}`, status: 'scheduled' });
    expect(error).not.toBeNull();
  });

  it('rejects status=published without published_at', async () => {
    const { error } = await admin.from('resource_posts').insert({ title: 'bad-published', content_type: 'article', slug: `r1-1-test-bad-pub-${RUN_ID}`, status: 'published' });
    expect(error).not.toBeNull();
  });
});
