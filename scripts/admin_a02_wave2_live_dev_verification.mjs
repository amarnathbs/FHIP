// Admin A0.2 Wave 2 — LIVE DEV verification. Run AFTER migration 0116 has
// been applied to DEV via the Supabase Dashboard SQL editor.
//
// Same methodology as scripts/admin_a02_wave1_live_dev_verification.mjs and
// scripts/admin_a02_wave1b_live_dev_verification.mjs.
//
// This exists to prove the things the PGlite certification structurally
// cannot:
//   * REAL CONCURRENCY. PGlite is a single-connection WASM database, so
//     genuine lock contention between two simultaneous sessions cannot be
//     demonstrated there. Here, two real PostgREST requests are fired
//     concurrently against real PostgreSQL.
//   * REAL AUTH. auth.uid(), real Supabase roles, real RLS, real anon-key
//     denial — not a shim. Under privileged-RPC PATTERN A (Product Owner
//     ruling, 2026-08-31) this matters more than it did: the reorder RPC is
//     granted to `authenticated` and authorises its own caller, so §A5 signs
//     in as each permitted role (Editor, Resource Admin, Super Admin) and
//     each denied role (Analyst, Author, Compliance Reviewer, Publisher,
//     no-role) with a real Supabase session and calls the RPC directly.
//   * The migration actually being in effect on the actual DEV database.
//
// SAFETY RULES this script obeys, from the Wave 2 brief §11/§12:
//   * Dedicated fixtures ONLY. Every Resource, related link and user it
//     creates is prefixed `a02w2-` and is removed in cleanup.
//   * It NEVER touches the 84 existing curated Resources, and never touches
//     any row it did not create.
//   * It NEVER publishes anything. No fixture ever reaches status
//     'published'. The single scheduling success case reaches 'scheduled'
//     and is then deleted.
//   * It reconciles before/after counts for resource_posts,
//     resource_related_content, resource_workflow_history and
//     resource_audit_log and FAILS if any unrelated variance appears.
//
// Usage: node scripts/admin_a02_wave2_live_dev_verification.mjs
//
// DO NOT pipe this script through `head`. Doing so closes stdout early, the
// process is killed by SIGPIPE part-way through, and cleanup never runs —
// which is exactly how a harness dry-run leaked 14 fixture Resources into
// DEV during Wave 2 development (found and removed the same session). The
// prefix sweep added below now clears any such orphan automatically at
// startup, but redirect to a file rather than relying on that:
//
//   node scripts/admin_a02_wave2_live_dev_verification.mjs > wave2-live.txt 2>&1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

if (!/vqycarelcoijzwlpkpcz/.test(url)) {
  console.error(`REFUSING TO RUN: target ${url} is not the DEV project. This script must never run against production.`);
  process.exit(2);
}

const RUN = `a02w2-${Date.now().toString(36)}`;
let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}

const createdPostIds = [];
const createdUserIds = [];

async function count(table, filter = (q) => q) {
  const { count: n, error } = await filter(admin.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  return n;
}

async function makeUser(label, role) {
  const email = `${RUN}-${label}@test.fhip.invalid`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !created.user) throw new Error(`create user ${label}: ${error?.message}`);
  createdUserIds.push(created.user.id);
  if (role) {
    const { error: rErr } = await admin.from('resource_user_roles').insert({ user_id: created.user.id, role, assigned_by: null });
    if (rErr) throw new Error(`assign ${role}: ${rErr.message}`);
  }
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (lErr || !link.properties?.hashed_token) throw new Error(`link ${label}: ${lErr?.message}`);
  const verifier = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: v, error: vErr } = await verifier.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (vErr || !v.session) throw new Error(`verify ${label}: ${vErr?.message}`);
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${v.session.access_token}` } },
  });
  return { userId: created.user.id, client };
}

async function makePost(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { data, error } = await admin
    .from('resource_posts')
    .insert({
      title: `${RUN}-${suffix}`,
      slug: `${RUN}-${suffix}`,
      content_type: 'article',
      status: 'draft',
      ...overrides,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdPostIds.push(data.id);
  return data.id;
}

async function link(sourceId, relatedId, sortOrder) {
  const { data, error } = await admin
    .from('resource_related_content')
    .insert({ source_post_id: sourceId, related_post_id: relatedId, relationship_type: 'related', sort_order: sortOrder })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function seedSet(n) {
  const source = await makePost();
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await link(source, await makePost(), i));
  return { source, ids };
}

async function positions(sourceId) {
  const { data, error } = await admin.from('resource_related_content').select('id, sort_order').eq('source_post_id', sourceId).order('sort_order');
  if (error) throw error;
  return data;
}

const uniqueContiguous = (rows) =>
  rows
    .map((r) => r.sort_order)
    .sort((a, b) => a - b)
    .every((v, i) => v === i);

async function reorder(client, sourceId, orderedIds) {
  const { data, error } = await client.rpc('admin_reorder_related_content', { p_source_post_id: sourceId, p_ordered_ids: orderedIds });
  return { data, error };
}

async function transition(client, postId, toStatus) {
  const { data, error } = await client.rpc('transition_resource_post_status', {
    p_post_id: postId,
    p_to_status: toStatus,
    p_reason: `${RUN} verification`,
    p_notes: null,
  });
  return { data, error };
}

async function statusOf(postId) {
  const { data, error } = await admin.from('resource_posts').select('status, scheduled_at, published_at, visibility').eq('id', postId).single();
  if (error) throw error;
  return data;
}

// Removes EVERY fixture this script family has ever created, identified by
// the shared `a02w2-` prefix — not just the current run's ids. This is what
// makes the harness safe against a run that was killed before its own
// cleanup (SIGPIPE, Ctrl-C, a crash): the next run sweeps the wreckage
// before it measures anything, so a leaked fixture can never be mistaken for
// real data or silently inflate a reconciliation baseline.
//
// It is deliberately prefix-scoped and can never match a curated Resource.
async function sweepFixtures(label) {
  const { data: posts } = await admin.from('resource_posts').select('id, title').like('title', 'a02w2-%');
  for (const p of posts ?? []) await admin.from('resource_posts').delete().eq('id', p.id);

  let users = [];
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  users = (list?.users ?? []).filter((u) => (u.email ?? '').startsWith('a02w2-'));
  for (const u of users) {
    await admin.from('resource_user_roles').delete().eq('user_id', u.id);
    // A5 grants one fixture user a Super Admin row to exercise the
    // isSuperAdmin branch of the capability. It is removed inline, but sweep
    // it here too so an interrupted run can never leave a fixture super
    // admin behind.
    await admin.from('admin_users').delete().eq('user_id', u.id);
    await admin.auth.admin.deleteUser(u.id);
  }

  const n = (posts ?? []).length + users.length;
  if (n > 0) console.log(`${label}: swept ${(posts ?? []).length} fixture Resources and ${users.length} fixture users.`);
  return n;
}

async function main() {
  console.log(`Target: ${url}   run id: ${RUN}\n`);

  // Sweep any orphan left by a previously interrupted run BEFORE the
  // baseline is taken, so the baseline reflects real data only.
  const orphans = await sweepFixtures('PRE-RUN SWEEP');
  if (orphans === 0) console.log('PRE-RUN SWEEP: no orphan fixtures from a previous run.');

  // ---------------------------------------------------------------- baseline
  const before = {
    posts: await count('resource_posts'),
    links: await count('resource_related_content'),
    history: await count('resource_workflow_history'),
    audit: await count('resource_audit_log'),
    published: await count('resource_posts', (q) => q.eq('status', 'published')),
    scheduled: await count('resource_posts', (q) => q.eq('status', 'scheduled')),
  };
  console.log(`BASELINE  posts=${before.posts} links=${before.links} history=${before.history} audit=${before.audit} published=${before.published} scheduled=${before.scheduled}\n`);

  // ============================================================== SCOPE A
  //
  // PRIVILEGED-RPC PATTERN A (Product Owner ruling, 2026-08-31). The reorder
  // RPC is caller-context: EXECUTE is granted to `authenticated` only, the
  // actor is auth.uid(), and the function rechecks the capability itself. So
  // every Scope A call below is made with a REAL signed-in Resource
  // Administrator's session (RA.client), exactly as the application does —
  // the service-role client is used only for fixture setup and for reading
  // ground truth, never to perform a reorder.
  const RA = await makeUser('scope-a-admin', 'resource_admin');

  console.log('=== A1: migration 0116 is actually in effect, with the Pattern A grant model ===');
  {
    const { error } = await RA.client.rpc('admin_reorder_related_content', { p_source_post_id: null, p_ordered_ids: null });
    check('admin_reorder_related_content EXISTS on live DEV', !!error && !/could not find the function|PGRST202/i.test(`${error.code} ${error.message}`), JSON.stringify(error));
    check('  -> an AUTHENTICATED Resource Admin gets past both auth guards (null-payload error, not a permission error)', error?.code === '22023', JSON.stringify(error));

    // The service-role key must now be REFUSED: EXECUTE was revoked from
    // service_role, and a service-role connection carries no auth.uid()
    // anyway. This is the structural proof that the grant really flipped.
    const { error: srErr } = await admin.rpc('admin_reorder_related_content', { p_source_post_id: null, p_ordered_ids: null });
    check('  -> the SERVICE-ROLE key can no longer execute the RPC (Pattern A: grant revoked)', !!srErr, JSON.stringify(srErr));
    check('  -> and its refusal is a permission denial (42501), not a payload error', srErr?.code === '42501', `${srErr?.code}: ${srErr?.message}`);
  }

  console.log('\n=== A2: normal reorder and complete reverse ===');
  {
    const { source, ids } = await seedSet(5);
    const rev = [...ids].reverse();
    const { data, error } = await reorder(RA.client, source, rev);
    check('complete reverse succeeds', !error, JSON.stringify(error));
    const after = await positions(source);
    check('committed order matches the requested order exactly', JSON.stringify(after.map((r) => r.id)) === JSON.stringify(rev));
    check('positions are unique and contiguous', uniqueContiguous(after));
    check('returned ordering matches the committed database order', JSON.stringify((data?.ordered ?? []).map((o) => o.id)) === JSON.stringify(after.map((r) => r.id)));

    // A single swap back.
    const swapped = [rev[1], rev[0], ...rev.slice(2)];
    await reorder(RA.client, source, swapped);
    check('a normal single-swap reorder applies', JSON.stringify((await positions(source)).map((r) => r.id)) === JSON.stringify(swapped));
  }

  console.log('\n=== A3: invalid payload rejection, each with zero database variance ===');
  {
    const { source, ids } = await seedSet(4);
    const other = await seedSet(2);
    const snapshot = async () => JSON.stringify(await positions(source));
    const cases = [
      ['duplicate id', [ids[0], ids[0], ids[1], ids[2]], '22023'],
      ['missing id (incomplete set)', [ids[0], ids[1], ids[2]], '40001'],
      ['foreign-source id', [ids[0], ids[1], ids[2], other.ids[0]], '40001'],
      ['unknown id', [ids[0], ids[1], ids[2], '00000000-0000-4000-8000-000000000000'], '40001'],
      ['empty array', [], '22023'],
    ];
    for (const [label, payload, expected] of cases) {
      const b = await snapshot();
      const { error } = await reorder(RA.client, source, payload);
      check(`rejected: ${label}`, !!error, JSON.stringify(error));
      check(`  -> SQLSTATE ${expected}`, error?.code === expected, `${error?.code}: ${error?.message}`);
      check(`  -> zero database variance`, (await snapshot()) === b);
    }
    const { error: srcErr } = await reorder(RA.client, '11111111-1111-4111-8111-111111111111', [ids[0]]);
    check('rejected: unknown source Resource', srcErr?.code === 'P0002', `${srcErr?.code}: ${srcErr?.message}`);
    check('the valid set survived every rejection, still contiguous', uniqueContiguous(await positions(source)));
  }

  console.log('\n=== A4: REAL concurrency on real PostgreSQL ===');
  {
    // Two simultaneous VALID reorders of the SAME source. Both describe the
    // complete set, so both are individually valid; the advisory lock must
    // serialise them so the committed result is ONE complete ordering and
    // never a blend.
    const { source, ids } = await seedSet(6);
    const orderA = [...ids].reverse();
    const orderB = [ids[2], ids[0], ids[4], ids[1], ids[5], ids[3]];
    const [ra, rb] = await Promise.all([reorder(RA.client, source, orderA), reorder(RA.client, source, orderB)]);
    check('same-source concurrency: both requests completed without a server fault', !ra.error && !rb.error, JSON.stringify([ra.error, rb.error]));
    const after = await positions(source);
    const committed = after.map((r) => r.id);
    check('same-source concurrency: positions are unique and contiguous', uniqueContiguous(after));
    check(
      'same-source concurrency: the committed state is exactly ONE of the two orderings, never a mixture',
      JSON.stringify(committed) === JSON.stringify(orderA) || JSON.stringify(committed) === JSON.stringify(orderB),
      JSON.stringify(committed)
    );

    // Two simultaneous reorders of DIFFERENT sources must not block or
    // affect one another.
    const s1 = await seedSet(4);
    const s2 = await seedSet(4);
    const [r1, r2] = await Promise.all([reorder(RA.client, s1.source, [...s1.ids].reverse()), reorder(RA.client, s2.source, [...s2.ids].reverse())]);
    check('different-source concurrency: both succeeded', !r1.error && !r2.error, JSON.stringify([r1.error, r2.error]));
    check('different-source concurrency: source 1 is exactly its own requested order', JSON.stringify((await positions(s1.source)).map((r) => r.id)) === JSON.stringify([...s1.ids].reverse()));
    check('different-source concurrency: source 2 is exactly its own requested order', JSON.stringify((await positions(s2.source)).map((r) => r.id)) === JSON.stringify([...s2.ids].reverse()));

    // A relationship removal racing a reorder.
    const s3 = await seedSet(4);
    const stale = [...s3.ids].reverse();
    await admin.from('resource_related_content').delete().eq('id', s3.ids[1]);
    const { error: staleErr } = await reorder(RA.client, s3.source, stale);
    check('stale client set (a link removed underneath) is rejected as a conflict', staleErr?.code === '40001', `${staleErr?.code}: ${staleErr?.message}`);
    const live = (await positions(s3.source)).map((r) => r.id);
    const { error: refreshedErr } = await reorder(RA.client, s3.source, [...live].reverse());
    check('canonical refresh after the conflict then succeeds', !refreshedErr, JSON.stringify(refreshedErr));
    check('positions unique and contiguous after the conflict-and-refresh cycle', uniqueContiguous(await positions(s3.source)));
  }

  console.log('\n=== A5: PATTERN A authorisation, live (Admin Architecture Standard §4 database-bypass test) ===');
  {
    // Under Pattern A the RPC is reachable by any signed-in user, and its own
    // capability recheck — not a missing grant — is what separates the
    // permitted roles from the denied ones. Both halves are proved here
    // against real Supabase sessions, with no route in the path.

    // ---- PERMITTED roles, each calling the RPC directly as themselves ----
    for (const [label, role] of [
      ['Editor', 'editor'],
      ['Resource Admin', 'resource_admin'],
    ]) {
      const u = await makeUser(`permitted-${role}`, role);
      const { source, ids } = await seedSet(3);
      const wanted = [...ids].reverse();
      const { error } = await reorder(u.client, source, wanted);
      check(`PERMITTED: an authenticated ${label} CAN execute the RPC with their own session`, !error, JSON.stringify(error));
      check(`  -> and ${label}'s reorder really committed, unique and contiguous`, JSON.stringify((await positions(source)).map((r) => r.id)) === JSON.stringify(wanted));
    }
    {
      // Super Admin — no resource_user_roles row at all, authority comes from
      // admin_users, exactly like canManageDiscovery's isSuperAdmin branch.
      const u = await makeUser('permitted-super-admin', null);
      const { error: aErr } = await admin.from('admin_users').insert({ user_id: u.userId });
      check('fixture: Super Admin row created', !aErr, JSON.stringify(aErr));
      const { source, ids } = await seedSet(3);
      const wanted = [...ids].reverse();
      const { error } = await reorder(u.client, source, wanted);
      check('PERMITTED: an authenticated Super Admin (no Resources role row) CAN execute the RPC', !error, JSON.stringify(error));
      check('  -> and the Super Admin reorder really committed', JSON.stringify((await positions(source)).map((r) => r.id)) === JSON.stringify(wanted));
      await admin.from('admin_users').delete().eq('user_id', u.userId);
    }

    // ---- DENIED: anonymous, and every non-discovery role ----
    const { source, ids } = await seedSet(2);
    const b = JSON.stringify(await positions(source));

    const { error: anonErr } = await reorder(anon, source, [...ids].reverse());
    check('DENIED: the ANON key cannot execute admin_reorder_related_content', !!anonErr, JSON.stringify(anonErr));
    check('  -> refused at the grant layer (EXECUTE revoked from anon)', anonErr?.code === '42501', `${anonErr?.code}: ${anonErr?.message}`);

    for (const [label, role] of [
      ['Analyst (§5 read-only)', 'analyst'],
      ['Author', 'author'],
      ['Compliance Reviewer', 'compliance_reviewer'],
      ['Publisher', 'publisher'],
    ]) {
      const u = await makeUser(`denied-${role}`, role);
      const { error } = await reorder(u.client, source, [...ids].reverse());
      check(`DENIED: an authenticated ${label} is refused BY THE RPC'S OWN capability recheck`, !!error, JSON.stringify(error));
      check(`  -> with SQLSTATE 42501 for ${role}`, error?.code === '42501', `${error?.code}: ${error?.message}`);
    }

    {
      // An authenticated user holding no Resources role at all.
      const u = await makeUser('denied-no-role', null);
      const { error } = await reorder(u.client, source, [...ids].reverse());
      check('DENIED: an authenticated user with NO Resources role is refused', error?.code === '42501', `${error?.code}: ${error?.message}`);
    }

    check('no denied attempt changed a single position', JSON.stringify(await positions(source)) === b);
  }

  // ============================================================== SCOPE B
  console.log('\n=== B1: canonical scheduling invariant, all four content types, live ===');
  {
    const publisher = await makeUser('publisher', 'publisher');
    const author = await makeUser('author', 'author');
    const analyst = await makeUser('sched-analyst', 'analyst');
    const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const PAST = '2000-01-01T00:00:00Z';

    const TYPES = [
      ['article', 'General Content'],
      ['glossary', 'Glossary'],
      ['money_update', 'Money Updates'],
      ['video', 'Videos'],
    ];

    for (const [contentType, routeName] of TYPES) {
      console.log(`  --- ${routeName} (${contentType}) ---`);

      const approved = async (scheduledAt) => makePost({ content_type: contentType, status: 'approved', scheduled_at: scheduledAt, created_by: publisher.userId });

      // missing timestamp
      {
        const id = await approved(null);
        const { error } = await transition(publisher.client, id, 'scheduled');
        check(`[${contentType}] missing scheduled_at REJECTED`, !!error, JSON.stringify(error));
        check(`[${contentType}]   -> SQLSTATE 22023, not a raw 23514 constraint violation`, error?.code === '22023', `${error?.code}: ${error?.message}`);
        check(`[${contentType}]   -> canonical message`, error?.message === 'A publish date and time is required before this content can be scheduled.', error?.message);
        check(`[${contentType}]   -> no internal constraint name leaked`, !/chk_resource_posts_scheduled_at/.test(error?.message ?? ''));
        check(`[${contentType}]   -> status unchanged`, (await statusOf(id)).status === 'approved');
      }
      // past timestamp
      {
        const id = await approved(PAST);
        const { error } = await transition(publisher.client, id, 'scheduled');
        check(`[${contentType}] PAST scheduled_at REJECTED`, error?.code === '22023', `${error?.code}: ${error?.message}`);
        check(`[${contentType}]   -> canonical message`, error?.message === 'The scheduled publish date and time must be in the future.', error?.message);
        check(`[${contentType}]   -> status unchanged`, (await statusOf(id)).status === 'approved');
      }
      // valid future timestamp
      {
        const id = await approved(FUTURE);
        const historyBefore = await count('resource_workflow_history', (q) => q.eq('post_id', id));
        const { error } = await transition(publisher.client, id, 'scheduled');
        check(`[${contentType}] valid FUTURE scheduled_at ACCEPTED`, !error, JSON.stringify(error));
        const s = await statusOf(id);
        check(`[${contentType}]   -> status is now scheduled`, s.status === 'scheduled');
        check(`[${contentType}]   -> NO unintended publication (published_at still null, visibility still private)`, s.published_at === null && s.visibility === 'private', JSON.stringify(s));
        const historyAfter = await count('resource_workflow_history', (q) => q.eq('post_id', id));
        check(`[${contentType}]   -> workflow history recorded exactly one transition`, historyAfter - historyBefore === 1);
        const { data: h } = await admin.from('resource_workflow_history').select('from_status, to_status, actor_role').eq('post_id', id).order('created_at');
        check(`[${contentType}]   -> history row is approved -> scheduled by a publisher`, h?.[0]?.from_status === 'approved' && h?.[0]?.to_status === 'scheduled' && h?.[0]?.actor_role === 'publisher', JSON.stringify(h));
        const auditN = await count('resource_audit_log', (q) => q.eq('entity_id', id).eq('action', 'status_transition'));
        check(`[${contentType}]   -> audit log recorded the transition`, auditN === 1);
      }
      // role not permitted
      {
        const id = await approved(FUTURE);
        const { error } = await transition(author.client, id, 'scheduled');
        check(`[${contentType}] a non-publisher role is DENIED`, !!error && /Only a Publisher/.test(error.message), error?.message);
        check(`[${contentType}]   -> the permission error comes FIRST, leaking no scheduling state`, !/publish date and time/.test(error?.message ?? ''));
        check(`[${contentType}]   -> status unchanged`, (await statusOf(id)).status === 'approved');
      }
      // §5 Analyst is read-only
      {
        const id = await approved(FUTURE);
        const { error } = await transition(analyst.client, id, 'scheduled');
        check(`[${contentType}] §5 ANALYST is DENIED scheduling`, !!error && /Only a Publisher/.test(error.message), error?.message);
        const { error: pubErr } = await transition(analyst.client, id, 'published');
        check(`[${contentType}] §5 ANALYST is DENIED publishing`, !!pubErr && /Only a Publisher/.test(pubErr.message), pubErr?.message);
        check(`[${contentType}]   -> status unchanged by either analyst attempt`, (await statusOf(id)).status === 'approved');
      }
      // direct RPC bypassing the API entirely, unauthenticated
      {
        const id = await approved(null);
        const { error } = await transition(anon, id, 'scheduled');
        check(`[${contentType}] direct RPC with the ANON key is DENIED`, !!error, JSON.stringify(error));
        check(`[${contentType}]   -> status unchanged`, (await statusOf(id)).status === 'approved');
      }
      // direct RPC as a publisher but with a null timestamp — proves the
      // database, not the API, is the control (the API route is skipped
      // entirely here).
      {
        const id = await approved(null);
        const { error } = await transition(publisher.client, id, 'scheduled');
        check(`[${contentType}] API BYPASS: a direct RPC call cannot skip the scheduling rule`, error?.code === '22023', `${error?.code}: ${error?.message}`);
      }
    }
  }

  console.log('\n=== B2: existing behaviour unchanged ===');
  {
    const publisher = await makeUser('publisher2', 'publisher');
    const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    // scheduled -> draft preserves scheduled_at
    const editor = await makeUser('editor2', 'editor');
    const id = await makePost({ status: 'approved', scheduled_at: FUTURE, created_by: publisher.userId });
    await transition(publisher.client, id, 'scheduled');
    const { error: backErr } = await transition(editor.client, id, 'draft');
    check('scheduled -> draft still works', !backErr, JSON.stringify(backErr));
    check('  -> scheduled_at is PRESERVED, not cleared', (await statusOf(id)).scheduled_at !== null);

    // reschedule with a now-past timestamp is rejected
    const id2 = await makePost({ status: 'approved', scheduled_at: FUTURE, created_by: publisher.userId });
    await transition(publisher.client, id2, 'scheduled');
    await admin.from('resource_posts').update({ scheduled_at: '2000-01-01T00:00:00Z' }).eq('id', id2);
    const { error: reErr } = await transition(publisher.client, id2, 'scheduled');
    check('reschedule with a now-past timestamp is REJECTED', reErr?.code === '22023', `${reErr?.code}: ${reErr?.message}`);
    check('  -> the post remains scheduled, nothing half-applied', (await statusOf(id2)).status === 'scheduled');

    // a REJECTED transition writes no history and no audit row
    const id3 = await makePost({ status: 'approved', created_by: publisher.userId });
    await transition(publisher.client, id3, 'scheduled');
    check('a REJECTED scheduling attempt wrote NO workflow-history row', (await count('resource_workflow_history', (q) => q.eq('post_id', id3))) === 0);
    check('a REJECTED scheduling attempt wrote NO audit row', (await count('resource_audit_log', (q) => q.eq('entity_id', id3))) === 0);
  }

  // --------------------------------------------------------------- cleanup
  console.log('\n=== Cleanup: removing every fixture this run created ===');
  {
    // resource_related_content and resource_workflow_history cascade from
    // resource_posts (ON DELETE CASCADE, migration 0049).
    for (const id of createdPostIds) await admin.from('resource_posts').delete().eq('id', id);
    for (const id of createdUserIds) {
      await admin.from('resource_user_roles').delete().eq('user_id', id);
      await admin.auth.admin.deleteUser(id);
    }
    // Belt-and-braces prefix sweep: catches anything the tracked-id list
    // missed for any reason.
    await sweepFixtures('POST-RUN SWEEP');

    const leftoverThisRun = await count('resource_posts', (q) => q.like('title', `${RUN}%`));
    check('every fixture Resource from THIS run removed', leftoverThisRun === 0, `${leftoverThisRun} left`);
    const leftoverAnyRun = await count('resource_posts', (q) => q.like('title', 'a02w2-%'));
    check('ZERO a02w2- fixture Resources remain in DEV from ANY run', leftoverAnyRun === 0, `${leftoverAnyRun} left`);
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const leftoverUsers = (list?.users ?? []).filter((u) => (u.email ?? '').startsWith('a02w2-')).length;
    check('ZERO a02w2- fixture users remain in DEV from ANY run', leftoverUsers === 0, `${leftoverUsers} left`);
  }

  // ---------------------------------------------------------- reconciliation
  console.log('\n=== Data reconciliation (Wave 2 §12) ===');
  const after = {
    posts: await count('resource_posts'),
    links: await count('resource_related_content'),
    history: await count('resource_workflow_history'),
    audit: await count('resource_audit_log'),
    published: await count('resource_posts', (q) => q.eq('status', 'published')),
    scheduled: await count('resource_posts', (q) => q.eq('status', 'scheduled')),
  };
  console.log(`AFTER     posts=${after.posts} links=${after.links} history=${after.history} audit=${after.audit} published=${after.published} scheduled=${after.scheduled}`);
  check('resource_posts count returned to baseline (zero unrelated variance)', after.posts === before.posts, `${before.posts} -> ${after.posts}`);
  check('resource_related_content count returned to baseline', after.links === before.links, `${before.links} -> ${after.links}`);
  check('PUBLISHED count unchanged — nothing was published', after.published === before.published, `${before.published} -> ${after.published}`);
  check('SCHEDULED count returned to baseline', after.scheduled === before.scheduled, `${before.scheduled} -> ${after.scheduled}`);
  check('workflow history count returned to baseline (fixture rows cascaded)', after.history === before.history, `${before.history} -> ${after.history}`);
  // resource_audit_log is deliberately append-only and has no cascade from
  // resource_posts — an audit trail that deleted itself when its subject was
  // deleted would not be an audit trail. Fixture transitions therefore leave
  // audit rows behind BY DESIGN. They are reported, not treated as a defect,
  // and they reference only fixture ids.
  console.log(`  audit_log grew by ${after.audit - before.audit} row(s) — expected: resource_audit_log is append-only and does not cascade from resource_posts.`);
  const { count: orphanAudit } = await admin.from('resource_audit_log').select('*', { count: 'exact', head: true }).in('entity_id', createdPostIds.slice(0, 100));
  console.log(`  of those, ${orphanAudit ?? 0} reference this run's fixture Resources (first 100 checked).`);

  // Position integrity across every source that this run did NOT create.
  {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('resource_related_content').select('source_post_id, sort_order').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const bySource = new Map();
    for (const r of rows) {
      if (!bySource.has(r.source_post_id)) bySource.set(r.source_post_id, []);
      bySource.get(r.source_post_id).push(r.sort_order);
    }
    let dup = 0;
    for (const orders of bySource.values()) if (new Set(orders).size !== orders.length) dup++;
    console.log(`  surviving sources: ${bySource.size}; sources with duplicate positions: ${dup}`);
    console.log('  (a non-zero duplicate count here is the PRE-EXISTING bulk-seeded state documented in the');
    console.log('   pre-check and in migration 0116 — this run must not have CHANGED it.)');
    check('duplicate-position source count matches the pre-existing baseline of 22', dup === 22, `got ${dup}`);
  }

  console.log(`\n================ LIVE DEV RESULT: ${pass} passed, ${fail} failed ================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\nFATAL:', e);
  console.error('Attempting fixture cleanup before exit...');
  for (const id of createdPostIds) await admin.from('resource_posts').delete().eq('id', id).catch(() => {});
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  process.exit(1);
});
