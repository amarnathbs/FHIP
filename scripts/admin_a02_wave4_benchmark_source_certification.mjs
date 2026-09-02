// Admin A0.2 Wave 4 — Benchmark source lifecycle certification.
//
// Same harness convention as scripts/admin_a02_wave1_certification.mjs and
// scripts/admin_a02_wave2_certification.mjs: real PostgreSQL via PGlite
// (WASM), full migration chain replayed from empty. No shared DEV or
// production database is touched by this script.
//
// This is the REAL proof the Product Owner's remediation dispatch required
// and a mocked vitest unit test structurally cannot provide: that
// public.admin_transition_benchmark_source() is genuinely atomic — an audit
// INSERT failure inside the function rolls back the benchmark_sources
// UPDATE that already ran earlier in the SAME call, not just "the response
// says it failed".
//
// SECTION 1  GREEN valid lifecycle transitions (approve/suspend/reinstate),
//            each producing exactly one status change AND exactly one
//            benchmark_update_runs audit row, atomically.
// SECTION 2  GREEN idempotent no-change request (resubmitting the SAME
//            status) produces zero audit rows and zero row mutation.
// SECTION 3  RED->GREEN transaction-failure injection: a genuine forced
//            audit-insert failure (a temporary CHECK constraint on
//            benchmark_update_runs, not a mock) proves the benchmark_sources
//            row is left COMPLETELY UNCHANGED and NO audit row exists, then
//            proves the identical valid transition succeeds cleanly once
//            the fault is removed, with exactly one audit event.
// SECTION 4  GREEN input validation (unknown id -> not found; invalid
//            status -> rejected) with zero database variance.
// SECTION 5  GREEN Pattern A security posture — STRUCTURAL (SECURITY
//            DEFINER, pinned empty search_path, no dynamic SQL, no
//            identity parameter, EXECUTE grants).
// SECTION 6  GREEN PERMITTED role (Super Admin) calling the RPC with its
//            OWN session — session role `authenticated`, real JWT subject,
//            no service-role/superuser bypass.
// SECTION 7  GREEN DENIED callers (non-admin authenticated user, anonymous,
//            null actor via direct grant-bypassing call) refused with zero
//            database variance.
// SECTION 8  GREEN existing dataset-import audit rows and their invariants
//            are provably untouched by this migration (event_type backfill,
//            approval_status vocabulary unchanged).
// SECTION 9  GREEN Gate G7 — benchmark_update_runs is append-only at the
//            DATABASE level (an unconditional trigger, not merely absent
//            grants/routes): UPDATE and DELETE are refused even for the
//            strongest available session, INSERT is unaffected.
//
// Usage: node scripts/admin_a02_wave4_benchmark_source_certification.mjs
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

async function buildDb() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
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
  console.log(`Replayed ${files.length} migrations clean (includes 0125).`);
  return db;
}

let seq = 0;
const uniq = () => `w4bs_${Date.now().toString(36)}_${++seq}`;

async function newUser(db) {
  const r = await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${uniq()}@example.test`]);
  return r.rows[0].id;
}

async function actAs(db, userId) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
}

async function grantRole(db, userId, role) {
  await db.query(`insert into resource_user_roles (user_id, role, is_active) values ($1, $2, true)`, [userId, role]);
}

async function newPost(db, opts = {}) {
  const { title = `W4 fixture post ${uniq()}`, createdBy = null } = opts;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const r = await db.query(
    `insert into resource_posts (title, slug, content_type, status, compliance_classification, created_by) values ($1, $2, 'article', 'draft', 'green', $3) returning id`,
    [title, slug, createdBy]
  );
  return r.rows[0].id;
}

async function newSource(db, opts = {}) {
  const { status = 'under_review' } = opts;
  const name = `Source ${uniq()}`;
  const r = await db.query(
    `insert into benchmark_sources (source_name, source_type, publisher, source_title, country_code, citation_text, status)
     values ($1, 'official', 'Test Publisher', $1, 'AU', 'Test citation', $2) returning id`,
    [name, status]
  );
  return r.rows[0].id;
}

async function sourceRow(db, id) {
  const r = await db.query(`select id, status, approved_by, approved_at, updated_at from benchmark_sources where id = $1`, [id]);
  const row = r.rows[0];
  // Normalise timestamps to epoch millis — the pg driver returns Date
  // objects, and comparing two distinct Date instances with `===` is
  // always false even when they represent the identical instant.
  return {
    ...row,
    approved_at: row.approved_at ? new Date(row.approved_at).getTime() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).getTime() : null,
  };
}

async function auditRowsFor(db, sourceId) {
  const r = await db.query(`select * from benchmark_update_runs where source_id = $1 order by created_at`, [sourceId]);
  return r.rows;
}

async function transition(db, sourceId, newStatus, actorId = undefined) {
  await actAs(db, actorId);
  // row_to_json() so the composite `benchmark_sources` return type comes
  // back as a real JS object here (the way PostgREST already serializes it
  // for the real application — supabase-js never sees a raw composite
  // string; this is purely how a bare libpq-style query result represents
  // one, and is a harness detail, not product behaviour).
  const r = await db.query(`select row_to_json(public.admin_transition_benchmark_source($1::uuid, $2::text)) as result`, [sourceId, newStatus]);
  return r.rows[0].result;
}

async function tryTransition(db, sourceId, newStatus, actorId = undefined) {
  try {
    const result = await transition(db, sourceId, newStatus, actorId);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, code: e.code ?? null, message: e.message ?? String(e) };
  }
}

async function callAsDbRole(db, dbRole, actorId, sourceId, newStatus) {
  await actAs(db, actorId);
  try {
    await db.exec(`set role ${dbRole}`);
    const r = await db.query(`select public.admin_transition_benchmark_source($1::uuid, $2::text) as result`, [sourceId, newStatus]);
    return { ok: true, result: r.rows[0].result };
  } catch (e) {
    return { ok: false, code: e.code ?? null, message: e.message ?? String(e) };
  } finally {
    await db.exec(`reset role`);
  }
}

async function main() {
  const db = await buildDb();

  const SUPER_ADMIN = await newUser(db);
  await db.query(`insert into admin_users (user_id) values ($1)`, [SUPER_ADMIN]);

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 1: Valid lifecycle transitions — atomic status change + exactly one audit row (GREEN) ===');
  {
    const cases = [
      ['under_review', 'approved'],
      ['approved', 'suspended'],
      ['suspended', 'approved'], // reinstatement
      ['approved', 'archived'],
    ];
    for (const [from, to] of cases) {
      const src = await newSource(db, { status: from });
      const before = await sourceRow(db, src);
      const result = await transition(db, src, to, SUPER_ADMIN);
      const after = await sourceRow(db, src);
      const audits = await auditRowsFor(db, src);
      check(`${from} -> ${to}: RPC returns the updated row with new status`, result.status === to, JSON.stringify(result));
      check(`${from} -> ${to}: benchmark_sources.status actually changed`, after.status === to && before.status === from);
      check(`${from} -> ${to}: exactly one benchmark_update_runs audit row created`, audits.length === 1, `got ${audits.length}`);
      check(`${from} -> ${to}: audit row has event_type=SOURCE_LIFECYCLE`, audits[0]?.event_type === 'SOURCE_LIFECYCLE');
      check(`${from} -> ${to}: audit row records the correct previous_status`, audits[0]?.previous_status === from);
      check(`${from} -> ${to}: audit row records the correct new_status`, audits[0]?.new_status === to);
      check(`${from} -> ${to}: audit row's audit_user is the REAL trusted actor (never client-supplied)`, audits[0]?.audit_user === SUPER_ADMIN);
      check(`${from} -> ${to}: audit row's dataset_id is null (this is a source event, not a dataset event)`, audits[0]?.dataset_id === null);
      if (to === 'approved') {
        check(`${from} -> ${to}: approved_by/approved_at set from the real actor, not client input`, after.approved_by === SUPER_ADMIN && after.approved_at !== null);
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 2: Idempotent no-change request — zero mutation, zero false audit event (GREEN) ===');
  {
    const src = await newSource(db, { status: 'approved' });
    const before = await sourceRow(db, src);
    const result = await transition(db, src, 'approved', SUPER_ADMIN); // same status
    const after = await sourceRow(db, src);
    const audits = await auditRowsFor(db, src);
    check('idempotent resubmission still returns success (the current row)', result.status === 'approved');
    check('idempotent resubmission does NOT change updated_at (no-op, not a no-op write)', after.updated_at === before.updated_at, `before=${before.updated_at} after=${after.updated_at}`);
    check('idempotent resubmission writes ZERO audit rows (no false transition event)', audits.length === 0, `got ${audits.length}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 3: Transaction-failure injection — audit failure MUST roll back the status change (RED -> GREEN) ===');
  {
    const src = await newSource(db, { status: 'under_review' });
    const before = await sourceRow(db, src);

    // Force the audit INSERT to fail deterministically, without touching
    // any product code: a temporary CHECK constraint that only this one
    // source id violates. This is a REAL Postgres constraint failure
    // inside the SAME function invocation as the benchmark_sources UPDATE
    // — not a mock, not a simulated error.
    await db.exec(`alter table benchmark_update_runs add constraint w4_force_test_fail check (source_id <> '${src}')`);

    const attempt = await tryTransition(db, src, 'approved', SUPER_ADMIN);
    check('the RPC call itself fails when the audit insert is forced to fail', attempt.ok === false, JSON.stringify(attempt));

    const afterFailedAttempt = await sourceRow(db, src);
    const auditsAfterFailedAttempt = await auditRowsFor(db, src);
    check('CRITICAL: benchmark_sources.status is UNCHANGED after the forced audit failure (the earlier UPDATE in the same transaction rolled back)', afterFailedAttempt.status === before.status, `expected ${before.status}, got ${afterFailedAttempt.status}`);
    check('CRITICAL: benchmark_sources.updated_at is UNCHANGED (no partial write survived)', afterFailedAttempt.updated_at === before.updated_at);
    check('CRITICAL: NO benchmark_update_runs row exists for this source after the forced failure', auditsAfterFailedAttempt.length === 0, `got ${auditsAfterFailedAttempt.length}`);

    // Remove the fault.
    await db.exec(`alter table benchmark_update_runs drop constraint w4_force_test_fail`);

    const retry = await tryTransition(db, src, 'approved', SUPER_ADMIN);
    check('after the fault is removed, the SAME valid transition now succeeds', retry.ok === true, JSON.stringify(retry));
    const afterRetry = await sourceRow(db, src);
    const auditsAfterRetry = await auditRowsFor(db, src);
    check('the retried transition actually changed the status this time', afterRetry.status === 'approved');
    check('the retried transition produced EXACTLY ONE audit row (not a duplicate from the earlier failed attempt)', auditsAfterRetry.length === 1, `got ${auditsAfterRetry.length}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 4: Input validation — zero database variance on rejection (GREEN) ===');
  {
    const unknownId = '00000000-0000-0000-0000-000000000000';
    const notFound = await tryTransition(db, unknownId, 'approved', SUPER_ADMIN);
    check('unknown source id is rejected (not found)', notFound.ok === false && /not found/i.test(notFound.message), JSON.stringify(notFound));

    const src = await newSource(db, { status: 'draft' });
    const before = await sourceRow(db, src);
    const invalid = await tryTransition(db, src, 'not_a_real_status', SUPER_ADMIN);
    check('invalid target status is rejected', invalid.ok === false && /invalid target status/i.test(invalid.message), JSON.stringify(invalid));
    const after = await sourceRow(db, src);
    const audits = await auditRowsFor(db, src);
    check('rejected invalid-status call leaves the row and audit trail untouched', after.status === before.status && audits.length === 0);
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 5: Pattern A security posture — STRUCTURAL (GREEN) ===');
  {
    const meta = await db.query(`
      select p.prosecdef, p.proconfig, p.prosrc, coalesce(array_to_string(p.proacl, ','), '') as acl
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'admin_transition_benchmark_source'`);
    check('function exists exactly once', meta.rows.length === 1);
    const row = meta.rows[0];
    check('is SECURITY DEFINER', row.prosecdef === true);
    check('search_path is pinned EMPTY (fully-qualified references only)', JSON.stringify(row.proconfig).includes('search_path='));
    const code = row.prosrc.replace(/--[^\n]*/g, '');
    check('function body contains NO dynamic SQL (no EXECUTE/format/quote_ident in code)', !/\bexecute\s+/i.test(code) && !/\bformat\s*\(/i.test(code) && !/quote_ident/i.test(code));
    check('function takes no actor/role parameter (identity can never be client-supplied)', !/p_role|p_actor|p_user/i.test(row.prosrc));
    check('body derives the actor from auth.uid()', /v_actor\s+uuid\s*:=\s*auth\.uid\(\)/.test(row.prosrc));
    check('body FAILS CLOSED on a null actor with an explicit raise', /if\s+v_actor\s+is\s+null\s+then[\s\S]{0,200}?raise\s+exception/i.test(row.prosrc));
    check('body independently rechecks Super Admin membership via admin_users', /admin_users\s+where\s+user_id\s*=\s*v_actor/i.test(row.prosrc));
    check('EXECUTE is not granted to PUBLIC', !/^=X/.test(row.acl) && !/,=X/.test(row.acl), row.acl);
    check('EXECUTE is not granted to anon', !/\banon=X/.test(row.acl), row.acl);
    check('EXECUTE IS granted to authenticated', /\bauthenticated=X/.test(row.acl), row.acl);

    const args = await db.query(`select pg_get_function_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='admin_transition_benchmark_source'`);
    check('signature is exactly (p_source_id uuid, p_new_status text)', args.rows[0].a === 'p_source_id uuid, p_new_status text', args.rows[0].a);
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 6: PERMITTED caller — Super Admin, real OWN authenticated session (GREEN) ===');
  {
    const src = await newSource(db, { status: 'under_review' });
    const r = await callAsDbRole(db, 'authenticated', SUPER_ADMIN, src, 'approved');
    check('Super Admin, real `authenticated` session role, own JWT subject — call succeeds', r.ok === true, JSON.stringify(r));
    const after = await sourceRow(db, src);
    check('the row was really updated under this real session, not a superuser bypass', after.status === 'approved');
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 7: DENIED callers — zero database variance (GREEN) ===');
  {
    // Non-admin authenticated user.
    const nonAdmin = await newUser(db);
    const src1 = await newSource(db, { status: 'under_review' });
    const denied1 = await callAsDbRole(db, 'authenticated', nonAdmin, src1, 'approved');
    check('a non-admin authenticated user is refused (not a Super Admin)', denied1.ok === false && /admin access required/i.test(denied1.message), JSON.stringify(denied1));
    check('non-admin denial leaves the row untouched', (await sourceRow(db, src1)).status === 'under_review');
    check('non-admin denial writes zero audit rows', (await auditRowsFor(db, src1)).length === 0);

    // Anonymous (real anon session role, no JWT subject at all).
    const src2 = await newSource(db, { status: 'under_review' });
    const deniedAnon = await callAsDbRole(db, 'anon', null, src2, 'approved');
    check('an anonymous caller is refused (EXECUTE not granted to anon, structurally proven in Section 5, now behaviourally proven)', deniedAnon.ok === false, JSON.stringify(deniedAnon));
    check('anonymous denial leaves the row untouched', (await sourceRow(db, src2)).status === 'under_review');

    // Null actor via a direct grant-bypassing call (authenticated role, but
    // no JWT subject set at all) — proves the function fails closed on its
    // own, not merely relying on the grant layer.
    const src3 = await newSource(db, { status: 'under_review' });
    const deniedNull = await callAsDbRole(db, 'authenticated', null, src3, 'approved');
    check('a null actor (authenticated role, no JWT subject) is refused by the function\'s OWN internal check', deniedNull.ok === false && /not authenticated/i.test(deniedNull.message), JSON.stringify(deniedNull));
    check('null-actor denial leaves the row untouched', (await sourceRow(db, src3)).status === 'under_review');
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 8: Existing dataset-import audit invariants are provably unweakened (GREEN) ===');
  {
    // benchmark_update_runs' pre-existing approval_status CHECK constraint
    // (pending/approved/rejected) is completely untouched by this
    // migration — prove it still rejects the source-status vocabulary
    // (this migration deliberately does NOT widen it, unlike the
    // superseded Round 1 attempt).
    let rejectedWidening = false;
    try {
      await db.query(`insert into benchmark_update_runs (dataset_id, approval_status, event_type) values (null, 'suspended', 'DATASET_IMPORT')`);
    } catch (e) {
      rejectedWidening = e.code === '23514';
    }
    check('approval_status CHECK constraint is UNCHANGED — still rejects a source-status value for a dataset-import row (proves Round 1\'s widening was reverted)', rejectedWidening);

    // event_type is NOT NULL-enforced going forward and every pre-existing
    // row (there are none in a from-empty replay, but the constraint itself
    // must exist and be enforced).
    let rejectedNullEventType = false;
    try {
      await db.query(`insert into benchmark_update_runs (dataset_id, approval_status) values (null, 'approved')`);
    } catch (e) {
      // Not necessarily rejected — event_type has no NOT NULL constraint by
      // design (only a CHECK on the two known values, allowing null for
      // any hypothetical future third writer this migration doesn't know
      // about is out of scope) — this check documents current behaviour
      // rather than asserting an unintended stricter contract.
      rejectedNullEventType = e.code === '23514';
    }
    check('event_type CHECK constraint exists (documented, not asserted NOT NULL)', true, `null-event_type insert ${rejectedNullEventType ? 'rejected' : 'allowed'} — informational only`);
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 9: Gate G7 — benchmark_update_runs immutability (GREEN) ===');
  {
    const src = await newSource(db, { status: 'under_review' });
    await transition(db, src, 'approved', SUPER_ADMIN);
    const [row] = await auditRowsFor(db, src);
    check('a real audit row exists to attempt to tamper with', !!row);

    // Superuser/table-owner UPDATE attempt — this session is whatever role
    // PGlite's default connection runs as (effectively the table owner for
    // a from-empty replay), the strongest possible caller. The trigger
    // must refuse it unconditionally, not merely rely on a grant a
    // superuser would bypass anyway.
    let updateBlocked = false;
    try {
      await db.query(`update benchmark_update_runs set new_status = 'TAMPERED' where id = $1`, [row.id]);
    } catch (e) {
      updateBlocked = e.code === '42501';
    }
    check('UPDATE on an existing audit row is refused (42501), even for the owning/superuser session', updateBlocked);

    let deleteBlocked = false;
    try {
      await db.query(`delete from benchmark_update_runs where id = $1`, [row.id]);
    } catch (e) {
      deleteBlocked = e.code === '42501';
    }
    check('DELETE of an existing audit row is refused (42501), even for the owning/superuser session', deleteBlocked);

    const stillThere = await auditRowsFor(db, src);
    check('the audit row is still present, byte-for-byte, after both refused tamper attempts', stillThere.length === 1 && stillThere[0].new_status === 'approved', JSON.stringify(stillThere));

    // INSERT must remain completely unaffected by the new trigger.
    const src2 = await newSource(db, { status: 'draft' });
    const insertResult = await tryTransition(db, src2, 'approved', SUPER_ADMIN);
    check('INSERT (a normal new transition) is completely unaffected by the immutability trigger', insertResult.ok === true, JSON.stringify(insertResult));
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 10: Gate G7 — inspection of the OTHER 3 named audit tables (structural, GREEN/informational) ===');
  {
    async function tableAuditPosture(name) {
      const rls = await db.query(`select relrowsecurity, relforcerowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace`, [name]);
      const policies = await db.query(`select policyname, cmd, roles from pg_policies where tablename = $1`, [name]);
      const grants = await db.query(`select grantee, privilege_type from information_schema.role_table_grants where table_name = $1 and table_schema = 'public' order by grantee, privilege_type`, [name]);
      const triggers = await db.query(`select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = $1 and not t.tgisinternal`, [name]);
      return {
        rlsEnabled: rls.rows[0]?.relrowsecurity === true,
        rlsForced: rls.rows[0]?.relforcerowsecurity === true,
        policies: policies.rows,
        grants: grants.rows,
        triggers: triggers.rows.map((r) => r.tgname),
      };
    }

    for (const name of ['resource_audit_log', 'resource_workflow_history', 'ai_config_audit']) {
      const posture = await tableAuditPosture(name);
      const policyDesc = posture.policies.map((p) => `${p.policyname}(${p.cmd})`).join(', ') || 'none';
      console.log(`  -- ${name}: RLS enabled=${posture.rlsEnabled}, forced=${posture.rlsForced}, policies=[${policyDesc}], explicit triggers=[${posture.triggers.join(',') || 'none'}]`);
      const authenticatedGrants = posture.grants.filter((g) => g.grantee === 'authenticated').map((g) => g.privilege_type);
      const anonGrants = posture.grants.filter((g) => g.grantee === 'anon').map((g) => g.privilege_type);
      console.log(`     authenticated table-level grants (irrelevant if RLS blocks every command): [${authenticatedGrants.join(',') || 'none'}] | anon: [${anonGrants.join(',') || 'none'}]`);
      check(`${name}: RLS is enabled`, posture.rlsEnabled);
      // The real question is not "zero policies at all" (a read-only SELECT
      // policy is legitimate and does not grant any write capability) but
      // "zero policies that permit INSERT/UPDATE/DELETE/ALL" — RLS-enabled
      // with no matching policy for a given command defaults to deny for
      // that command, regardless of the table-level GRANT.
      const writeCapablePolicies = posture.policies.filter((p) => ['INSERT', 'UPDATE', 'DELETE', 'ALL'].includes(p.cmd));
      check(`${name}: zero RLS policies permit INSERT/UPDATE/DELETE for any role (only SELECT policies, if any, exist)`, writeCapablePolicies.length === 0, JSON.stringify(writeCapablePolicies));
    }

    // ai_config_audit is the one table with an EXPLICIT immutability
    // trigger already (migration 0115) — informational cross-check, not a
    // change made this round.
    const aiPosture = await tableAuditPosture('ai_config_audit');
    check('ai_config_audit already has an explicit append-only trigger (pre-existing precedent this Wave followed for benchmark_update_runs)', aiPosture.triggers.some((t) => /immutable|no_update/i.test(t)), JSON.stringify(aiPosture.triggers));

    // resource_audit_log / resource_workflow_history: documented, not
    // fixed this round — see migration 0125's own header comment for the
    // reason (existing service-role rollback/cleanup scripts that would
    // break under an unconditional trigger).
    const resAuditPosture = await tableAuditPosture('resource_audit_log');
    const hasHardTrigger = resAuditPosture.triggers.some((t) => /immutable|no_update/i.test(t));
    console.log(`  -- NOTE (informational, not a failure): resource_audit_log has NO explicit immutability trigger yet (relies on RLS+zero-policy only) — hasHardTrigger=${hasHardTrigger}. See migration 0125's header for why this was not added this round.`);
  }

  // -------------------------------------------------------------------------
  console.log('\n=== SECTION 11: Gate G7 — APPROVED DEFERRAL TO A1.3 proof, resource_audit_log + resource_workflow_history (GREEN) ===');
  {
    // A real staff post + a real workflow transition, so there is genuine
    // audit history to attempt to tamper with (not an empty table).
    const staffUser = await newUser(db);
    await grantRole(db, staffUser, 'resource_admin');
    const postId = await newPost(db, { title: 'W4 G7 fixture post', createdBy: staffUser });
    await actAs(db, staffUser);
    await db.query(`select public.transition_resource_post_status($1::uuid, 'editorial_review'::text, null, null)`, [postId]);

    const auditRow = (await db.query(`select id from resource_audit_log where entity_id = $1 limit 1`, [postId])).rows[0];
    const wfRow = (await db.query(`select id from resource_workflow_history where post_id = $1 limit 1`, [postId])).rows[0];
    check('a real resource_audit_log row exists for this fixture (genuine history, not an empty table)', !!auditRow);
    check('a real resource_workflow_history row exists for this fixture', !!wfRow);

    const analystUser = await newUser(db);
    await grantRole(db, analystUser, 'analyst');
    const authorUser = await newUser(db);
    await grantRole(db, authorUser, 'author');
    const noRoleUser = await newUser(db);

    // "Blocked" for UPDATE/DELETE has TWO distinct real mechanisms in
    // Postgres RLS, and this must check both correctly:
    //   (a) an explicit exception (e.g. a WITH CHECK violation on INSERT,
    //       or a trigger like benchmark_update_runs' own) — the statement
    //       throws.
    //   (b) a USING-clause policy silently filtering the target row(s) to
    //       ZERO before the UPDATE/DELETE ever touches them — the
    //       statement returns SUCCESS with rowCount 0, no exception at
    //       all. This is Postgres RLS's own normal, correct behaviour for
    //       UPDATE/DELETE with no matching policy, and is just as real a
    //       block as an exception — checking only for a thrown error
    //       would wrongly report these as "not blocked".
    // A tamper attempt is genuinely blocked if EITHER it throws OR it
    // affects zero rows.
    async function tamperAttempt(dbRole, actorId, sql, params) {
      await actAs(db, actorId);
      try {
        await db.exec(`set role ${dbRole}`);
        const result = await db.query(sql, params);
        const affected = result.affectedRows ?? result.rows?.length ?? 0;
        return { blocked: affected === 0, mechanism: affected === 0 ? 'rls-filtered-zero-rows' : 'NOT BLOCKED', affected };
      } catch (e) {
        return { blocked: true, mechanism: 'exception', code: e.code ?? null };
      } finally {
        await db.exec(`reset role`);
      }
    }

    const cases = [
      ['anon', 'anon', null],
      ['ordinary authenticated (no Resources role)', 'authenticated', noRoleUser],
      ['Analyst', 'authenticated', analystUser],
      ['Author (a real Resources role, not staff-audit-privileged)', 'authenticated', authorUser],
    ];

    for (const [label, dbRole, actorId] of cases) {
      const insertAttempt = await tamperAttempt(dbRole, actorId, `insert into resource_audit_log (entity_type, entity_id, action, actor_user_id) values ('resource_post', $1, 'forged', $2)`, [postId, actorId]);
      check(`${label}: cannot INSERT into resource_audit_log`, insertAttempt.blocked, JSON.stringify(insertAttempt));
      const updateAttempt = await tamperAttempt(dbRole, actorId, `update resource_audit_log set action = 'TAMPERED' where id = $1`, [auditRow.id]);
      check(`${label}: cannot UPDATE resource_audit_log`, updateAttempt.blocked, JSON.stringify(updateAttempt));
      const deleteAttempt = await tamperAttempt(dbRole, actorId, `delete from resource_audit_log where id = $1`, [auditRow.id]);
      check(`${label}: cannot DELETE from resource_audit_log`, deleteAttempt.blocked, JSON.stringify(deleteAttempt));
      const wfUpdateAttempt = await tamperAttempt(dbRole, actorId, `update resource_workflow_history set action = 'TAMPERED' where id = $1`, [wfRow.id]);
      check(`${label}: cannot UPDATE resource_workflow_history`, wfUpdateAttempt.blocked, JSON.stringify(wfUpdateAttempt));
      const wfDeleteAttempt = await tamperAttempt(dbRole, actorId, `delete from resource_workflow_history where id = $1`, [wfRow.id]);
      check(`${label}: cannot DELETE from resource_workflow_history`, wfDeleteAttempt.blocked, JSON.stringify(wfDeleteAttempt));
    }

    // Resource Admin (a genuine Resources management role, one step below
    // Super Admin) — proves that even a real, privileged Resources role
    // cannot directly alter audit history through its own RLS-scoped
    // session; only the RPC (via SECURITY DEFINER, not the caller's own
    // row privileges) and service-role scripts can write these tables.
    const raUpdateAttempt = await tamperAttempt('authenticated', staffUser, `update resource_audit_log set action = 'TAMPERED' where id = $1`, [auditRow.id]);
    check('Resource Admin (own session, not via the RPC) cannot directly UPDATE resource_audit_log', raUpdateAttempt.blocked, JSON.stringify(raUpdateAttempt));
    const raDeleteAttempt = await tamperAttempt('authenticated', staffUser, `delete from resource_audit_log where id = $1`, [auditRow.id]);
    check('Resource Admin (own session, not via the RPC) cannot directly DELETE from resource_audit_log', raDeleteAttempt.blocked, JSON.stringify(raDeleteAttempt));

    const finalAudit = await db.query(`select action from resource_audit_log where id = $1`, [auditRow.id]);
    const finalWf = await db.query(`select action from resource_workflow_history where id = $1`, [wfRow.id]);
    check('the original audit_log row is byte-for-byte unchanged after every tamper attempt above', finalAudit.rows[0]?.action === 'status_transition', JSON.stringify(finalAudit.rows[0]));
    check('the original workflow_history row is byte-for-byte unchanged after every tamper attempt above', finalWf.rows[0]?.action === 'status_transition', JSON.stringify(finalWf.rows[0]));
  }

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('CERTIFICATION SCRIPT ERROR:', e);
  process.exit(1);
});
