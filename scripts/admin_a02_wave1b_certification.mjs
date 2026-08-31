// A0.2 Wave 1B certification — single-recommendation create/update
// atomicity (admin_upsert_recommendation_atomic, migration 0109) plus the
// database-level "active + zero conditions" invariant (matches_unconditionally
// column and its two deferred constraint triggers, same migration).
//
// Same harness convention as scripts/admin_a02_wave1_certification.mjs: real
// PostgreSQL 18 via PGlite (WASM), full migration chain replayed from empty.
// No shared DEV/production database is touched.
//
// Proves, in order:
//   1. REGRESSION PROOF (PATCH) — the exact original PATCH mechanism
//      (UPDATE master, DELETE conditions, INSERT replacement — three
//      independent statements) genuinely loses conditions when the insert
//      fails. RED.
//   2. REGRESSION PROOF (POST/create) — the exact original POST mechanism
//      (INSERT master, THEN INSERT conditions) leaves a newly created,
//      active recommendation with zero conditions when the conditions
//      insert fails. RED. (Found during Wave 1B implementation — same
//      defect class as the PATCH bug, in scope per Wave 1B item 2's
//      "create/update... one single transaction".)
//   3. GREEN — admin_upsert_recommendation_atomic() under the IDENTICAL
//      failure scenarios for both create and update: proves the
//      recommendation record itself, its original conditions, its
//      active/inactive state and its metadata are ALL preserved unchanged.
//   4. Zero-condition explicit-clear semantics for the single-edit path,
//      mirroring Wave 1's CSV `clear` flag.
//   5. The active+zero-conditions invariant: both deferred triggers, in
//      both directions (deletion-driven and activation-driven), including
//      the matches_unconditionally escape hatch working correctly, and
//      proof that a NORMAL non-zero replace never false-positives.
//   6. Security: EXECUTE lockdown on the new function.
//   7. Combined regression: Wave 1's CSV-conditions RPC and Wave 1B's
//      single-record RPC exercised against the SAME database instance,
//      interleaved, proving neither regressed the other.
//
// Usage: node scripts/admin_a02_wave1b_certification.mjs
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
  console.log(`Replayed ${files.length} migrations clean (includes 0107 and 0109).\n`);
  return db;
}

async function insertMaster(db, code, { isActive = false, matchesUnconditionally = false } = {}) {
  await db.query(
    `insert into action_recommendation_master
       (recommendation_code, forecast_category, sub_category, scenario_name, forecast_status, severity, action_type, action_title_template, action_content_template, is_active, matches_unconditionally)
     values ($1, 'debt', 'overall_variance', 'test scenario', 'on_track', 'medium', 'reduce_debt', 'Test title', 'Test content', $2, $3)
     returning id`,
    [code, isActive, matchesUnconditionally]
  );
  const r = await db.query(`select id from action_recommendation_master where recommendation_code = $1`, [code]);
  return r.rows[0].id;
}

async function seedConditions(db, code, n = 2) {
  for (let i = 1; i <= n; i++) {
    await db.query(
      `insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator, comparison_value, evaluation_order)
       values ($1, 1, $2, 'equals', $3, $4)`,
      [code, `test_field_${i}`, `value_${i}`, i]
    );
  }
}

async function countConditions(db, code) {
  const r = await db.query(`select count(*)::int as n from action_recommendation_conditions where recommendation_code = $1`, [code]);
  return r.rows[0].n;
}

async function getMaster(db, code) {
  const r = await db.query(`select * from action_recommendation_master where recommendation_code = $1`, [code]);
  return r.rows[0] ?? null;
}

// Fixture helper for a LEGITIMATE active+has-conditions starting state:
// insert inactive, seed real conditions, THEN activate via a separate
// UPDATE — this is itself proof the new deferred trigger behaves correctly
// for the ordinary, safe case (activate only once conditions already
// exist), never a workaround for a bug. Insert-active-with-zero-conditions
// directly (as a single fixture statement) would be correctly rejected by
// trg_enforce_master_nonzero_conditions — that rejection is the invariant
// working, not a script defect, which is exactly why this fixture avoids
// doing that when the test needs a VALID starting state.
async function insertActiveWithConditions(db, code, n, { matchesUnconditionally = false } = {}) {
  const id = await insertMaster(db, code, { isActive: false, matchesUnconditionally });
  await seedConditions(db, code, n);
  await db.query(`update action_recommendation_master set is_active = true where id = $1`, [id]);
  return id;
}

async function main() {
  const db = await buildDb();

  // ---------------------------------------------------------------------
  // SECTION 1: PATCH regression proof (RED)
  // ---------------------------------------------------------------------
  console.log('=== SECTION 1: Original PATCH defect reproduction (RED) ===');
  {
    const code = 'W1B_RED_PATCH';
    await insertMaster(db, code, { isActive: false });
    await seedConditions(db, code, 3);
    check('fixture has 3 pre-existing conditions', (await countConditions(db, code)) === 3);

    // Exact original PATCH sequence: UPDATE master (its own statement)...
    await db.exec(`update action_recommendation_master set scenario_name = 'edited scenario', updated_at = now() where recommendation_code = '${code}'`);
    // ...then DELETE existing conditions (its own statement)...
    await db.exec(`delete from action_recommendation_conditions where recommendation_code = '${code}'`);
    check('old pattern: delete alone already removed the rows', (await countConditions(db, code)) === 0);
    // ...then a separate INSERT that fails (null field_name).
    let insertFailed = false;
    try {
      await db.exec(`insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator) values ('${code}', 1, NULL, 'equals')`);
    } catch {
      insertFailed = true;
    }
    check('old pattern: replacement insert genuinely fails', insertFailed);
    check('DEFECT CONFIRMED: conditions are now permanently ZERO despite the master update having "succeeded"', (await countConditions(db, code)) === 0);
    const master = await getMaster(db, code);
    check('the master row DID keep the edit (further proving the two writes were never atomic together)', master.scenario_name === 'edited scenario');
  }

  // ---------------------------------------------------------------------
  // SECTION 2: POST/create regression proof (RED) — found during Wave 1B
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 2: Original POST/create defect reproduction (RED) ===');
  {
    const code = 'W1B_RED_POST';
    // Exact original POST sequence: INSERT master (own statement, ACTIVE)...
    await db.exec(`insert into action_recommendation_master (recommendation_code, forecast_category, sub_category, scenario_name, forecast_status, severity, action_type, action_title_template, action_content_template, is_active, matches_unconditionally) values ('${code}', 'debt', 'overall_variance', 'new scenario', 'on_track', 'medium', 'reduce_debt', 'Test title', 'Test content', true, true)`);
    // matches_unconditionally=true here ONLY to isolate the ORIGINAL defect
    // (pre-0109 code had no such column/trigger at all) from Wave 1B's new
    // invariant — this section is reproducing the pre-existing two-statement
    // race, not the invariant.
    check('master row created', (await getMaster(db, code)) !== null);
    // ...then a SEPARATE INSERT of conditions that fails.
    let insertFailed = false;
    try {
      await db.exec(`insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator) values ('${code}', 1, NULL, 'equals')`);
    } catch {
      insertFailed = true;
    }
    check('old pattern: conditions insert genuinely fails', insertFailed);
    check('DEFECT CONFIRMED: a newly "created" recommendation exists with zero conditions, silently', (await countConditions(db, code)) === 0);
  }

  // ---------------------------------------------------------------------
  // SECTION 3: admin_upsert_recommendation_atomic — GREEN under identical failures
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 3: Fixed RPC under the identical failures (GREEN) ===');
  {
    // 3a. Update path, identical failure to Section 1.
    const code = 'W1B_GREEN_PATCH';
    const id = await insertMaster(db, code, { isActive: false });
    await seedConditions(db, code, 3);
    const before = await getMaster(db, code);

    let rpcFailed = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, false) as r`, [
        id,
        JSON.stringify({ scenario_name: 'attempted edit — should not stick' }),
        JSON.stringify([{ field_name: null, operator: 'equals', comparison_value: 'x' }]),
      ]);
    } catch {
      rpcFailed = true;
    }
    check('RPC call genuinely fails (same underlying NOT NULL violation)', rpcFailed);

    const after = await getMaster(db, code);
    check('the recommendation record itself is preserved unchanged (scenario_name NOT edited)', after.scenario_name === before.scenario_name && before.scenario_name === 'test scenario');
    check('its original conditions survive untouched (all 3)', (await countConditions(db, code)) === 3);
    check('its active/inactive state is preserved unchanged', after.is_active === before.is_active);
    check('its updated_at metadata is preserved unchanged (update never committed)', after.updated_at.getTime?.() === before.updated_at.getTime?.() || String(after.updated_at) === String(before.updated_at));

    // 3b. Create path, identical failure to Section 2.
    const code2 = 'W1B_GREEN_POST';
    let createFailed = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic(null, $1::jsonb, $2::jsonb, false) as r`, [
        JSON.stringify({ recommendation_code: code2, forecast_category: 'debt', sub_category: 'overall_variance', scenario_name: 'new scenario', forecast_status: 'on_track', severity: 'medium', action_type: 'reduce_debt', action_title_template: 'Test title', action_content_template: 'Test content', is_active: true, matches_unconditionally: true }),
        JSON.stringify([{ field_name: null, operator: 'equals', comparison_value: 'x' }]),
      ]);
    } catch {
      createFailed = true;
    }
    check('create RPC call genuinely fails', createFailed);
    check('FIX CONFIRMED: NO recommendation record was created at all (not left half-created with zero conditions)', (await getMaster(db, code2)) === null);
  }

  // ---------------------------------------------------------------------
  // SECTION 4: Successful create/update via the new RPC
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 4: Successful create/update ===');
  {
    // Create with conditions in the same call.
    const r1 = await db.query(`select admin_upsert_recommendation_atomic(null, $1::jsonb, $2::jsonb, false) as r`, [
      JSON.stringify({ recommendation_code: 'W1B_OK_CREATE', forecast_category: 'goal', sub_category: 'overall_variance', scenario_name: 'ok create', forecast_status: 'on_track', severity: 'low', action_type: 'save_more', action_title_template: 'T', action_content_template: 'C', is_active: true }),
      JSON.stringify([{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'goal', evaluation_order: 1 }]),
    ]);
    check('create: created=true', r1.rows[0].r.created === true, JSON.stringify(r1.rows[0].r));
    check('create: conditionsInserted=1', r1.rows[0].r.conditionsInserted === 1);
    check('create: master row exists with the right fields', (await getMaster(db, 'W1B_OK_CREATE')).scenario_name === 'ok create');
    check('create: exactly 1 condition persisted', (await countConditions(db, 'W1B_OK_CREATE')) === 1);

    // Update: master fields only, conditions untouched.
    const id = (await getMaster(db, 'W1B_OK_CREATE')).id;
    const r2 = await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, null, false) as r`, [id, JSON.stringify({ priority_score: 42 })]);
    check('update: created=false', r2.rows[0].r.created === false);
    check('update: conditionsTouched=false (conditions param was null)', r2.rows[0].r.conditionsTouched === false);
    check('update: master field changed', (await getMaster(db, 'W1B_OK_CREATE')).priority_score === 42);
    check('update: conditions completely untouched (still 1, same row)', (await countConditions(db, 'W1B_OK_CREATE')) === 1);

    // Update: replace conditions (master untouched this time).
    const r3 = await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, false) as r`, [
      id,
      JSON.stringify({}),
      JSON.stringify([
        { field_name: 'forecast_status', operator: 'equals', comparison_value: 'at_risk', evaluation_order: 1 },
        { field_name: 'severity', operator: 'equals', comparison_value: 'high', evaluation_order: 2 },
      ]),
    ]);
    check('update: conditionsReplaced=1, conditionsInserted=2', r3.rows[0].r.conditionsReplaced === 1 && r3.rows[0].r.conditionsInserted === 2, JSON.stringify(r3.rows[0].r));
    check('update: priority_score from the PREVIOUS update call is preserved (empty p_master object changes nothing)', (await getMaster(db, 'W1B_OK_CREATE')).priority_score === 42);
  }

  // ---------------------------------------------------------------------
  // SECTION 5: Zero-condition explicit-clear semantics (mirrors Wave 1)
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 5: Zero-condition explicit-clear semantics ===');
  {
    const id = await insertMaster(db, 'W1B_CLEAR_INACTIVE', { isActive: false });
    await seedConditions(db, 'W1B_CLEAR_INACTIVE', 2);

    let rejectedNoFlag = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, false) as r`, [id, '{}', '[]']);
    } catch {
      rejectedNoFlag = true;
    }
    check('empty conditions array WITHOUT clear_conditions=true is rejected', rejectedNoFlag);
    check('conditions untouched by the rejected call', (await countConditions(db, 'W1B_CLEAR_INACTIVE')) === 2);

    // With the flag, on an INACTIVE recommendation, succeeds (no invariant conflict).
    await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, true) as r`, [id, '{}', '[]']);
    check('empty conditions array WITH clear_conditions=true succeeds on an inactive recommendation', (await countConditions(db, 'W1B_CLEAR_INACTIVE')) === 0);
  }

  // ---------------------------------------------------------------------
  // SECTION 6: The active + zero-conditions invariant (migration 0109 triggers)
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 6: Active + zero-conditions invariant ===');
  {
    // 6a. Deletion-driven (trg_recommendation_conditions_nonzero): clearing
    // an ACTIVE, non-unconditional recommendation's conditions is rejected,
    // even with clear_conditions=true (the flag only satisfies "explicit
    // intent to touch conditions", not the separate active+unconditional
    // safety rule — both must line up).
    const idActive = await insertActiveWithConditions(db, 'W1B_INV_ACTIVE_NO_FLAG', 1);
    let rejected = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, true) as r`, [idActive, '{}', '[]']);
    } catch {
      rejected = true;
    }
    check('clearing conditions on an ACTIVE, non-unconditional recommendation is rejected by the DB trigger', rejected);
    check('its 1 original condition survives the rejected clear', (await countConditions(db, 'W1B_INV_ACTIVE_NO_FLAG')) === 1);

    // 6b. Same, but matches_unconditionally=true set in the SAME call — succeeds.
    const idUnconditional = await insertActiveWithConditions(db, 'W1B_INV_ACTIVE_WITH_FLAG', 1);
    let succeeded = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, true) as r`, [idUnconditional, JSON.stringify({ matches_unconditionally: true }), '[]']);
      succeeded = true;
    } catch (e) {
      succeeded = false;
      console.log('    (unexpected error)', e.message);
    }
    check('clearing conditions while ALSO explicitly setting matches_unconditionally=true, in the same call, succeeds', succeeded);
    check('the recommendation now genuinely has zero conditions, deliberately', (await countConditions(db, 'W1B_INV_ACTIVE_WITH_FLAG')) === 0);

    // 6c. Activation-driven (trg_recommendation_master_nonzero_conditions):
    // activating a recommendation that ALREADY has zero conditions, without
    // touching conditions in this call, is rejected.
    const idToActivate = await insertMaster(db, 'W1B_INV_ACTIVATE_ZERO', { isActive: false, matchesUnconditionally: false });
    // Deliberately zero conditions, never seeded.
    let activateRejected = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, null, false) as r`, [idToActivate, JSON.stringify({ is_active: true })]);
    } catch {
      activateRejected = true;
    }
    check('activating a zero-condition, non-unconditional recommendation is rejected', activateRejected);
    check('it remains inactive (the rejected activation never committed)', (await getMaster(db, 'W1B_INV_ACTIVATE_ZERO')).is_active === false);

    // 6d. Same activation, but matches_unconditionally=true — succeeds.
    const idToActivateOk = await insertMaster(db, 'W1B_INV_ACTIVATE_ZERO_OK', { isActive: false, matchesUnconditionally: false });
    let activateSucceeded = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, null, false) as r`, [idToActivateOk, JSON.stringify({ is_active: true, matches_unconditionally: true })]);
      activateSucceeded = true;
    } catch (e) {
      console.log('    (unexpected error)', e.message);
    }
    check('activating a zero-condition recommendation WITH matches_unconditionally=true succeeds', activateSucceeded);
    check('it is now genuinely active-and-unconditional, deliberately', (await getMaster(db, 'W1B_INV_ACTIVATE_ZERO_OK')).is_active === true);

    // 6e. Create directly as active+zero-conditions without the flag — rejected.
    let createRejected = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic(null, $1::jsonb, null, false) as r`, [
        JSON.stringify({ recommendation_code: 'W1B_INV_CREATE_ACTIVE_ZERO', forecast_category: 'debt', sub_category: 'x', scenario_name: 'x', forecast_status: 'on_track', severity: 'low', action_type: 'x', action_title_template: 'T', action_content_template: 'C', is_active: true }),
      ]);
    } catch {
      createRejected = true;
    }
    check('creating directly as active+zero-conditions (no flag, no conditions supplied) is rejected', createRejected);
    check('nothing was created', (await getMaster(db, 'W1B_INV_CREATE_ACTIVE_ZERO')) === null);

    // 6f. Sanity: a NORMAL non-zero replace (delete N, insert M>0 in the
    // same call) must NEVER false-positive against the deferred trigger.
    const idNormal = await insertActiveWithConditions(db, 'W1B_INV_NORMAL_REPLACE', 2);
    let normalOk = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, $3::jsonb, false) as r`, [idNormal, '{}', JSON.stringify([{ field_name: 'x', operator: 'equals', comparison_value: '1' }])]);
      normalOk = true;
    } catch (e) {
      console.log('    (unexpected error)', e.message);
    }
    check('a normal active-recommendation replace (2 conditions -> 1 condition) does NOT false-positive against the deferred trigger', normalOk);
    check('exactly 1 condition remains', (await countConditions(db, 'W1B_INV_NORMAL_REPLACE')) === 1);
  }

  // ---------------------------------------------------------------------
  // SECTION 7: Security
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 7: Security ===');
  {
    const r = await db.query(`select grantee from information_schema.routine_privileges where routine_name = 'admin_upsert_recommendation_atomic'`);
    const grantees = r.rows.map((x) => x.grantee);
    check('EXECUTE NOT granted to public', !grantees.includes('public'), JSON.stringify(grantees));
    check('EXECUTE NOT granted to anon', !grantees.includes('anon'), JSON.stringify(grantees));
    check('EXECUTE NOT granted to authenticated', !grantees.includes('authenticated'), JSON.stringify(grantees));
    check('EXECUTE granted to service_role', grantees.includes('service_role'), JSON.stringify(grantees));

    await db.exec(`set role authenticated`);
    let denied = false;
    try {
      await db.query(`select admin_upsert_recommendation_atomic(null, $1::jsonb, null, false) as r`, [JSON.stringify({ recommendation_code: 'SHOULD_NOT_HAPPEN' })]);
    } catch (e) {
      denied = /permission denied/i.test(e.message);
    }
    await db.exec(`reset role`);
    check('a direct call as role "authenticated" is permission-denied', denied);
  }

  // ---------------------------------------------------------------------
  // SECTION 8: Combined regression — Wave 1 (CSV) + Wave 1B (single-edit)
  // interleaved against the SAME database instance
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 8: Combined Wave 1 + Wave 1B regression ===');
  {
    // Create a code via the Wave 1B RPC...
    const createRes = await db.query(`select admin_upsert_recommendation_atomic(null, $1::jsonb, null, false) as r`, [
      JSON.stringify({ recommendation_code: 'W1B_COMBINED_A', forecast_category: 'debt', sub_category: 'x', scenario_name: 'x', forecast_status: 'on_track', severity: 'low', action_type: 'x', action_title_template: 'T', action_content_template: 'C', is_active: false }),
    ]);
    check('combined: code created via Wave 1B RPC', createRes.rows[0].r.created === true);

    // ...then import ITS conditions via the Wave 1 CSV RPC.
    const csvRes = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({ groups: [{ recommendation_code: 'W1B_COMBINED_A', clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'debt', evaluation_order: 1 }] }] }),
    ]);
    check('combined: conditions imported via Wave 1 CSV RPC for a Wave-1B-created code', csvRes.rows[0].r.conditionsInserted === 1);

    // Edit ITS master fields via Wave 1B RPC, WITHOUT touching conditions —
    // the CSV-imported conditions must survive untouched.
    const idA = (await getMaster(db, 'W1B_COMBINED_A')).id;
    await db.query(`select admin_upsert_recommendation_atomic($1::uuid, $2::jsonb, null, false) as r`, [idA, JSON.stringify({ priority_score: 7 })]);
    check('combined: CSV-imported conditions survive an unrelated Wave 1B master-only edit', (await countConditions(db, 'W1B_COMBINED_A')) === 1);
    check('combined: the Wave 1B edit itself took effect', (await getMaster(db, 'W1B_COMBINED_A')).priority_score === 7);

    // A SECOND, independent code — edited via Wave 1B, then ALSO included
    // in a Wave 1 CSV upload alongside code A — proves the two RPCs don't
    // cross-contaminate when both touch overlapping codes in one CSV batch.
    await db.query(`select admin_upsert_recommendation_atomic(null, $1::jsonb, null, false) as r`, [
      JSON.stringify({ recommendation_code: 'W1B_COMBINED_B', forecast_category: 'goal', sub_category: 'x', scenario_name: 'x', forecast_status: 'on_track', severity: 'low', action_type: 'x', action_title_template: 'T', action_content_template: 'C', is_active: false }),
    ]);
    const csvBatch = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({
        groups: [
          { recommendation_code: 'W1B_COMBINED_A', clear: false, conditions: [{ field_name: 'forecast_status', operator: 'equals', comparison_value: 'at_risk', evaluation_order: 1 }] },
          { recommendation_code: 'W1B_COMBINED_B', clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'goal', evaluation_order: 1 }] },
        ],
      }),
    ]);
    check('combined: batch CSV import touching a Wave-1B-edited code + a fresh code both succeed together', csvBatch.rows[0].r.recommendationsAffected === 2);
    check('combined: code A now has exactly its 1 new condition (old one replaced)', (await countConditions(db, 'W1B_COMBINED_A')) === 1);
    check('combined: code B has exactly its 1 condition', (await countConditions(db, 'W1B_COMBINED_B')) === 1);
    check('combined: code A master field from the earlier Wave 1B edit (priority_score=7) is untouched by the CSV RPC (which never touches master)', (await getMaster(db, 'W1B_COMBINED_A')).priority_score === 7);
  }

  console.log(`\n${'='.repeat(70)}\nA0.2 WAVE 1B CERTIFICATION: ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('CERTIFICATION SCRIPT CRASHED:', e);
  process.exit(2);
});
