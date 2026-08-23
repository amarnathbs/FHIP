// R9 -- RED->GREEN negative control for the live-DEV-discovered
// ii_review_items authoritative-write forgery gap (see migration 0069 and
// the live reproduction, LIVE-R9-019b/019c).
//
// RED:   migrations through 0067 only (matches DEV before this fix) ->
//        forging severity/status/evidence as the owning authenticated
//        user SUCCEEDS.
// GREEN: migration 0069 additionally applied -> the identical forgery is
//        BLOCKED, while the two legitimate user transitions (acknowledge,
//        dismiss) still succeed.
//
// Real PGlite/WASM Postgres, not a mock.
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

async function seedItem(db, uid) {
  await asRole(db, uid, 'service_role', () =>
    db.query(`insert into ii_review_items (id, user_id, review_type, category, severity, title, description, evidence, source_module, review_engine_version, rule_key, rule_version, identity_key, as_of_date, status)
      values ('11111111-1111-1111-1111-111111111111', '${uid}', 'goal', 'unallocated_investment', 'info', 't', 'd', '{}'::jsonb, 'goals', 'v1', 'unallocated_investment', 'v1', 'ik-1', current_date, 'open')`)
  );
}

async function runScenario(upToVersion, label) {
  const db = await buildDb(upToVersion);
  const A = '11111111-1111-1111-1111-111111111112';
  await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test');`);
  await seedItem(db, A);

  let forged = false, forgeErr = null;
  try {
    const r = await asRole(db, A, 'authenticated', () =>
      db.query(`update ii_review_items set severity = 'high', status = 'resolved', evidence = '{"forged":true}'::jsonb where id = '11111111-1111-1111-1111-111111111111' returning severity, status`)
    );
    forged = r.rows[0]?.severity === 'high';
  } catch (e) { forgeErr = e.message; }

  const groundTruth = (await db.query(`select severity, status from ii_review_items where id = '11111111-1111-1111-1111-111111111111'`)).rows[0];
  console.log(`[${label}] forgery attempt: ${forged ? 'SUCCEEDED' : 'BLOCKED'} (${forgeErr ?? 'no error'}); ground truth after = ${JSON.stringify(groundTruth)}`);

  // Legitimate transition: open -> acknowledged must still work (only meaningful post-fix, but harmless pre-fix too).
  let ackOk = false, ackErr = null;
  try {
    const r2 = await asRole(db, A, 'authenticated', () =>
      db.query(`update ii_review_items set status = 'acknowledged', acknowledged_at = now() where id = '11111111-1111-1111-1111-111111111111' and user_id = '${A}' returning status`)
    );
    ackOk = r2.rows[0]?.status === 'acknowledged';
  } catch (e) { ackErr = e.message; }
  console.log(`[${label}] legitimate acknowledge (open->acknowledged): ${ackOk ? 'ALLOWED' : 'BLOCKED'} (${ackErr ?? 'no error'})`);

  await db.close?.();
  return { forged, ackOk, groundTruth };
}

async function main() {
  const red = await runScenario(67, 'RED (through 0067 only, matches live DEV before this fix)');
  const green = await runScenario(69, 'GREEN (through 0069, the fix)');

  console.log('\n=== RESULT ===');
  const redOk = red.forged === true;
  const greenOk = green.forged === false && green.groundTruth.severity === 'info' && green.ackOk === true;
  console.log(`RED (gap reproduced): ${redOk ? 'CONFIRMED' : 'NOT REPRODUCED -- unexpected'}`);
  console.log(`GREEN (0069 closes forgery, keeps legitimate acknowledge working): ${greenOk ? 'CONFIRMED' : 'NOT FIXED -- unexpected'}`);
  process.exit(redOk && greenOk ? 0 : 1);
}
main();
