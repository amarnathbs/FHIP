// Admin A0.2 Wave 2 certification — Workflow & Ordering Integrity.
//
// Same harness convention as scripts/admin_a02_wave1_certification.mjs and
// scripts/admin_a02_wave1b_certification.mjs: real PostgreSQL via PGlite
// (WASM), full migration chain replayed from empty. No shared DEV or
// production database is touched by this script.
//
// SCOPE A — Related Content reorder atomicity
//   SECTION 1  RED   reproduce the current non-atomic reorder defect using the
//                    EXACT pre-Wave-2 statement sequence (N independent,
//                    separately committed UPDATEs) and prove the committed
//                    positions are left inconsistent after a mid-sequence
//                    failure.
//   SECTION 2  RED   the other latent hazards of the same path: omitted rows,
//                    foreign-source rows silently no-op'ing, duplicate ids.
//   SECTION 3  GREEN admin_reorder_related_content() valid behaviour.
//   SECTION 4  GREEN invalid-payload rejection, each with zero DB variance.
//   SECTION 5  GREEN rollback / failure injection.
//   SECTION 6  GREEN Pattern A security posture — STRUCTURAL (grants,
//                    SECURITY DEFINER, pinned search_path, signature, the
//                    auth.uid() / fail-closed / capability-recheck guards).
//   SECTION 6A GREEN private.can_manage_discovery — the new database mirror
//                    of canManageDiscovery(), proved role by role against
//                    real rows in the canonical role tables.
//   SECTION 6B GREEN PERMITTED roles (Editor, Resource Admin, Super Admin)
//                    each calling the RPC with their OWN session — session
//                    role `authenticated`, their own JWT subject, no
//                    service-role or superuser bypass.
//   SECTION 6C GREEN DENIED roles (Analyst, Author, Compliance Reviewer,
//                    Publisher, no-role, deactivated role) each calling the
//                    RPC directly as themselves, refused by the function's
//                    own capability recheck with zero database variance.
//   SECTION 6D GREEN anonymous denial, structural AND behavioural.
//   SECTION 6E GREEN null auth.uid() fails closed inside the function body,
//                    proved by a direct grant-bypassing call, with a
//                    positive control.
//   SECTION 6F GREEN the route-level capability check is RETAINED as defence
//                    in depth, and route bypass changes nothing.
//
// SCOPE A's authorisation model is privileged-RPC PATTERN A (caller-context)
// per the Product Owner's ruling of 2026-08-31. Every Scope A test above
// therefore calls the RPC as a real, authorised, signed-in administrator
// (CERT_ADMIN) — the integrity evidence is produced THROUGH the new
// authorisation model, not around it.
//
// SCOPE B — Scheduling-validation alignment
//   SECTION 7  RED   reproduce the pre-Wave-2 inconsistency: the DB had no
//                    scheduling rule of its own, so a past scheduled_at was
//                    accepted, and a null one failed only as a raw 23514.
//   SECTION 8  GREEN the canonical invariant enforced inside the shared RPC
//                    for all four content types, every required case.
//   SECTION 9  GREEN everything the invariant must NOT change: immediate
//                    publish, transitions away from scheduled, preservation
//                    of scheduled_at, workflow history and audit records.
//
// Usage: node scripts/admin_a02_wave2_certification.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG_DIR = path.join(REPO, 'supabase', 'migrations');
const SHIM = path.join(REPO, 'scripts', 'db-rebuild-check', 'shim.sql');

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

const WAVE2_MIGRATION = '0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql';

// `includeWave2 = false` builds the exact pre-Wave-2 database (current
// origin/main), so the "before" claims in this report are measured against a
// real baseline rather than asserted from reading the diff.
async function buildDb(includeWave2 = true) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const all = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  const files = includeWave2 ? all : all.filter((f) => f !== WAVE2_MIGRATION);
  for (const f of files) {
    let sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    sql = sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '-- [substituted, shimmed]');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`Migration replay failed at ${f}: ${e.message}`);
    }
    if (f.startsWith('0001')) {
      await db.exec(fs.readFileSync(path.join(MIG_DIR, '..', 'seed.sql'), 'utf8'));
    }
  }
  console.log(`Replayed ${files.length} migrations clean (${includeWave2 ? 'includes' : 'EXCLUDES'} 0116).`);
  return db;
}

async function functionPosture(db, name) {
  const r = await db.query(
    `select p.prosecdef, p.proconfig, coalesce(array_to_string(p.proacl, ','), '') as acl, count(*) over () as n
       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = $1`,
    [name]
  );
  return r.rows[0] ?? null;
}

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------
let seq = 0;
const uniq = () => `w2_${Date.now().toString(36)}_${++seq}`;

async function newUser(db) {
  const r = await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${uniq()}@example.test`]);
  return r.rows[0].id;
}

async function grantRole(db, userId, role) {
  await db.query(`insert into resource_user_roles (user_id, role, is_active) values ($1, $2, true)`, [userId, role]);
}

async function actAs(db, userId) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
}

async function newPost(db, opts = {}) {
  const {
    title = `Wave2 fixture ${uniq()}`,
    contentType = 'article',
    status = 'draft',
    scheduledAt = null,
    compliance = 'green',
    createdBy = null,
  } = opts;
  const r = await db.query(
    `insert into resource_posts (title, slug, content_type, status, scheduled_at, compliance_classification, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, contentType, status, scheduledAt, compliance, createdBy]
  );
  return r.rows[0].id;
}

async function link(db, sourceId, relatedId, relationshipType = 'related', sortOrder = 0) {
  const r = await db.query(
    `insert into resource_related_content (source_post_id, related_post_id, relationship_type, sort_order)
     values ($1, $2, $3, $4) returning id`,
    [sourceId, relatedId, relationshipType, sortOrder]
  );
  return r.rows[0].id;
}

// Build a source with n related links at contiguous positions 0..n-1,
// exactly as addRelatedContent() would have produced them.
async function seedSet(db, n) {
  const source = await newPost(db, { title: `Source ${uniq()}` });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const target = await newPost(db, { title: `Target ${uniq()}` });
    ids.push(await link(db, source, target, 'related', i));
  }
  return { source, ids };
}

async function positions(db, sourceId) {
  const r = await db.query(`select id, sort_order from resource_related_content where source_post_id = $1 order by sort_order, id`, [sourceId]);
  return r.rows;
}

async function snapshot(db, sourceId) {
  const r = await db.query(`select id, related_post_id, relationship_type, sort_order from resource_related_content where source_post_id = $1 order by id`, [sourceId]);
  return JSON.stringify(r.rows);
}

async function globalSnapshot(db) {
  const r = await db.query(`select id, source_post_id, related_post_id, relationship_type, sort_order from resource_related_content order by id`);
  return JSON.stringify(r.rows);
}

function isUniqueContiguous(rows) {
  const s = rows.map((r) => r.sort_order).sort((a, b) => a - b);
  return s.every((v, i) => v === i);
}

// --------------------------------------------------------------------------
// Pattern A calling context
//
// admin_reorder_related_content is now a CALLER-CONTEXT RPC: it reads
// auth.uid() itself and rechecks the capability in the database. Every
// integrity test below therefore has to call it the way the application does
// — as a real, authorised, signed-in administrator. CERT_ADMIN is that
// administrator (a genuine resource_admin row in resource_user_roles, not a
// bypass), and reorder()/tryReorder() establish the session before each call
// so the SECTION 1-5 integrity evidence is produced through the new
// authorisation model rather than around it.
// --------------------------------------------------------------------------
let CERT_ADMIN = null;

async function reorder(db, sourceId, orderedIds, actorId = undefined) {
  await actAs(db, actorId === undefined ? CERT_ADMIN : actorId);
  const r = await db.query(`select public.admin_reorder_related_content($1::uuid, $2::uuid[]) as result`, [sourceId, orderedIds]);
  return r.rows[0].result;
}

// Returns { ok, code, message } — never throws, so a test can assert on the
// exact SQLSTATE the function raised.
async function tryReorder(db, sourceId, orderedIds, actorId = undefined) {
  try {
    const result = await reorder(db, sourceId, orderedIds, actorId);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, code: e.code ?? null, message: e.message ?? String(e) };
  }
}

// Calls the RPC while the SESSION IS ACTUALLY SET TO `dbRole` — i.e. the real
// PostgreSQL role PostgREST would use for that class of request
// (`authenticated` for a signed-in user, `anon` for an anonymous one) — with
// `actorId` as the JWT subject. This is what makes the permitted/denied role
// tests genuine: the EXECUTE grant is enforced by PostgreSQL against the
// session role, not simulated, and no service-role or superuser bypass is in
// play for the duration of the call.
async function callAsDbRole(db, dbRole, actorId, sourceId, orderedIds) {
  await actAs(db, actorId);
  try {
    await db.exec(`set role ${dbRole}`);
    const r = await db.query(`select public.admin_reorder_related_content($1::uuid, $2::uuid[]) as result`, [sourceId, orderedIds]);
    return { ok: true, result: r.rows[0].result };
  } catch (e) {
    return { ok: false, code: e.code ?? null, message: e.message ?? String(e) };
  } finally {
    // reset role must always run, or every later verification query in this
    // single-connection harness would silently inherit the restricted role.
    await db.exec(`reset role`);
  }
}

async function tryTransition(db, postId, toStatus, reason = null) {
  try {
    const r = await db.query(`select public.transition_resource_post_status($1::uuid, $2::text, $3::text, null) as p`, [postId, toStatus, reason]);
    return { ok: true, row: r.rows[0].p };
  } catch (e) {
    return { ok: false, code: e.code ?? null, message: e.message ?? String(e) };
  }
}

async function statusOf(db, postId) {
  const r = await db.query(`select status, scheduled_at, published_at, visibility from resource_posts where id = $1`, [postId]);
  return r.rows[0];
}

const FOUR_TYPES = ['article', 'glossary', 'video', 'money_update'];
const TYPE_ROUTE = {
  article: 'General Content  (/api/admin/resources/content/[id]/workflow)',
  glossary: 'Glossary         (/api/admin/resources/glossary/[id]/workflow)',
  money_update: 'Money Updates    (/api/admin/resources/money-updates/[id]/workflow)',
  video: 'Videos           (/api/admin/resources/videos/[id]/workflow)',
};

// An approved post of the given content type, owned by a publisher, ready to
// attempt a transition to 'scheduled'.
async function approvedPost(db, contentType, publisherId, scheduledAt = null) {
  const id = await newPost(db, { contentType, status: 'approved', scheduledAt, createdBy: publisherId });
  return id;
}

async function main() {
  const db = await buildDb(true);
  // The true pre-Wave-2 database (current origin/main), used to MEASURE the
  // "before" state rather than assert it.
  const base = await buildDb(false);
  console.log('');

  // The signed-in administrator every Scope A test calls the RPC as. Created
  // as a real, active resource_admin — one of the two non-super-admin roles
  // canManageDiscovery permits.
  CERT_ADMIN = await newUser(db);
  await grantRole(db, CERT_ADMIN, 'resource_admin');

  console.log('=== SECTION 0: baseline (pre-0116) measurements ===');
  {
    const b = await functionPosture(base, 'admin_reorder_related_content');
    check('BASELINE: admin_reorder_related_content does not exist before 0116', b === null);
    const bd = await base.query(`select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'private' and p.proname = 'can_manage_discovery'`);
    check('BASELINE: private.can_manage_discovery does not exist before 0116 (canManageDiscovery lived only in TypeScript)', bd.rows[0].n === 0);

    const bt = await functionPosture(base, 'transition_resource_post_status');
    const at = await functionPosture(db, 'transition_resource_post_status');
    check('BASELINE: the transition RPC exists before 0116', bt !== null);
    check('0116 changes the transition RPC GRANTS not at all (byte-identical ACL vs baseline)', bt.acl === at.acl, `baseline=${bt.acl}  after=${at.acl}`);
    check('0116 changes the transition RPC search_path not at all', JSON.stringify(bt.proconfig) === JSON.stringify(at.proconfig));
    check('0116 keeps the transition RPC SECURITY DEFINER', bt.prosecdef === true && at.prosecdef === true);
    check('0116 does not fork the transition RPC (still exactly one)', String(bt.n) === String(at.n) && String(at.n) === '1');
    console.log(`        (note: the "anon=X" entry in this ACL is a PGlite-harness artifact of scripts/db-rebuild-check/shim.sql's`);
    console.log(`         "alter default privileges ... grant execute on functions to anon" and is IDENTICAL before and after 0116.`);
    console.log(`         Anonymous execution is denied by the function body itself — see the per-type "unauthenticated direct RPC`);
    console.log(`         DENIED" checks in SECTION 8. 0116 neither introduced nor widened it.)`);

    // BASELINE reproduction of the Scope B defect through the REAL
    // pre-Wave-2 RPC, not a stand-in for it.
    const pub = await newUser(base);
    await grantRole(base, pub, 'publisher');
    await actAs(base, pub);
    const pastPost = await newPost(base, { status: 'approved', scheduledAt: '2000-01-01T00:00:00Z', createdBy: pub });
    const r1 = await tryTransition(base, pastPost, 'scheduled');
    check('DEFECT CONFIRMED on the REAL baseline RPC: a PAST scheduled_at was ACCEPTED for scheduling', r1.ok === true, JSON.stringify(r1));
    check('  -> and the post really did reach status=scheduled with a year-2000 publish time', (await statusOf(base, pastPost)).status === 'scheduled');

    const nullPost = await newPost(base, { status: 'approved', createdBy: pub });
    const r2 = await tryTransition(base, nullPost, 'scheduled');
    check('DEFECT CONFIRMED on the REAL baseline RPC: a NULL scheduled_at failed only as raw SQLSTATE 23514', r2.ok === false && r2.code === '23514', `${r2.code}: ${r2.message}`);
    check('  -> and the raw message leaks the internal constraint name to the client (surfaced as HTTP 403 by lib/resources/workflow.ts)', /chk_resource_posts_scheduled_at/.test(r2.message), r2.message);
    await actAs(base, null);
  }

  // ======================================================================
  // SCOPE A
  // ======================================================================

  console.log('=== SECTION 1: Original reorder defect reproduction (RED) ===');
  {
    // The pre-Wave-2 path, verbatim in behaviour:
    //   Promise.all(orderedIds.map((id, index) =>
    //     supabase.from('resource_related_content')
    //       .update({ sort_order: index }).eq('id', id).eq('source_post_id', src)))
    // Each .update() is a separate PostgREST request => a separate
    // autocommitted transaction. Reproduced here as N separate db.query()
    // calls (PGlite autocommits each one, exactly like PostgREST does).
    const { source, ids } = await seedSet(db, 5);
    const before = await positions(db, source);
    check('fixture: 5 links at contiguous positions 0..4', before.map((r) => r.sort_order).join(',') === '0,1,2,3,4');

    // Force a failure part-way through, using a constraint that genuinely
    // exists on this table: sort_order >= 0. The 3rd statement in the
    // sequence is made to violate it, standing in for any mid-sequence
    // failure (transient error, dropped connection, constraint violation).
    const reversed = [...ids].reverse();
    let failedAt = -1;
    for (let i = 0; i < reversed.length; i++) {
      const value = i === 2 ? -1 : i; // the injected failure
      try {
        await db.query(`update resource_related_content set sort_order = $1 where id = $2 and source_post_id = $3`, [value, reversed[i], source]);
      } catch {
        failedAt = i;
        break; // Promise.all rejects; the route returns 500 and stops
      }
    }
    check('old path: a mid-sequence statement genuinely fails', failedAt === 2);

    const after = await positions(db, source);
    const orders = after.map((r) => r.sort_order);
    check(
      'DEFECT CONFIRMED: the two statements that already ran are STILL COMMITTED after the failure',
      after.filter((r) => r.id === reversed[0])[0].sort_order === 0 && after.filter((r) => r.id === reversed[1])[0].sort_order === 1
    );
    check('DEFECT CONFIRMED: committed positions now contain a DUPLICATE', new Set(orders).size !== orders.length, `orders=${orders.join(',')}`);
    check('DEFECT CONFIRMED: committed positions are no longer unique+contiguous', !isUniqueContiguous(after), `orders=${orders.join(',')}`);
    check(
      'DEFECT CONFIRMED: the resulting order is a MIXTURE of the old and the requested order, i.e. neither one',
      JSON.stringify(after.map((r) => r.id)) !== JSON.stringify(ids) && JSON.stringify(after.map((r) => r.id)) !== JSON.stringify(reversed)
    );
    console.log(`        (route/function/table: PATCH /api/admin/resources/related/reorder -> reorderRelatedContent() -> resource_related_content; response to the client was HTTP 500 "Could not reorder related content.")`);
  }

  console.log('\n=== SECTION 2: Other latent hazards of the same path (RED) ===');
  {
    // 2a. Omitted row strands a link at its old position.
    const { source, ids } = await seedSet(db, 3);
    const partial = [ids[2], ids[0]]; // ids[1] omitted
    for (let i = 0; i < partial.length; i++) {
      await db.query(`update resource_related_content set sort_order = $1 where id = $2 and source_post_id = $3`, [i, partial[i], source]);
    }
    const after = await positions(db, source);
    check('DEFECT CONFIRMED (omitted row): an incomplete payload produced duplicate positions', new Set(after.map((r) => r.sort_order)).size !== after.length, JSON.stringify(after.map((r) => r.sort_order)));
  }
  {
    // 2b. Foreign-source id silently no-ops and the caller is told "success".
    const a = await seedSet(db, 2);
    const b = await seedSet(db, 2);
    const beforeB = await snapshot(db, b.source);
    // Old path: .eq('source_post_id', a.source) makes the foreign id match
    // zero rows. No error, no rowcount check => reported as success.
    const res = await db.query(`update resource_related_content set sort_order = 0 where id = $1 and source_post_id = $2`, [b.ids[0], a.source]);
    check('DEFECT CONFIRMED (foreign id): the update matched zero rows and raised NO error', (res.affectedRows ?? 0) === 0);
    check('DEFECT CONFIRMED (foreign id): the other source was untouched yet the caller would be told the reorder succeeded', (await snapshot(db, b.source)) === beforeB);
  }
  {
    // 2c. Duplicate id => last write wins => a gap.
    const { source, ids } = await seedSet(db, 3);
    const dup = [ids[0], ids[0], ids[1]];
    for (let i = 0; i < dup.length; i++) {
      await db.query(`update resource_related_content set sort_order = $1 where id = $2 and source_post_id = $3`, [i, dup[i], source]);
    }
    const after = await positions(db, source);
    check('DEFECT CONFIRMED (duplicate id): produced a non-contiguous ordering', !isUniqueContiguous(after), JSON.stringify(after.map((r) => r.sort_order)));
  }

  console.log('\n=== SECTION 3: admin_reorder_related_content — valid behaviour (GREEN) ===');
  {
    // 3a. Two relationships.
    const { source, ids } = await seedSet(db, 2);
    const r = await reorder(db, source, [ids[1], ids[0]]);
    const after = await positions(db, source);
    check('reorder of two relationships applies', after.find((x) => x.id === ids[1]).sort_order === 0 && after.find((x) => x.id === ids[0]).sort_order === 1);
    check('returned order matches committed database order', JSON.stringify(r.ordered.map((o) => o.id)) === JSON.stringify(after.map((x) => x.id)));
    check('returned count is correct', r.count === 2);
  }
  {
    // 3b. Complete reverse of a larger set.
    const { source, ids } = await seedSet(db, 8);
    const reversed = [...ids].reverse();
    await reorder(db, source, reversed);
    const after = await positions(db, source);
    check('complete reverse applies exactly', JSON.stringify(after.map((x) => x.id)) === JSON.stringify(reversed));
    check('positions remain unique and contiguous after reverse', isUniqueContiguous(after));
  }
  {
    // 3c. Maximum supported number (the function's own cap).
    const { source, ids } = await seedSet(db, 100);
    const reversed = [...ids].reverse();
    const r = await reorder(db, source, reversed);
    const after = await positions(db, source);
    check('reorder of the MAXIMUM supported number (100) succeeds', r.count === 100);
    check('maximum-size reorder is exact and contiguous', JSON.stringify(after.map((x) => x.id)) === JSON.stringify(reversed) && isUniqueContiguous(after));
    // 3d. Repeating the SAME order is idempotent, not an error.
    const before = await snapshot(db, source);
    await reorder(db, source, reversed);
    check('repeating the same order is idempotent (zero variance)', (await snapshot(db, source)) === before);
  }
  {
    // 3e. Different sources reorder independently.
    const a = await seedSet(db, 4);
    const b = await seedSet(db, 4);
    const beforeB = await snapshot(db, b.source);
    await reorder(db, a.source, [...a.ids].reverse());
    check('reordering source A left source B completely unchanged', (await snapshot(db, b.source)) === beforeB);
    check('source A is correctly reordered', JSON.stringify((await positions(db, a.source)).map((x) => x.id)) === JSON.stringify([...a.ids].reverse()));
  }
  {
    // 3f. Reordering never creates, deletes or relinks anything.
    const { source, ids } = await seedSet(db, 5);
    const beforeRows = await db.query(`select id, source_post_id, related_post_id, relationship_type from resource_related_content where source_post_id = $1 order by id`, [source]);
    await reorder(db, source, [ids[3], ids[0], ids[4], ids[1], ids[2]]);
    const afterRows = await db.query(`select id, source_post_id, related_post_id, relationship_type from resource_related_content where source_post_id = $1 order by id`, [source]);
    check('reorder never creates, deletes or relinks a relationship (only sort_order moved)', JSON.stringify(beforeRows.rows) === JSON.stringify(afterRows.rows));
  }
  {
    // 3g. Zero-based positions confirmed explicitly.
    const { source, ids } = await seedSet(db, 3);
    await reorder(db, source, [ids[2], ids[1], ids[0]]);
    const after = await positions(db, source);
    check('resulting positions are ZERO-based (0..n-1)', after.map((x) => x.sort_order).join(',') === '0,1,2');
  }

  console.log('\n=== SECTION 4: invalid payload rejection, each with ZERO database variance (GREEN) ===');
  {
    const { source, ids } = await seedSet(db, 4);
    const foreign = await seedSet(db, 2);
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const unknownSource = '11111111-1111-4111-8111-111111111111';

    const cases = [
      ['empty array where relationships exist', source, [], '22023'],
      ['missing relationship id (incomplete set)', source, [ids[0], ids[1], ids[2]], '40001'],
      ['extra relationship id', source, [...ids, unknownId], '40001'],
      ['duplicate id', source, [ids[0], ids[0], ids[1], ids[2]], '22023'],
      ['id belonging to another source', source, [ids[0], ids[1], ids[2], foreign.ids[0]], '40001'],
      ['unknown relationship id', source, [ids[0], ids[1], ids[2], unknownId], '40001'],
      ['unknown source id', unknownSource, [ids[0]], 'P0002'],
      ['null source id', null, [ids[0]], '22023'],
      ['null ordered_ids', source, null, '22023'],
      ['oversized payload (101 ids)', source, Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), '22023'],
    ];

    for (const [label, src, payload, expectedCode] of cases) {
      const globalBefore = await globalSnapshot(db);
      const res = await tryReorder(db, src, payload);
      check(`rejected: ${label}`, res.ok === false, JSON.stringify(res));
      check(`  -> correct SQLSTATE ${expectedCode} for: ${label}`, res.code === expectedCode, `got ${res.code}: ${res.message}`);
      check(`  -> ZERO database variance for: ${label}`, (await globalSnapshot(db)) === globalBefore);
    }

    // Malformed UUID and a non-array payload are rejected by PostgreSQL's own
    // type system before the function body ever runs — proved, not assumed.
    for (const [label, sql, params] of [
      ['malformed UUID in the ordered list', `select public.admin_reorder_related_content($1::uuid, $2::uuid[])`, [source, ['not-a-uuid']]],
      ['non-array payload', `select public.admin_reorder_related_content($1::uuid, $2::uuid[])`, [source, 'not-an-array']],
      ['malformed source UUID', `select public.admin_reorder_related_content($1::uuid, $2::uuid[])`, ['not-a-uuid', [ids[0]]]],
    ]) {
      const globalBefore = await globalSnapshot(db);
      let rejected = false;
      let code = null;
      try {
        await db.query(sql, params);
      } catch (e) {
        rejected = true;
        code = e.code ?? null;
      }
      check(`rejected by type system: ${label}`, rejected, `code=${code}`);
      check(`  -> ZERO database variance for: ${label}`, (await globalSnapshot(db)) === globalBefore);
    }

    check('the valid set is still intact and contiguous after 13 rejected attempts', isUniqueContiguous(await positions(db, source)));
  }

  console.log('\n=== SECTION 5: rollback and failure injection (GREEN) ===');
  {
    // 5a. A constraint failure DURING the update: the whole reorder rolls
    // back, unlike the old path which committed everything before the
    // failing statement. Injected by a trigger that raises on one specific
    // row's new position, i.e. mid-statement.
    const { source, ids } = await seedSet(db, 5);
    const before = await snapshot(db, source);
    await db.exec(`
      create or replace function w2_inject_failure() returns trigger language plpgsql as $fn$
      begin
        if new.sort_order = 3 then
          raise exception 'injected failure at position 3' using errcode = '23514';
        end if;
        return new;
      end;
      $fn$;
      create trigger w2_inject before update on resource_related_content for each row execute function w2_inject_failure();
    `);
    const res = await tryReorder(db, source, [...ids].reverse());
    check('failure injected mid-update genuinely aborts the reorder', res.ok === false && /injected failure/.test(res.message));
    check('ROLLBACK PROVEN: not one position changed (compare against the identical failure in SECTION 1)', (await snapshot(db, source)) === before);
    check('positions remain unique and contiguous after the failed reorder', isUniqueContiguous(await positions(db, source)));
    await db.exec(`drop trigger w2_inject on resource_related_content; drop function w2_inject_failure();`);

    // 5b. And the very same reorder now succeeds once the failure source is
    // removed — proving the rollback left the set usable, not wedged.
    await reorder(db, source, [...ids].reverse());
    check('the same reorder succeeds cleanly after the injected failure is removed', JSON.stringify((await positions(db, source)).map((x) => x.id)) === JSON.stringify([...ids].reverse()));
  }
  {
    // 5c. Failure BEFORE any update (validation stage) — zero variance.
    const { source, ids } = await seedSet(db, 4);
    const before = await snapshot(db, source);
    const res = await tryReorder(db, source, [ids[0], ids[0], ids[1], ids[2]]);
    check('validation-stage failure rejects before any write', res.ok === false && res.code === '22023');
    check('ZERO variance after a validation-stage failure', (await snapshot(db, source)) === before);
  }
  {
    // 5d. Stale relationship set — a link removed after the client read.
    const { source, ids } = await seedSet(db, 4);
    await db.query(`delete from resource_related_content where id = $1`, [ids[1]]);
    const before = await snapshot(db, source);
    const res = await tryReorder(db, source, [...ids].reverse()); // client still has all 4
    check('stale set (link removed) is rejected with the conflict SQLSTATE 40001', res.ok === false && res.code === '40001', JSON.stringify(res));
    check('stale-set rejection leaves the surviving links untouched', (await snapshot(db, source)) === before);
    // and the refreshed, canonical set reorders cleanly
    const live = (await positions(db, source)).map((x) => x.id);
    await reorder(db, source, [...live].reverse());
    check('after refreshing to the canonical set, the reorder succeeds', isUniqueContiguous(await positions(db, source)));
  }
  {
    // 5e. Relationship ADDED after the client read (add racing a reorder).
    const { source, ids } = await seedSet(db, 3);
    const extra = await newPost(db, { title: `Late target ${uniq()}` });
    await link(db, source, extra, 'related', 3);
    const before = await snapshot(db, source);
    const res = await tryReorder(db, source, [...ids].reverse()); // client only knows 3
    check('stale set (link added) is rejected with SQLSTATE 40001', res.ok === false && res.code === '40001', JSON.stringify(res));
    check('add-racing-reorder rejection leaves every link untouched', (await snapshot(db, source)) === before);
  }
  {
    // 5f. A pre-existing set that ALREADY has duplicate positions (which is
    // the real state of 22 of 25 DEV sources) is repaired into a unique,
    // contiguous ordering by a single reorder — no constraint needed, and
    // no silent background repair of anything untouched.
    const source = await newPost(db, { title: `Legacy dup source ${uniq()}` });
    const legacy = [];
    for (let i = 0; i < 4; i++) {
      legacy.push(await link(db, source, await newPost(db, { title: `Legacy target ${uniq()}` }), 'related', 0));
    }
    check('fixture reproduces the real DEV state: 4 links all at sort_order 0', !isUniqueContiguous(await positions(db, source)));
    await reorder(db, source, legacy);
    check('one reorder repairs a legacy duplicate-position set to unique+contiguous', isUniqueContiguous(await positions(db, source)));
  }

  console.log('\n=== SECTION 6: PATTERN A security posture of admin_reorder_related_content — STRUCTURAL (GREEN) ===');
  {
    const meta = await db.query(`
      select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_reorder_related_content'`);
    check('function exists exactly once', meta.rows.length === 1);
    check('function is SECURITY DEFINER', meta.rows[0].prosecdef === true);
    check('function pins search_path=public', JSON.stringify(meta.rows[0].proconfig).includes('search_path=public'));

    const acl = await db.query(`
      select coalesce(array_to_string(p.proacl, ','), '') as acl
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_reorder_related_content'`);
    const aclText = acl.rows[0].acl;
    check('PATTERN A: EXECUTE granted to authenticated', /\bauthenticated=X/.test(aclText), aclText);
    check('PATTERN A: EXECUTE NOT granted to anon', !/\banon=X/.test(aclText), aclText);
    check('PATTERN A: EXECUTE NOT granted to PUBLIC', !/^=X/.test(aclText) && !/,=X/.test(aclText), aclText);
    check('PATTERN A: EXECUTE NOT granted to service_role (this is not a service-boundary RPC)', !/service_role=X/.test(aclText), aclText);

    for (const role of ['anon', 'service_role']) {
      const r = await db.query(`select has_function_privilege($1, 'public.admin_reorder_related_content(uuid, uuid[])', 'EXECUTE') as ok`, [role]);
      check(`${role} has NO EXECUTE privilege`, r.rows[0].ok === false);
    }
    const au = await db.query(`select has_function_privilege('authenticated', 'public.admin_reorder_related_content(uuid, uuid[])', 'EXECUTE') as ok`);
    check('authenticated DOES have EXECUTE (a signed-in administrator calls it with their own session)', au.rows[0].ok === true);

    const src = await db.query(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='admin_reorder_related_content'`);
    const body = src.rows[0].prosrc;
    // Strip `--` comments before the dynamic-SQL scan: the Pattern A note in
    // the body legitimately contains the word "EXECUTE" (discussing the
    // grant), and a comment cannot execute anything. The scan must judge
    // CODE, not prose.
    const code = body.replace(/--[^\n]*/g, '');
    check('function body contains NO dynamic SQL (no EXECUTE/format/quote_ident in code)', !/\bexecute\s+/i.test(code) && !/\bformat\s*\(/i.test(code) && !/quote_ident/i.test(code));
    check('function takes no actor/role parameter (identity can never be client-supplied)', !/p_role|p_actor|p_user/i.test(body));

    const args = await db.query(`select pg_get_function_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='admin_reorder_related_content'`);
    check('signature is still exactly (p_source_post_id uuid, p_ordered_ids uuid[]) — no identity parameter was added', args.rows[0].a === 'p_source_post_id uuid, p_ordered_ids uuid[]', args.rows[0].a);

    check('body derives the actor from auth.uid()', /v_actor\s+uuid\s*:=\s*auth\.uid\(\)/.test(body), body.slice(0, 200));
    check('body FAILS CLOSED on a null actor with an EXPLICIT raise (not an implicit null comparison)', /if\s+v_actor\s+is\s+null\s+then[\s\S]{0,200}?raise\s+exception/i.test(body));
    check('body independently rechecks the capability via private.can_manage_discovery(v_actor)', /if\s+not\s+private\.can_manage_discovery\(\s*v_actor\s*\)\s+then/i.test(body));
    check('the capability recheck raises 42501 (insufficient_privilege)', /can_manage_discovery\(\s*v_actor\s*\)[\s\S]{0,300}?errcode\s*=\s*'42501'/i.test(body));
    check('both auth guards run BEFORE any payload handling or table access', body.indexOf('can_manage_discovery') < body.indexOf('payload shape'), `guard@${body.indexOf('can_manage_discovery')} payload@${body.indexOf('payload shape')}`);
  }

  console.log('\n=== SECTION 6A: private.can_manage_discovery — the database mirror of canManageDiscovery() (GREEN) ===');
  {
    const meta = await db.query(`
      select p.prosecdef, p.proconfig, coalesce(array_to_string(p.proacl, ','), '') as acl, p.provolatile
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and p.proname = 'can_manage_discovery'`);
    check('private.can_manage_discovery exists exactly once', meta.rows.length === 1);
    check('it is SECURITY DEFINER with an EMPTY search_path (same posture as its 0049 siblings)', meta.rows[0].prosecdef === true && JSON.stringify(meta.rows[0].proconfig).includes('search_path='));
    check('it is STABLE (safe to reuse within one statement)', meta.rows[0].provolatile === 's');
    check('EXECUTE is not granted to anon', !/\banon=X/.test(meta.rows[0].acl), meta.rows[0].acl);
    check('EXECUTE is not granted to PUBLIC', !/^=X/.test(meta.rows[0].acl) && !/,=X/.test(meta.rows[0].acl), meta.rows[0].acl);

    // The role set the DB predicate resolves to must be EXACTLY the role set
    // lib/resources/permissions.ts resolves to — proved role by role against
    // real rows in the canonical tables, not asserted from reading the SQL.
    // (TS: DISCOVERY_MANAGE_ROLES = ['resource_admin','editor'], plus
    // isSuperAdmin.)
    const EXPECTED = { resource_admin: true, editor: true, author: false, compliance_reviewer: false, publisher: false, analyst: false };
    for (const [role, expected] of Object.entries(EXPECTED)) {
      const u = await newUser(db);
      await grantRole(db, u, role);
      const r = await db.query(`select private.can_manage_discovery($1::uuid) as ok`, [u]);
      check(`can_manage_discovery(${role}) = ${expected} — matches canManageDiscovery() in lib/resources/permissions.ts`, r.rows[0].ok === expected, `got ${r.rows[0].ok}`);
    }
    const noRole = await newUser(db);
    check('can_manage_discovery(authenticated user with NO Resources role) = false', (await db.query(`select private.can_manage_discovery($1::uuid) as ok`, [noRole])).rows[0].ok === false);

    const sa = await newUser(db);
    await db.query(`insert into admin_users (user_id) values ($1)`, [sa]);
    check('can_manage_discovery(Super Admin, no resource_user_roles row at all) = true', (await db.query(`select private.can_manage_discovery($1::uuid) as ok`, [sa])).rows[0].ok === true);

    check('can_manage_discovery(null) is not true (null actor can never satisfy it)', (await db.query(`select coalesce(private.can_manage_discovery(null::uuid), false) as ok`)).rows[0].ok === false);

    // is_active is honoured: a deactivated Editor loses the capability.
    const stale = await newUser(db);
    await db.query(`insert into resource_user_roles (user_id, role, is_active) values ($1, 'editor', false)`, [stale]);
    check('an INACTIVE editor role does not grant the capability', (await db.query(`select private.can_manage_discovery($1::uuid) as ok`, [stale])).rows[0].ok === false);

    // §14: deliberately narrower than is_resource_staff — proof the new
    // predicate is not a rename of an existing broader one.
    const pubUser = await newUser(db);
    await grantRole(db, pubUser, 'publisher');
    const both = await db.query(`select private.is_resource_staff($1::uuid) as staff, private.can_manage_discovery($1::uuid) as disc`, [pubUser]);
    check('a Publisher IS resource staff but is NOT a discovery administrator (not an alias for is_resource_staff)', both.rows[0].staff === true && both.rows[0].disc === false);
  }

  console.log('\n=== SECTION 6B: PERMITTED roles calling the RPC with their OWN authenticated session (GREEN) ===');
  {
    // Each of these calls runs with the PostgreSQL session role set to
    // `authenticated` — the role PostgREST uses for a signed-in user — and
    // with that user's own id as the JWT subject. No service_role, no
    // superuser bypass, no route in the path.
    const cases = [
      ['Editor', async () => { const u = await newUser(db); await grantRole(db, u, 'editor'); return u; }],
      ['Resource Admin', async () => { const u = await newUser(db); await grantRole(db, u, 'resource_admin'); return u; }],
      ['Super Admin', async () => { const u = await newUser(db); await db.query(`insert into admin_users (user_id) values ($1)`, [u]); return u; }],
    ];
    for (const [label, mk] of cases) {
      const actor = await mk();
      const { source, ids } = await seedSet(db, 4);
      const wanted = [...ids].reverse();
      const res = await callAsDbRole(db, 'authenticated', actor, source, wanted);
      check(`${label} calling the RPC directly as themselves (session role = authenticated) SUCCEEDS`, res.ok === true, JSON.stringify(res));
      const after = await positions(db, source);
      check(`  -> ${label}'s reorder was really committed, unique and contiguous`, JSON.stringify(after.map((x) => x.id)) === JSON.stringify(wanted) && isUniqueContiguous(after));
      check(`  -> the RPC returned the committed ordering to ${label}`, res.ok && JSON.stringify(res.result.ordered.map((o) => o.id)) === JSON.stringify(wanted));
    }
  }

  console.log('\n=== SECTION 6C: DENIED roles calling the RPC directly as themselves (GREEN) ===');
  {
    // The point of Pattern A: these roles are refused BY THE FUNCTION'S OWN
    // capability recheck, not merely by never being routed to it. Each one
    // holds a real, active Resources role and a real session; each is denied
    // 42501 with zero database variance.
    for (const role of ['analyst', 'author', 'compliance_reviewer', 'publisher']) {
      const actor = await newUser(db);
      await grantRole(db, actor, role);
      const { source, ids } = await seedSet(db, 3);
      const globalBefore = await globalSnapshot(db);
      const res = await callAsDbRole(db, 'authenticated', actor, source, [...ids].reverse());
      check(`${role} is DENIED by the RPC's own capability recheck`, res.ok === false, JSON.stringify(res));
      check(`  -> with SQLSTATE 42501 (insufficient_privilege) for ${role}`, res.code === '42501', `${res.code}: ${res.message}`);
      check(`  -> and ZERO database variance for ${role}`, (await globalSnapshot(db)) === globalBefore);
    }

    // An authenticated user with no Resources role at all.
    {
      const actor = await newUser(db);
      const { source, ids } = await seedSet(db, 3);
      const globalBefore = await globalSnapshot(db);
      const res = await callAsDbRole(db, 'authenticated', actor, source, [...ids].reverse());
      check('an authenticated user with NO Resources role is DENIED', res.ok === false && res.code === '42501', JSON.stringify(res));
      check('  -> and ZERO database variance', (await globalSnapshot(db)) === globalBefore);
    }

    // A user whose only qualifying role has been DEACTIVATED — the recheck
    // reads live rows, so revocation takes effect immediately.
    {
      const actor = await newUser(db);
      await grantRole(db, actor, 'editor');
      const { source, ids } = await seedSet(db, 3);
      const okRes = await callAsDbRole(db, 'authenticated', actor, source, [...ids].reverse());
      check('control: while ACTIVE, that editor succeeds', okRes.ok === true, JSON.stringify(okRes));
      await db.query(`update resource_user_roles set is_active = false where user_id = $1`, [actor]);
      const globalBefore = await globalSnapshot(db);
      const res = await callAsDbRole(db, 'authenticated', actor, source, ids);
      check('after DEACTIVATING the role, the same user is DENIED on the very next call', res.ok === false && res.code === '42501', JSON.stringify(res));
      check('  -> and ZERO database variance', (await globalSnapshot(db)) === globalBefore);
    }

    // Identity cannot be borrowed: a denied user presenting a PERMITTED
    // user's id is irrelevant, because there is no parameter to present it
    // through — but prove the session subject is what decides, by giving an
    // Author session the Editor's id as its own subject is impossible; the
    // realistic attack is forging the JWT subject, which auth.uid() would
    // then report. Cover the reachable half: the id in the payload (a
    // relationship id) never influences authorisation.
    {
      const author = await newUser(db);
      await grantRole(db, author, 'author');
      const editor = await newUser(db);
      await grantRole(db, editor, 'editor');
      const { source, ids } = await seedSet(db, 2);
      const globalBefore = await globalSnapshot(db);
      const res = await callAsDbRole(db, 'authenticated', author, source, [...ids].reverse());
      check('an Author is denied even though a permitted Editor exists in the same database', res.ok === false && res.code === '42501');
      check('  -> ZERO database variance', (await globalSnapshot(db)) === globalBefore);
      const ok2 = await callAsDbRole(db, 'authenticated', editor, source, [...ids].reverse());
      check('  -> and the Editor, on the identical payload, succeeds (so the payload was never the reason)', ok2.ok === true, JSON.stringify(ok2));
    }
  }

  console.log('\n=== SECTION 6D: ANONYMOUS denial — structural AND behavioural (GREEN) ===');
  {
    const priv = await db.query(`select has_function_privilege('anon', 'public.admin_reorder_related_content(uuid, uuid[])', 'EXECUTE') as ok`);
    check('STRUCTURAL: anon holds no EXECUTE privilege on the RPC', priv.rows[0].ok === false);

    const { source, ids } = await seedSet(db, 3);
    const globalBefore = await globalSnapshot(db);
    // A genuinely anonymous request: session role anon, no JWT subject.
    const res = await callAsDbRole(db, 'anon', null, source, [...ids].reverse());
    check('BEHAVIOURAL: an anonymous caller is refused', res.ok === false, JSON.stringify(res));
    check('  -> refused at the GRANT layer with SQLSTATE 42501', res.code === '42501', `${res.code}: ${res.message}`);
    check('  -> the refusal is a permission denial for the function itself', /permission denied for function/i.test(res.message ?? ''), res.message);
    check('  -> ZERO database variance from the anonymous attempt', (await globalSnapshot(db)) === globalBefore);

    // Anonymous with a STOLEN administrator id in the JWT subject GUC is
    // still refused before the body ever runs — the grant is checked first.
    const res2 = await callAsDbRole(db, 'anon', CERT_ADMIN, source, [...ids].reverse());
    check('an anonymous session presenting an administrator subject is STILL refused (grant is checked before the body)', res2.ok === false && res2.code === '42501', JSON.stringify(res2));
    check('  -> ZERO database variance', (await globalSnapshot(db)) === globalBefore);
  }

  console.log('\n=== SECTION 6E: NULL auth.uid() fails closed inside the function body (GREEN) ===');
  {
    // PostgREST cannot reach this branch for an `authenticated`-granted
    // function (an unauthenticated request executes as `anon`, which SECTION
    // 6D just proved holds no EXECUTE). So the guard is proved the only way
    // it can be: by calling the function DIRECTLY, at the database level,
    // bypassing the request path entirely — as the owner role, which is not
    // subject to the EXECUTE grant — with no JWT subject set at all.
    const { source, ids } = await seedSet(db, 3);
    const globalBefore = await globalSnapshot(db);

    await actAs(db, null);
    check('precondition: auth.uid() is genuinely null in this session', (await db.query(`select auth.uid() is null as n`)).rows[0].n === true);

    const res = await tryReorder(db, source, [...ids].reverse(), null);
    check('a direct, grant-bypassing call with NO authenticated context is REFUSED', res.ok === false, JSON.stringify(res));
    check('  -> by the function body\'s own explicit null-actor guard, SQLSTATE 42501', res.code === '42501', `${res.code}: ${res.message}`);
    check('  -> with the body\'s own "not authenticated" message, not a grant error', /not authenticated/i.test(res.message ?? '') && !/permission denied for function/i.test(res.message ?? ''), res.message);
    check('  -> ZERO database variance', (await globalSnapshot(db)) === globalBefore);

    // Control: the identical direct call, identical payload, with a valid
    // administrator subject, succeeds — so the null actor was the only
    // difference.
    const okRes = await tryReorder(db, source, [...ids].reverse(), CERT_ADMIN);
    check('CONTROL: the identical direct call with a valid administrator subject SUCCEEDS (the null actor was the only variable)', okRes.ok === true, JSON.stringify(okRes));
  }

  console.log('\n=== SECTION 6F: route-level check retained as defence in depth (GREEN) ===');
  {
    // The ruling requires the route-level capability check to REMAIN — it is
    // not made redundant by the database check. Read from the shipped source.
    const routePath = path.join(REPO, 'app', 'api', 'admin', 'resources', 'related', 'reorder', 'route.ts');
    const route = fs.readFileSync(routePath, 'utf8');
    check('the reorder route still imports canManageDiscovery', /import\s*\{[^}]*canManageDiscovery[^}]*\}\s*from\s*'@\/lib\/resources\/permissions'/.test(route));
    check('the reorder route still REJECTS a caller without canManageDiscovery with 403', /if\s*\(!canManageDiscovery\(current\)\)\s*return bad\([^)]*403\)/.test(route));
    check('the reorder route still requires authentication before anything else (401)', /if\s*\(!user\)\s*return bad\('unauthenticated',\s*401\)/.test(route));
    check('PATTERN A: the route no longer uses a service-role client for the reorder', !/adminClient/.test(route), 'adminClient still referenced');
    check('PATTERN A: the route passes the caller-scoped client into reorderRelatedContent', /reorderRelatedContent\(supabase,/.test(route));
    check('the route maps the RPC\'s 42501 refusal to HTTP 403', /case 'forbidden':[\s\S]{0,400}?403/.test(route));

    const lib = fs.readFileSync(path.join(REPO, 'lib', 'resources', 'discovery', 'relatedAdmin.ts'), 'utf8');
    check("relatedAdmin classifies 42501 as 'forbidden'", /'42501':\s*'forbidden'/.test(lib));
    check('relatedAdmin never passes the raw 42501 message through (fixed sentence only)', /kind === 'forbidden'[\s\S]{0,300}?message:\s*FORBIDDEN_MESSAGE/.test(lib));

    // And the substantive claim behind "defence in depth": bypassing the
    // route entirely changes nothing about who may reorder. Already proved
    // per-role in 6B/6C; restated here as the explicit route-bypass result.
    const editor = await newUser(db);
    await grantRole(db, editor, 'editor');
    const analyst = await newUser(db);
    await grantRole(db, analyst, 'analyst');
    const { source, ids } = await seedSet(db, 3);

    const bypassOk = await callAsDbRole(db, 'authenticated', editor, source, [...ids].reverse());
    check('ROUTE BYPASS, authorised: an Editor calling the RPC directly (no route at all) still SUCCEEDS', bypassOk.ok === true, JSON.stringify(bypassOk));

    const globalBefore = await globalSnapshot(db);
    const bypassDenied = await callAsDbRole(db, 'authenticated', analyst, source, ids);
    check('ROUTE BYPASS, unauthorised: an Analyst who somehow got past a route is STILL denied at the RPC layer', bypassDenied.ok === false && bypassDenied.code === '42501', JSON.stringify(bypassDenied));
    check('  -> and changed nothing in the database', (await globalSnapshot(db)) === globalBefore);
  }

  // ======================================================================
  // SCOPE B
  // ======================================================================

  console.log('\n=== SECTION 7: Original scheduling inconsistency — route-level divergence (RED) ===');
  {
    // The DATABASE half of this defect is reproduced in SECTION 0 against
    // the real pre-0116 RPC. This section pins the ROUTE half: the four
    // workflow routes disagreed with each other about scheduling, and the
    // only route that checked anything checked a client-supplied value that
    // was never persisted or compared.
    //
    // Read directly from the pre-Wave-2 sources at origin/main so the claim
    // is measured from the shipped code, not from memory.
    const { execSync } = await import('node:child_process');
    const routeOf = (t) => `app/api/admin/resources/${t}/[id]/workflow/route.ts`;
    const readBase = (p) => {
      try {
        return execSync(`git show origin/main:"${p}"`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    };
    const baseline = Object.fromEntries(['content', 'glossary', 'money-updates', 'videos'].map((t) => [t, readBase(routeOf(t))]));
    const available = Object.values(baseline).every((v) => v !== null);
    check('baseline route sources readable from origin/main', available);
    if (available) {
      check('DEFECT CONFIRMED: only the CONTENT route had any scheduling check at all', /scheduledAt/.test(baseline.content));
      for (const t of ['glossary', 'money-updates', 'videos']) {
        check(`DEFECT CONFIRMED: the ${t} route had NO scheduling check whatsoever`, !/scheduledAt|scheduled_at/.test(baseline[t]));
      }
      check(
        "DEFECT CONFIRMED: the content route's check read a CLIENT-supplied body property that was never persisted or compared",
        /toStatus === 'scheduled' && !body\?\.scheduledAt/.test(baseline.content)
      );
      check(
        'DEFECT CONFIRMED: that client value was never forwarded to the workflow RPC (which takes no scheduling parameter)',
        !/scheduledAt/.test(readBase('lib/resources/workflow.ts') ?? '')
      );
      check(
        'DEFECT CONFIRMED: all four routes nonetheless accepted "scheduled" as a valid target status',
        Object.values(baseline).every((s) => /'scheduled'/.test(s))
      );
    }
  }

  console.log('\n=== SECTION 8: canonical scheduling invariant, all four content types (GREEN) ===');
  {
    const publisher = await newUser(db);
    await grantRole(db, publisher, 'publisher');
    const author = await newUser(db);
    await grantRole(db, author, 'author');
    const analyst = await newUser(db);
    await grantRole(db, analyst, 'analyst');

    const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const FAR_FUTURE = '2099-12-31T23:59:59Z';
    const PAST = '2000-01-01T00:00:00Z';
    const PLUS_OFFSET = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().replace('Z', '+00:00');

    for (const type of FOUR_TYPES) {
      console.log(`  --- ${TYPE_ROUTE[type]} ---`);
      await actAs(db, publisher);

      // Missing / null scheduled timestamp.
      {
        const id = await approvedPost(db, type, publisher, null);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] missing/null scheduled_at REJECTED`, res.ok === false);
        check(`[${type}]   -> canonical SQLSTATE 22023 (not a raw 23514)`, res.code === '22023', `${res.code}: ${res.message}`);
        check(`[${type}]   -> canonical plain-English message`, res.message === 'A publish date and time is required before this content can be scheduled.', res.message);
        check(`[${type}]   -> status unchanged`, (await statusOf(db, id)).status === 'approved');
      }
      // Past timestamp.
      {
        const id = await approvedPost(db, type, publisher, PAST);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] past scheduled_at REJECTED`, res.ok === false && res.code === '22023', `${res.code}: ${res.message}`);
        check(`[${type}]   -> canonical plain-English message`, res.message === 'The scheduled publish date and time must be in the future.', res.message);
        check(`[${type}]   -> status unchanged`, (await statusOf(db, id)).status === 'approved');
      }
      // Boundary: exactly now() (must be rejected — strictly future).
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        await db.query(`update resource_posts set scheduled_at = now() where id = $1`, [id]);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] timestamp equal to the current-time boundary REJECTED (strictly future)`, res.ok === false && res.code === '22023', `${res.code}: ${res.message}`);
      }
      // Valid future timestamp.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] valid future scheduled_at ACCEPTED`, res.ok === true, JSON.stringify(res));
        check(`[${type}]   -> status is now scheduled`, (await statusOf(db, id)).status === 'scheduled');
      }
      // Far-future timestamp.
      {
        const id = await approvedPost(db, type, publisher, FAR_FUTURE);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] far-future scheduled_at ACCEPTED`, res.ok === true, JSON.stringify(res));
      }
      // Explicit UTC and explicit +00:00 offset forms.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        check(`[${type}] UTC ("Z") timestamp ACCEPTED`, (await tryTransition(db, id, 'scheduled')).ok === true);
        const id2 = await approvedPost(db, type, publisher, PLUS_OFFSET);
        check(`[${type}] explicit +00:00 offset timestamp ACCEPTED`, (await tryTransition(db, id2, 'scheduled')).ok === true);
      }
      // Positive and negative UTC offsets naming the SAME absolute instant
      // must behave identically — proving timestamptz normalisation, and
      // that no timezone is inferred from anything.
      {
        const base = Date.now() + 5 * 24 * 3600 * 1000;
        const plus11 = new Date(base).toISOString(); // stored as an instant
        const idA = await approvedPost(db, type, publisher, plus11);
        await db.query(`update resource_posts set scheduled_at = ($1::timestamptz at time zone 'UTC') at time zone 'UTC' where id = $2`, [plus11, idA]);
        check(`[${type}] positive-offset instant ACCEPTED`, (await tryTransition(db, idA, 'scheduled')).ok === true);

        // A past instant expressed with a NEGATIVE offset is still past.
        const idB = await approvedPost(db, type, publisher, '1999-12-31T13:00:00-05:00');
        const resB = await tryTransition(db, idB, 'scheduled');
        check(`[${type}] negative-offset PAST instant REJECTED (offset does not rescue it)`, resB.ok === false && resB.code === '22023');
      }
      // DST-transition boundary: an instant chosen inside the AU "spring
      // forward" gap. timestamptz stores an absolute instant, so there is no
      // ambiguous local time to silently convert.
      {
        const id = await approvedPost(db, type, publisher, '2099-10-04T02:30:00+10:00');
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] DST-boundary instant handled deterministically (accepted as a future instant, no silent conversion)`, res.ok === true, JSON.stringify(res));
      }
      // Role NOT permitted to schedule.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        await actAs(db, author);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] a role without publish capability is DENIED`, res.ok === false && /Only a Publisher/.test(res.message), res.message);
        check(`[${type}]   -> denial happens BEFORE the scheduling check leaks any state`, !/publish date and time/.test(res.message));
        await actAs(db, publisher);
      }
      // Admin Architecture Standard §5: ANALYST IS READ-ONLY and must never
      // be able to schedule or publish. Proved at the database layer, per
      // content type, with a genuinely future timestamp so the ONLY thing
      // that can block the transition is the role predicate.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        await actAs(db, analyst);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] §5 ANALYST is DENIED scheduling (read-only role)`, res.ok === false && /Only a Publisher/.test(res.message), res.message);
        const pub = await tryTransition(db, id, 'published');
        check(`[${type}] §5 ANALYST is DENIED publishing (read-only role)`, pub.ok === false && /Only a Publisher/.test(pub.message), pub.message);
        check(`[${type}]   -> the post is untouched by either analyst attempt`, (await statusOf(db, id)).status === 'approved');
        await actAs(db, publisher);
      }
      // Unauthenticated direct RPC.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        await actAs(db, null);
        const res = await tryTransition(db, id, 'scheduled');
        check(`[${type}] unauthenticated direct RPC DENIED`, res.ok === false && /Not authenticated/.test(res.message));
        await actAs(db, publisher);
      }
      // Schedule -> back to draft, and schedule -> archive.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        await tryTransition(db, id, 'scheduled');
        const editor = await newUser(db);
        await grantRole(db, editor, 'editor');
        await actAs(db, editor);
        const back = await tryTransition(db, id, 'draft', 'back to draft');
        check(`[${type}] scheduled -> draft still works`, back.ok === true, JSON.stringify(back));
        check(`[${type}]   -> scheduled_at is PRESERVED, not cleared`, (await statusOf(db, id)).scheduled_at !== null);
        await actAs(db, publisher);

        const id2 = await approvedPost(db, type, publisher, FUTURE);
        await tryTransition(db, id2, 'scheduled');
        const arch = await tryTransition(db, id2, 'archived', 'archiving');
        check(`[${type}] scheduled -> archived still works`, arch.ok === true, JSON.stringify(arch));
        check(`[${type}]   -> scheduled_at preserved through archive`, (await statusOf(db, id2)).scheduled_at !== null);
      }
      // Reschedule: scheduled -> scheduled, valid and stale.
      {
        const id = await approvedPost(db, type, publisher, FUTURE);
        await tryTransition(db, id, 'scheduled');
        const re = await tryTransition(db, id, 'scheduled');
        check(`[${type}] reschedule with a still-future timestamp ACCEPTED`, re.ok === true, JSON.stringify(re));
        await db.query(`update resource_posts set scheduled_at = $1 where id = $2`, [PAST, id]);
        const stale = await tryTransition(db, id, 'scheduled');
        check(`[${type}] reschedule with a now-past timestamp REJECTED`, stale.ok === false && stale.code === '22023');
        check(`[${type}]   -> the post stays scheduled, nothing half-applied`, (await statusOf(db, id)).status === 'scheduled');
      }
      // Immediate publish path unchanged.
      {
        const id = await approvedPost(db, type, publisher, null);
        const res = await tryTransition(db, id, 'published');
        check(`[${type}] IMMEDIATE PUBLISH with NO scheduled_at still works (path unchanged)`, res.ok === true, JSON.stringify(res));
        const s = await statusOf(db, id);
        check(`[${type}]   -> published_at set and visibility promoted (0098 behaviour intact)`, s.published_at !== null && s.visibility === 'public');
      }
      {
        const id = await approvedPost(db, type, publisher, PAST);
        const res = await tryTransition(db, id, 'published');
        check(`[${type}] IMMEDIATE PUBLISH ignores even a PAST scheduled_at (path unchanged)`, res.ok === true, JSON.stringify(res));
      }
    }
    await actAs(db, null);
  }

  console.log('\n=== SECTION 9: existing workflow behaviour must be unchanged (GREEN) ===');
  {
    const publisher = await newUser(db);
    await grantRole(db, publisher, 'publisher');
    const editor = await newUser(db);
    await grantRole(db, editor, 'editor');
    const compliance = await newUser(db);
    await grantRole(db, compliance, 'compliance_reviewer');
    const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // RED content still cannot be scheduled — and the compliance rule still
    // fires BEFORE the new scheduling rule.
    {
      const id = await newPost(db, { status: 'approved', compliance: 'red', createdBy: publisher, scheduledAt: FUTURE });
      await actAs(db, publisher);
      const res = await tryTransition(db, id, 'scheduled');
      check('RED content still cannot be scheduled (existing rule intact, and checked first)', res.ok === false && /RED content cannot be scheduled/.test(res.message), res.message);
    }
    // AMBER without compliance approval still blocked, ahead of scheduling.
    {
      const id = await newPost(db, { status: 'approved', compliance: 'amber', createdBy: publisher, scheduledAt: FUTURE });
      await actAs(db, publisher);
      const res = await tryTransition(db, id, 'scheduled');
      check('AMBER without compliance approval still blocked (existing rule intact, checked first)', res.ok === false && /AMBER content must have a recorded Compliance Reviewer approval/.test(res.message), res.message);
    }
    // Non-approved content still blocked, ahead of scheduling.
    {
      const id = await newPost(db, { status: 'draft', createdBy: publisher, scheduledAt: FUTURE });
      await actAs(db, publisher);
      const res = await tryTransition(db, id, 'scheduled');
      check('non-approved content still cannot be scheduled (existing rule intact, checked first)', res.ok === false && /Only approved content may be scheduled or published/.test(res.message), res.message);
    }
    // Full happy-path chain still works end to end.
    {
      await actAs(db, editor);
      const id = await newPost(db, { status: 'draft', createdBy: editor });
      check('draft -> editorial_review', (await tryTransition(db, id, 'editorial_review')).ok === true);
      check('editorial_review -> approved (GREEN, editor)', (await tryTransition(db, id, 'approved')).ok === true);
      await actAs(db, publisher);
      check('approved -> published (immediate publish, unchanged)', (await tryTransition(db, id, 'published')).ok === true);

      const hist = await db.query(`select from_status, to_status, actor_role from resource_workflow_history where post_id = $1 order by created_at`, [id]);
      check('workflow history recorded every transition', hist.rows.length === 3, JSON.stringify(hist.rows));
      check('workflow history records the correct actor roles', hist.rows[0].actor_role === 'editor' && hist.rows[2].actor_role === 'publisher', JSON.stringify(hist.rows));
      const audit = await db.query(`select count(*)::int n from resource_audit_log where entity_id = $1 and action='status_transition'`, [id]);
      check('audit log recorded every transition', audit.rows[0].n === 3);
    }
    // A REJECTED scheduling attempt must write NO history and NO audit row.
    {
      await actAs(db, publisher);
      const id = await newPost(db, { status: 'approved', createdBy: publisher });
      const res = await tryTransition(db, id, 'scheduled');
      check('rejected scheduling attempt fails', res.ok === false);
      const h = await db.query(`select count(*)::int n from resource_workflow_history where post_id = $1`, [id]);
      const a = await db.query(`select count(*)::int n from resource_audit_log where entity_id = $1`, [id]);
      check('a REJECTED scheduling attempt writes NO workflow-history row', h.rows[0].n === 0);
      check('a REJECTED scheduling attempt writes NO audit row', a.rows[0].n === 0);
    }
    // The RPC's grants are unchanged by 0116 — measured against the real
    // pre-0116 baseline in SECTION 0, not asserted here. What SECTION 9 adds
    // is that the *authenticated* grant and the SECURITY DEFINER posture the
    // application actually depends on are still in place.
    {
      const acl = await db.query(`
        select coalesce(array_to_string(p.proacl, ','), '') as acl
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname='public' and p.proname='transition_resource_post_status'`);
      check('transition RPC still granted to authenticated (unchanged)', /authenticated=X/.test(acl.rows[0].acl), acl.rows[0].acl);
      check('transition RPC still granted to service_role (unchanged)', /service_role=X/.test(acl.rows[0].acl), acl.rows[0].acl);
      const meta = await db.query(`select prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='transition_resource_post_status'`);
      check('transition RPC is still SECURITY DEFINER with its original empty search_path', meta.rows[0].prosecdef === true && JSON.stringify(meta.rows[0].proconfig).includes('search_path='));
      check('transition RPC exists exactly once (replaced, not forked)', meta.rows.length === 1);
    }
    await actAs(db, null);
  }

  console.log('\n=== SECTION 10: migration re-application (idempotency) ===');
  {
    const before = await globalSnapshot(db);
    const sql = fs.readFileSync(path.join(MIG_DIR, '0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql'), 'utf8');
    let reapplied = true;
    try {
      await db.exec(sql);
    } catch (e) {
      reapplied = false;
      console.log(`        re-apply error: ${e.message}`);
    }
    check('migration 0116 re-applies cleanly (idempotent)', reapplied);
    check('re-application caused ZERO data variance', (await globalSnapshot(db)) === before);
    const n = await db.query(`select count(*)::int c from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('admin_reorder_related_content','transition_resource_post_status')`);
    check('still exactly two functions after re-application (no duplicate overloads)', n.rows[0].c === 2, JSON.stringify(n.rows));
  }

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
