// A0.2 Wave 1 certification — D-01 (Recommendations conditions-CSV import
// integrity). Real PostgreSQL 18 via PGlite (WASM), full migration chain
// 0001..0107 replayed from empty, same harness convention as
// scripts/db-rebuild-check/replay.mjs. No shared DEV/production database is
// touched by this script.
//
// Proves, in order:
//   1. REGRESSION PROOF — the exact original defect (two independent
//      DELETE-then-INSERT statements, no shared transaction) genuinely
//      loses existing conditions when the INSERT fails. RED.
//   2. The new admin_import_recommendation_conditions() RPC (migration
//      0107), given the identical failing scenario, leaves the original
//      conditions completely unchanged. GREEN.
//   3. Successful imports: one code, multiple codes, multiple conditions
//      per code, replacement of existing conditions, codes absent from the
//      payload left untouched, explicit clear=true, repeated import is
//      idempotent, returned counts match the database.
//   4. Transaction-failure injection at every point named in the spec:
//      before any deletion (unknown code), after deletion but during
//      insertion for the SAME code (a genuine NOT NULL violation), and on a
//      LATER code after an EARLIER code in the same call would otherwise
//      have already succeeded (proving whole-call atomicity, not
//      per-code).
//   5. Security: EXECUTE is revoked from public/anon/authenticated and
//      granted only to service_role.
//
// Usage: node scripts/admin_a02_wave1_certification.mjs
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
  console.log(`Replayed ${files.length} migrations clean.\n`);
  return db;
}

async function seedMaster(db, code) {
  // is_active=false: this script certifies conditions-CRUD atomicity only,
  // not the active+zero-conditions invariant (that's Wave 1B's own
  // migration 0109, certified separately in
  // scripts/admin_a02_wave1b_certification.mjs). An inactive fixture is
  // exempt from migration 0109's deferred triggers, so seeding a master row
  // and its conditions as two separate statements here (as this script did
  // before Wave 1B existed) still works — an active fixture would correctly
  // be rejected by the new trigger the instant it committed with 0
  // conditions, which is itself proof the new invariant works, not a bug in
  // this script. See Wave 1B's certification for that exact scenario.
  await db.query(
    `insert into action_recommendation_master
       (recommendation_code, forecast_category, sub_category, scenario_name, forecast_status, severity, action_type, action_title_template, action_content_template, is_active)
     values ($1, 'debt', 'overall_variance', 'test scenario', 'on_track', 'medium', 'reduce_debt', 'Test title', 'Test content', false)
     on conflict (recommendation_code) do nothing`,
    [code]
  );
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

async function main() {
  const db = await buildDb();

  // ---------------------------------------------------------------------
  // SECTION 1: Regression proof — reproduce the ORIGINAL defect mechanism
  // ---------------------------------------------------------------------
  console.log('=== SECTION 1: Original defect reproduction (RED) ===');
  {
    const code = 'CERT_RED_01';
    await seedMaster(db, code);
    await seedConditions(db, code, 3);
    const before = await countConditions(db, code);
    check('fixture has 3 pre-existing conditions', before === 3, `got ${before}`);

    // Exact original sequence: DELETE as its own statement/transaction...
    await db.exec(`delete from action_recommendation_conditions where recommendation_code in ('${code}')`);
    const afterDelete = await countConditions(db, code);
    check('old pattern: delete alone already removed the rows', afterDelete === 0, `got ${afterDelete}`);

    // ...then a SEPARATE insert statement that fails (null field_name would
    // violate the NOT NULL constraint — a realistic "replacement insert
    // fails" scenario, e.g. a malformed row that slipped past a weaker
    // validator).
    let insertFailed = false;
    try {
      await db.exec(`insert into action_recommendation_conditions (recommendation_code, condition_group, field_name, operator) values ('${code}', 1, NULL, 'equals')`);
    } catch {
      insertFailed = true;
    }
    check('old pattern: replacement insert genuinely fails', insertFailed);

    const afterFailedInsert = await countConditions(db, code);
    check('DEFECT CONFIRMED: conditions are now permanently ZERO, not rolled back to 3', afterFailedInsert === 0, `got ${afterFailedInsert} (expected 0 to prove the defect)`);
  }

  // ---------------------------------------------------------------------
  // SECTION 2: New RPC — identical failure scenario, proven safe (GREEN)
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 2: Fixed RPC under the identical failure (GREEN) ===');
  {
    const code = 'CERT_GREEN_01';
    await seedMaster(db, code);
    await seedConditions(db, code, 3);
    const before = await countConditions(db, code);
    check('fixture has 3 pre-existing conditions', before === 3, `got ${before}`);

    const payload = {
      groups: [{ recommendation_code: code, clear: false, conditions: [{ field_name: null, operator: 'equals', comparison_value: 'x' }] }],
    };
    let rpcFailed = false;
    try {
      await db.query(`select admin_import_recommendation_conditions($1::jsonb)`, [JSON.stringify(payload)]);
    } catch {
      rpcFailed = true;
    }
    check('RPC call genuinely fails (same underlying NOT NULL violation)', rpcFailed);

    const after = await countConditions(db, code);
    check('FIX CONFIRMED: all 3 original conditions survive untouched', after === 3, `got ${after} (expected 3)`);
  }

  // ---------------------------------------------------------------------
  // SECTION 3: Successful imports
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 3: Successful imports ===');
  {
    // One recommendation, multiple conditions.
    const codeA = 'CERT_OK_A';
    await seedMaster(db, codeA);
    const r1 = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({ groups: [{ recommendation_code: codeA, clear: false, conditions: [
        { field_name: 'forecast_category', operator: 'equals', comparison_value: 'debt', evaluation_order: 1 },
        { field_name: 'forecast_status', operator: 'equals', comparison_value: 'at_risk', evaluation_order: 2 },
      ] }] }),
    ]);
    const out1 = r1.rows[0].r;
    check('single-code import: recommendationsAffected=1', out1.recommendationsAffected === 1, JSON.stringify(out1));
    check('single-code import: conditionsInserted=2', out1.conditionsInserted === 2, JSON.stringify(out1));
    const countA = await countConditions(db, codeA);
    check('single-code import: DB actually has 2 rows', countA === 2, `got ${countA}`);

    // Multiple recommendations in one call, one of which replaces existing.
    const codeB = 'CERT_OK_B';
    const codeC = 'CERT_OK_C_UNCHANGED';
    await seedMaster(db, codeB);
    await seedMaster(db, codeC);
    await seedConditions(db, codeB, 1); // existing condition to be replaced
    await seedConditions(db, codeC, 1); // must remain untouched (absent from this payload)

    const r2 = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({
        groups: [
          { recommendation_code: codeA, clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'net_worth', evaluation_order: 1 }] },
          { recommendation_code: codeB, clear: false, conditions: [
            { field_name: 'forecast_category', operator: 'equals', comparison_value: 'goal', evaluation_order: 1 },
            { field_name: 'forecast_status', operator: 'equals', comparison_value: 'on_track', evaluation_order: 2 },
          ] },
        ],
      }),
    ]);
    const out2 = r2.rows[0].r;
    check('multi-code import: recommendationsAffected=2', out2.recommendationsAffected === 2, JSON.stringify(out2));
    check('multi-code import: conditionsInserted=3 (1 for A, 2 for B)', out2.conditionsInserted === 3, JSON.stringify(out2));
    check('multi-code import: conditionsReplaced=3 (A had 2 from the previous step, B had 1 seeded)', out2.conditionsReplaced === 3, JSON.stringify(out2));

    const countAafter = await countConditions(db, codeA);
    const countBafter = await countConditions(db, codeB);
    const countCafter = await countConditions(db, codeC);
    check('code A now has exactly its 1 replacement condition', countAafter === 1, `got ${countAafter}`);
    check('code B now has exactly its 2 replacement conditions', countBafter === 2, `got ${countBafter}`);
    check('code C (absent from payload) is completely untouched: still 1', countCafter === 1, `got ${countCafter}`);

    // Explicit clear=true.
    const codeD = 'CERT_OK_D_CLEAR';
    await seedMaster(db, codeD);
    await seedConditions(db, codeD, 2);
    const r3 = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({ groups: [{ recommendation_code: codeD, clear: true, conditions: [] }] }),
    ]);
    const out3 = r3.rows[0].r;
    check('explicit clear: recommendationsAffected=1', out3.recommendationsAffected === 1, JSON.stringify(out3));
    check('explicit clear: conditionsInserted=0', out3.conditionsInserted === 0, JSON.stringify(out3));
    check('explicit clear: conditionsReplaced=2', out3.conditionsReplaced === 2, JSON.stringify(out3));
    const countDafter = await countConditions(db, codeD);
    check('code D now has genuinely zero conditions (explicit, not accidental)', countDafter === 0, `got ${countDafter}`);

    // Idempotent repeat: re-running the exact same valid import for A twice
    // produces the same deterministic end state.
    const rRepeat1 = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({ groups: [{ recommendation_code: codeA, clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'resilience', evaluation_order: 1 }] }] }),
    ]);
    const rRepeat2 = await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
      JSON.stringify({ groups: [{ recommendation_code: codeA, clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'resilience', evaluation_order: 1 }] }] }),
    ]);
    check('repeated identical import is deterministic (same output both times)', JSON.stringify(rRepeat1.rows[0].r) === JSON.stringify(rRepeat2.rows[0].r));
    const countAfinal = await countConditions(db, codeA);
    check('repeated identical import: still exactly 1 row, not accumulating', countAfinal === 1, `got ${countAfinal}`);
  }

  // ---------------------------------------------------------------------
  // SECTION 4: Transaction-failure injection
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 4: Transaction-failure injection (every failure must roll back EVERYTHING) ===');
  {
    // (a) Before any deletion: unknown code in the payload aborts before
    // touching the database at all.
    const codeE = 'CERT_TXN_E';
    await seedMaster(db, codeE);
    await seedConditions(db, codeE, 2);
    let failedUnknown = false;
    try {
      await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
        JSON.stringify({ groups: [{ recommendation_code: 'DOES_NOT_EXIST_XYZ', clear: false, conditions: [{ field_name: 'x', operator: 'equals', comparison_value: '1' }] }] }),
      ]);
    } catch {
      failedUnknown = true;
    }
    check('unknown recommendation_code rejected before any mutation', failedUnknown);
    check('unrelated existing code E untouched by the rejected call', (await countConditions(db, codeE)) === 2);

    // (b) On a LATER code, after an EARLIER code in the SAME call would
    // otherwise have already succeeded — proves whole-call atomicity, not
    // per-code commits.
    const codeF = 'CERT_TXN_F_WOULD_SUCCEED';
    const codeG = 'CERT_TXN_G_FAILS';
    await seedMaster(db, codeF);
    await seedMaster(db, codeG);
    await seedConditions(db, codeF, 1);
    await seedConditions(db, codeG, 1);
    let failedLater = false;
    try {
      await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
        JSON.stringify({
          groups: [
            { recommendation_code: codeF, clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'debt', evaluation_order: 1 }] },
            { recommendation_code: codeG, clear: false, conditions: [{ field_name: null, operator: 'equals', comparison_value: 'x' }] }, // fails at insert time
          ],
        }),
      ]);
    } catch {
      failedLater = true;
    }
    check('later-group failure rejects the whole call', failedLater);
    check('EARLIER code F (already deleted+inserted within the same call) rolled back to its original 1 condition', (await countConditions(db, codeF)) === 1, `got ${await countConditions(db, codeF)}`);
    check('code G left with its original 1 condition, not zero', (await countConditions(db, codeG)) === 1, `got ${await countConditions(db, codeG)}`);

    // (c) clear=true + conditions supplied together: structural rejection
    // before any delete for that group.
    const codeH = 'CERT_TXN_H_CONFLICT';
    await seedMaster(db, codeH);
    await seedConditions(db, codeH, 1);
    let failedConflict = false;
    try {
      await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [
        JSON.stringify({ groups: [{ recommendation_code: codeH, clear: true, conditions: [{ field_name: 'x', operator: 'equals', comparison_value: '1' }] }] }),
      ]);
    } catch {
      failedConflict = true;
    }
    check('clear=true + conditions together is rejected', failedConflict);
    check('code H untouched by the rejected conflicting payload', (await countConditions(db, codeH)) === 1);

    // (d) Non-object / non-array payload shape.
    let failedShape = false;
    try {
      await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [JSON.stringify({ groups: 'not-an-array' })]);
    } catch {
      failedShape = true;
    }
    check('malformed payload shape (groups not an array) rejected', failedShape);
  }

  // ---------------------------------------------------------------------
  // SECTION 5: Security — EXECUTE privilege lockdown
  // ---------------------------------------------------------------------
  console.log('\n=== SECTION 5: Security ===');
  {
    const r = await db.query(`
      select grantee, privilege_type
      from information_schema.routine_privileges
      where routine_name = 'admin_import_recommendation_conditions'
    `);
    const grantees = r.rows.map((x) => x.grantee);
    check('EXECUTE NOT granted to public', !grantees.includes('public'), JSON.stringify(grantees));
    check('EXECUTE NOT granted to anon', !grantees.includes('anon'), JSON.stringify(grantees));
    check('EXECUTE NOT granted to authenticated', !grantees.includes('authenticated'), JSON.stringify(grantees));
    check('EXECUTE granted to service_role', grantees.includes('service_role'), JSON.stringify(grantees));

    // Simulate an ordinary authenticated client trying to call the function
    // directly (arbitrary table/column selection is impossible regardless —
    // the function takes no table/column name input at all — but this also
    // proves the role-level lockdown independently of that).
    await db.exec(`set role authenticated`);
    let deniedForAuthenticated = false;
    try {
      await db.query(`select admin_import_recommendation_conditions($1::jsonb) as r`, [JSON.stringify({ groups: [] })]);
    } catch (e) {
      deniedForAuthenticated = /permission denied/i.test(e.message);
    }
    await db.exec(`reset role`);
    check('a direct call as role "authenticated" is permission-denied', deniedForAuthenticated);
  }

  console.log(`\n${'='.repeat(70)}\nA0.2 WAVE 1 CERTIFICATION: ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('CERTIFICATION SCRIPT CRASHED:', e);
  process.exit(2);
});
