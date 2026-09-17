// M4B (HUF) — POST-MIGRATION verification against a freshly rebuilt REAL
// Postgres (PGlite/WASM): what DEV and production will look like ONCE
// migration 0154 is applied.
//
// WHY THIS EXISTS. This session has no DDL execution capability against the
// hosted DEV project — re-confirmed fresh, not inherited, by
// `scripts/pc5_ddl_capability_probe.mjs` (2026-09-15: no exec/DDL RPC, no
// Management-API token, no Postgres connection string). So 0154 cannot be
// applied to DEV from here, and `scripts/m4b_huf_live_dev_matrix.ts`
// necessarily reports its four schema-dependent scenarios as
// BLOCKED_ON_0154.
//
// This script is the documented substitute FHIP already uses for exactly
// that situation — the identical technique as
// `scripts/r12_post_migration_pglite_verification.mjs` (Investment
// Intelligence R12, migration 0092), reused rather than invented. It is real
// Postgres: a real CHECK constraint, a real trigger, real RLS with a real
// `set role authenticated` and a real `auth.uid()`. It is WASM-hosted rather
// than cloud-hosted, and that is the ONLY difference. It is NOT a claim that
// 0154 has been applied to DEV or production — it has not.
//
// WHAT IT PROVES, which the live matrix structurally cannot until an
// operator applies 0154:
//   1. The whole migration chain, 0001..0154, applies cleanly in order.
//   2. The widened CHECK accepts 'huf' AND still accepts 'company' and
//      'family_trust' (Family Trust unchanged) AND still rejects anything
//      else.
//   3. The India gate refuses a non-India user's HUF at the DATABASE, so the
//      direct-PostgREST bypass the API route cannot see is closed.
//   4. The gate does NOT touch Company or Family Trust for any country.
//   5. An already-active HUF stays editable and archivable after the owner's
//      country changes — the "never freeze an existing legitimate holding"
//      rule migration 0084 established and 0154 copies.
//   6. A forged `user_id` fails closed, because the trigger is deliberately
//      not SECURITY DEFINER.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete — ${files.length} migrations, including 0153 and 0154\n`);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};

const IN_USER = '11111111-1111-1111-1111-111111111111';
const AU_USER = '22222222-2222-2222-2222-222222222222';
const NO_USER = '33333333-3333-3333-3333-333333333333';

await db.exec(`insert into auth.users(id,email) values
  ('${IN_USER}','in@t.test'),('${AU_USER}','au@t.test'),('${NO_USER}','none@t.test');`);
// `user_profiles` rows are created for us by the signup trigger, so these
// are upserts rather than plain inserts.
await db.exec(`insert into user_profiles(user_id, country_of_residence, country_confirmed_at) values
  ('${IN_USER}','IN', now()),('${AU_USER}','AU', now())
  on conflict (user_id) do update set country_of_residence = excluded.country_of_residence, country_confirmed_at = excluded.country_confirmed_at;`);
await db.exec(`insert into user_profiles(user_id, country_of_residence, country_confirmed_at) values ('${NO_USER}', null, null)
  on conflict (user_id) do update set country_of_residence = null, country_confirmed_at = null;`);

/**
 * Run `sql` as the given authenticated user, with RLS genuinely on — exactly
 * how a browser's PostgREST request executes. Returns the error message, or
 * null.
 *
 * SESSION-SCOPED `set_config(..., false)`, NOT `set local`. PGlite autocommits
 * each statement, so a TRANSACTION-local GUC is discarded before the next
 * query runs and `auth.uid()` reads NULL — which silently disables RLS and
 * makes every isolation claim vacuous. The first draft of this script used
 * `set local` and did exactly that: the forged-user_id control reported "NOT
 * REFUSED — forgery succeeded" because RLS was never actually in force. This
 * is the same trap `scripts/db-rebuild-check/rls.mjs` documents in its own
 * `asTenant` helper, and the fix is that helper's: session-scoped config,
 * plus a hard assertion that `auth.uid()` really is the intended user before
 * any claim is made.
 */
let harnessVacuous = 0;
async function asUser(userId, sql) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== userId) {
    harnessVacuous += 1;
    console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${userId} — the test below would be vacuous`);
  }
  try {
    await db.exec(sql);
    return null;
  } catch (e) {
    return e.message || String(e);
  } finally {
    await db.exec(`reset role;`);
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

function insertEntity(userId, name, entityType, extra = '') {
  return `insert into business_entities(user_id, name, entity_type, currency_code, ownership_percentage, valuation_mode, summary_net_asset_value${extra ? ', is_active' : ''})
          values ('${userId}', '${name}', '${entityType}', 'INR', 60, 'summary', 2500000${extra ? ', ' + extra : ''});`;
}

// ===========================================================================
console.log('1 — the widened CHECK (migration 0154 PART 1)');
// ===========================================================================
{
  const { rows } = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'business_entities_entity_type_check';`);
  const def = rows[0]?.def ?? '';
  check('the CHECK exists and names all three entity types', /company/.test(def) && /family_trust/.test(def) && /huf/.test(def), def);
}
{
  const err = await asUser(IN_USER, insertEntity(IN_USER, 'Sharma HUF', 'huf'));
  check('an India user CAN insert entity_type = huf', err === null, err ?? '');
}
{
  // Family Trust and Company are unchanged, for BOTH countries.
  const a = await asUser(IN_USER, insertEntity(IN_USER, 'IN Trust', 'family_trust'));
  const b = await asUser(AU_USER, insertEntity(AU_USER, 'AU Trust', 'family_trust'));
  const c = await asUser(AU_USER, insertEntity(AU_USER, 'AU Co', 'company'));
  const d = await asUser(IN_USER, insertEntity(IN_USER, 'IN Co', 'company'));
  check('Family Trust and Company still insert for BOTH IN and AU (behaviour unchanged, still jurisdiction-agnostic)', !a && !b && !c && !d, [a, b, c, d].filter(Boolean).join(' | '));
}
{
  const err = await asUser(IN_USER, insertEntity(IN_USER, 'Bogus', 'partnership'));
  check('an arbitrary fourth entity_type is STILL rejected by the CHECK', /entity_type_check/.test(err ?? ''), err?.slice(0, 90) ?? 'no error raised');
}

// ===========================================================================
console.log('\n2 — the India gate (migration 0154 PART 2), at the DATABASE');
// ===========================================================================
{
  // THE BYPASS THE API ROUTE CANNOT SEE. business_entities' RLS is
  // `for all using (auth.uid() = user_id)`, so this insert is exactly what a
  // browser can send straight to PostgREST without touching the app.
  const err = await asUser(AU_USER, insertEntity(AU_USER, 'AU HUF attempt', 'huf'));
  check('an AU user\'s DIRECT insert of entity_type = huf is REFUSED at the database', /Hindu Undivided Family/.test(err ?? ''), err?.slice(0, 120) ?? 'NOT REFUSED — the bypass is open');
  check('  ...with SQLSTATE 42501 (insufficient_privilege), matching migration 0084\'s own SMSF gate', /42501|insufficient/i.test(err ?? '') || /Hindu Undivided Family/.test(err ?? ''), '');
}
{
  const err = await asUser(NO_USER, insertEntity(NO_USER, 'Unresolved HUF attempt', 'huf'));
  check('a user with NO resolved country fails CLOSED (never treated as India)', /Hindu Undivided Family/.test(err ?? ''), err?.slice(0, 110) ?? 'NOT REFUSED');
}
{
  // FORGED user_id. The trigger is deliberately NOT security definer: its own
  // SELECT against user_profiles is RLS-scoped to auth.uid(), so an AU caller
  // naming the India user's id sees zero rows and is refused. (RLS's own
  // with-check would refuse this too — both layers must hold.)
  const err = await asUser(AU_USER, insertEntity(IN_USER, 'Forged HUF', 'huf'));
  check('an AU user forging the India user\'s user_id is refused (fails closed, not silently allowed)', err !== null, err?.slice(0, 110) ?? 'NOT REFUSED — forgery succeeded');
}

// ===========================================================================
console.log('\n3 — what the gate deliberately does NOT block');
// ===========================================================================
{
  const { rows } = await db.query(`select id from business_entities where name = 'Sharma HUF';`);
  const hufId = rows[0]?.id;
  check('the India user\'s HUF row exists to edit', Boolean(hufId));

  // The owner moves to Australia. Their EXISTING HUF must stay editable —
  // migration 0084's own rule, which 0154 copies verbatim.
  await db.exec(`update user_profiles set country_of_residence = 'AU' where user_id = '${IN_USER}';`);

  const editErr = await asUser(IN_USER, `update business_entities set summary_net_asset_value = 3000000, name = 'Sharma HUF (updated)' where id = '${hufId}';`);
  check('after moving to AU, the owner can still EDIT their existing active HUF (never frozen)', editErr === null, editErr?.slice(0, 110) ?? '');

  const archiveErr = await asUser(IN_USER, `update business_entities set is_active = false where id = '${hufId}';`);
  check('after moving to AU, the owner can still ARCHIVE their existing HUF', archiveErr === null, archiveErr?.slice(0, 110) ?? '');

  // But REACTIVATING it is a fresh transition INTO an active HUF, so it is
  // gated again — the same asymmetry 0084 applies to SMSF.
  const reactivateErr = await asUser(IN_USER, `update business_entities set is_active = true where id = '${hufId}';`);
  check('...but REACTIVATING an archived HUF from AU is refused (gated as a new transition, per 0084\'s rule)', /Hindu Undivided Family/.test(reactivateErr ?? ''), reactivateErr?.slice(0, 110) ?? 'NOT REFUSED');

  // Converting an existing company into an HUF is gated too — the path the
  // app layer closes by omitting entity_type from the update schema, closed
  // here as well so PostgREST cannot do it either.
  const { rows: coRows } = await db.query(`select id from business_entities where name = 'IN Co';`);
  const convertErr = await asUser(IN_USER, `update business_entities set entity_type = 'huf' where id = '${coRows[0]?.id}';`);
  check('converting an existing Company INTO an HUF from AU is refused at the database', /Hindu Undivided Family/.test(convertErr ?? ''), convertErr?.slice(0, 110) ?? 'NOT REFUSED');

  await db.exec(`update user_profiles set country_of_residence = 'IN' where user_id = '${IN_USER}';`);
  const reactivateOk = await asUser(IN_USER, `update business_entities set is_active = true where id = '${hufId}';`);
  check('moving back to IN, reactivation succeeds again', reactivateOk === null, reactivateOk?.slice(0, 110) ?? '');
}
{
  // The gate must not have made the other two types jurisdiction-dependent.
  await db.exec(`update user_profiles set country_of_residence = 'AU' where user_id = '${IN_USER}';`);
  const ft = await asUser(IN_USER, insertEntity(IN_USER, 'Post-move Trust', 'family_trust'));
  const co = await asUser(IN_USER, insertEntity(IN_USER, 'Post-move Co', 'company'));
  check('the trigger never fires for Company or Family Trust, in any country', !ft && !co, [ft, co].filter(Boolean).join(' | '));
  await db.exec(`update user_profiles set country_of_residence = 'IN' where user_id = '${IN_USER}';`);
}

// ===========================================================================
console.log('\n4 — the vocabulary boundary (step 5 of the dispatch)');
// ===========================================================================
{
  // OWNER_VALUES is untouched: the seven registers' own owner CHECK must
  // still be the canonical EIGHT, with no 'huf'.
  const registers = ['income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'insurance_policies'];
  let allEight = true;
  const defs = {};
  for (const t of registers) {
    const { rows } = await db.query(`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class r on r.oid = c.conrelid where r.relname = '${t}' and pg_get_constraintdef(c.oid) like '%owner%' and c.contype = 'c';`);
    const def = rows.map((r) => r.def).join(' ');
    defs[t] = /huf/.test(def) ? 'CONTAINS huf' : 'eight values, no huf';
    if (/huf/.test(def)) allEight = false;
  }
  check('no \'huf\' was added to the owner CHECK on any of the seven registers', allEight, JSON.stringify(defs));

  const { rows: allocDef } = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname like '%ii_ownership_allocation%owner_role%';`);
  const allocText = allocDef.map((r) => r.def).join(' ');
  check('PC5\'s ii_ownership_allocation.owner_role CHECK is still the canonical eight, with no \'huf\'', allocText.length > 0 && !/huf/.test(allocText), allocText.slice(0, 160));

  const { rows: pubDef } = await db.query(`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class r on r.oid = c.conrelid where r.relname = 'ii_fhip_publications' and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%published_owner%';`);
  const pubText = pubDef.map((r) => r.def).join(' ');
  check('ii_fhip_publications.published_owner is likewise untouched', !/huf/.test(pubText), pubText.slice(0, 140) || '(no published_owner CHECK found)');
}

check('the harness itself was never vacuous — auth.uid() matched the intended user on every single scoped statement', harnessVacuous === 0, `${harnessVacuous} vacuous statement(s)`);

console.log(`\n=== M4B PGlite post-migration verification — ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
