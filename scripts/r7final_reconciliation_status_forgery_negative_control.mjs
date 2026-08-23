// R7-FINAL — RED->GREEN negative control for the live-DEV-discovered
// reconciliation_status forgery gap (see migration 0065 and the live
// reproduction in scripts/r7final_live_security.mjs, SEC-027).
//
// RED:   migrations 0001-0064 only (the currently-live DEV schema) ->
//        forging reconciliation_status as the owning authenticated user
//        SUCCEEDS (proves the gap is real, not a test artifact).
// GREEN: migration 0065 additionally applied -> the identical forgery
//        attempt is BLOCKED by the widened trigger.
//
// Real PGlite/WASM Postgres, not a mock. Run: node scripts/r7final_reconciliation_status_forgery_negative_control.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

async function buildDb(upToVersion) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const version = parseInt(f.slice(0, 4), 10);
    if (version > upToVersion) continue;
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

async function asRole(db, uid, role, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role })]);
  await db.exec(`set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

async function runScenario(upToVersion, label) {
  const db = await buildDb(upToVersion);
  const A = '11111111-1111-1111-1111-111111111111';
  await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test');`);
  const inst = (await db.query(`select id from fdh_financial_institutions where institution_code='cba' and country_code='AU'`)).rows[0].id;

  const acct = (await asRole(db, A, 'service_role', () =>
    db.query(`insert into fdh_financial_accounts (user_id, institution_id, account_type, country_code, currency_code, display_name)
      values ('${A}', '${inst}', 'transaction', 'AU', 'AUD', 'Test') returning id`)
  )).rows[0].id;
  const doc = (await asRole(db, A, 'service_role', () =>
    db.query(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, financial_account_id, reconciliation_status)
      values ('${A}', 'csv', 'bank_statement', 'AU', 'AUD', '${acct}', 'not_available') returning id, reconciliation_status`)
  )).rows[0];

  console.log(`[${label}] seeded doc ${doc.id}, reconciliation_status=${doc.reconciliation_status}`);

  let forged = false;
  let errorMsg = null;
  try {
    const r = await asRole(db, A, 'authenticated', () =>
      db.query(`update fdh_statement_uploads set reconciliation_status = 'reconciled' where id = '${doc.id}' returning reconciliation_status`)
    );
    forged = r.rows[0]?.reconciliation_status === 'reconciled';
  } catch (e) {
    errorMsg = e.message;
  }

  const groundTruth = (await db.query(`select reconciliation_status from fdh_statement_uploads where id = '${doc.id}'`)).rows[0].reconciliation_status;
  console.log(`[${label}] forgery attempt: ${forged ? 'SUCCEEDED' : 'BLOCKED'} (${errorMsg ?? 'no error'}); ground truth after = ${groundTruth}`);
  await db.close?.();
  return { forged, groundTruth };
}

async function main() {
  const red = await runScenario(64, 'RED (migrations up to 0064 only, matches live DEV today)');
  const green = await runScenario(65, 'GREEN (migrations up to 0065, the proposed fix)');

  console.log('\n=== RESULT ===');
  const redOk = red.forged === true && red.groundTruth === 'reconciled';
  const greenOk = green.forged === false && green.groundTruth === 'not_available';
  console.log(`RED (gap reproduced, as on live DEV today): ${redOk ? 'CONFIRMED' : 'NOT REPRODUCED — unexpected'}`);
  console.log(`GREEN (0065 closes it): ${greenOk ? 'CONFIRMED' : 'NOT FIXED — unexpected'}`);
  process.exit(redOk && greenOk ? 0 : 1);
}
main();
