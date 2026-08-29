// RLS certification against the freshly rebuilt database, using REAL populated
// tenant data (never empty-table assertions) plus negative controls that prove
// each test can actually fail.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', e => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', e => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
for (const f of fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('fresh rebuild complete\n');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);
// Mandatory Country Confirmation (migrations 0104/0105/0107) — this script's
// own "REAL populated tenant data" seed below inserts into ii_accounts and
// user_financial_section_status, both now backstopped by
// enforce_country_confirmed(); a bare country_of_residence is never itself
// proof of confirmation, so both fixtures need the full confirmation state.
await db.exec(`
  update user_profiles set country_of_residence='AU', preferred_currency='AUD', onboarding_completed=true, country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${A}';
  update user_profiles set country_of_residence='IN', preferred_currency='INR', onboarding_completed=true, country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${B}';
`);

// --- Seed REAL data for both tenants into representative II tables ---
// One user-scoped table from each of the three affected lineages:
//   ii_accounts                    -> Investment Intelligence (active 0031-0044)
//   user_financial_section_status  -> Phase 0C (re-emitted by 0049)
//   resource_user_roles            -> Resources (re-emitted by 0049)
await db.exec(`
insert into ii_accounts (user_id, country_code, currency_code, account_type, institution_name)
  values ('${A}','AU','AUD','broker','Tenant A Broker'),
         ('${B}','IN','INR','mf_folio','Tenant B AMC');
insert into user_financial_section_status (user_id, section, status)
  values ('${A}','liabilities','reviewed_zero'), ('${B}','insurance','not_applicable');
insert into resource_user_roles (user_id, role)
  values ('${A}','author'), ('${B}','editor');
`);
const n = async (s) => (await db.query(s)).rows[0].c;
const TABLES = [['ii_accounts', 'Investment Intelligence'], ['user_financial_section_status', 'Phase 0C'], ['resource_user_roles', 'Resources']];
for (const [t, m] of TABLES) console.log(`  seeded ${t} (${m}): ${await n(`select count(*)::int c from ${t}`)} rows (1 per tenant)`);

async function asTenant(uid, fn) {
  // Session-scoped (is_local=false): PGlite autocommits each statement, so a
  // transaction-local GUC would be discarded before the next query and
  // auth.uid() would read NULL — which would make every cross-tenant test
  // pass vacuously. Asserted below before any isolation claim is made.
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

console.log('\n=== POSITIVE ACCESS (tenant sees its own populated rows) ===');
for (const [uid, who] of [[A, 'Tenant A'], [B, 'Tenant B']]) {
  await asTenant(uid, async () => {
    for (const [t, m] of TABLES) {
      const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
      check(`${who} reads own ${t} [${m}]`, c === 1, `(saw ${c}, expected 1)`);
    }
  });
}

console.log('\n=== CROSS-TENANT READ DENIAL (must never see the other tenant) ===');
await asTenant(A, async () => {
  for (const [t, m] of TABLES) {
    const leak = (await db.query(`select count(*)::int c from ${t} where user_id='${B}'`)).rows[0].c;
    check(`Tenant A cannot read Tenant B ${t} [${m}]`, leak === 0, `(leaked ${leak})`);
  }
});

console.log('\n=== CROSS-TENANT WRITE DENIAL ===');
const FORGE = {
  ii_accounts: `insert into ii_accounts (user_id,country_code,currency_code,account_type,institution_name) values ('${B}','AU','AUD','broker','forged')`,
  user_financial_section_status: `insert into user_financial_section_status (user_id,section,status) values ('${B}','income','reviewed_zero')`,
  resource_user_roles: `insert into resource_user_roles (user_id,role) values ('${B}','resource_admin')`,
};
await asTenant(A, async () => {
  for (const [t, m] of TABLES) {
    let blocked = false;
    try { await db.query(FORGE[t]); } catch (e) { blocked = /policy|denied/i.test(e.message); }
    check(`Tenant A cannot forge a ${t} row owned by Tenant B [${m}]`, blocked);
    const upd = (await db.query(`update ${t} set updated_at=now() where user_id='${B}' returning 1`)).rows.length;
    check(`Tenant A cannot update Tenant B ${t}`, upd === 0, `(updated ${upd})`);
    const del = (await db.query(`delete from ${t} where user_id='${B}' returning 1`)).rows.length;
    check(`Tenant A cannot delete Tenant B ${t}`, del === 0, `(deleted ${del})`);
  }
});

console.log('\n=== NEGATIVE CONTROLS (isolation deliberately removed -> leak MUST appear) ===');
for (const [t, m] of TABLES) {
  await db.exec(`alter table ${t} disable row level security;`);
  let leak = 0;
  await asTenant(A, async () => { leak = (await db.query(`select count(*)::int c from ${t} where user_id='${B}'`)).rows[0].c; });
  check(`control: RLS off on ${t} -> Tenant A DOES see Tenant B [${m}]`, leak === 1, `(saw ${leak}, expected 1 — proves the test is not vacuous)`);
  await db.exec(`alter table ${t} enable row level security;`);
  let re = 0;
  await asTenant(A, async () => { re = (await db.query(`select count(*)::int c from ${t} where user_id='${B}'`)).rows[0].c; });
  check(`control: isolation restored on ${t}`, re === 0, `(saw ${re})`);
}

console.log('\n=== RLS COVERAGE ===');
const noRls = (await db.query(`select c.relname from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
  where nsp.nspname='public' and c.relkind='r' and not c.relrowsecurity order by 1`)).rows;
check('every public table has RLS enabled', noRls.length === 0, `(${noRls.length} without RLS${noRls.length ? ': ' + noRls.map(r => r.relname).join(', ') : ''})`);
const total = (await db.query(`select count(*)::int c from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace where nsp.nspname='public' and c.relkind='r'`)).rows[0].c;
console.log(`  (${total} public tables, all RLS-enabled)`);

console.log(`\nRLS CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
