// Mandatory Country Confirmation, round-2 closure (item 3) — full direct-
// write inventory across EVERY table discoverable from the current
// migration head (0001-0104), not just the 8 named in the Product Owner's
// list. For each public-schema table with row-level security enabled,
// determines whether `authenticated` (i.e. an ordinary signed-in browser/
// API client under RLS, as opposed to only `service_role`) has any
// INSERT-capable policy — for="ALL" or for="INSERT" — naming `authenticated`
// or `public` in its roles. Only tables with such a policy are candidates
// for the enforce_country_confirmed() backstop; everything else is either
// read-only for end users, service-role-only, or has RLS enabled with no
// policy granting authenticated write access at all (structurally already
// safe against the exact bypass this task's DB backstop exists for).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
  await db.exec(sql);
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log('Replay complete.\n');

// Every public-schema base table, with its RLS flag.
const { rows: tables } = await db.query(`
  select c.relname as table, c.relrowsecurity as rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by 1
`);

// Every policy, with its command and role list.
const { rows: policies } = await db.query(`
  select tablename as table, policyname as name, cmd, roles::text as roles, qual, with_check
  from pg_policies
  where schemaname = 'public'
  order by 1, 2
`);

// Existing INSERT-blocking triggers already applied (round 1's 8 tables).
const { rows: triggers } = await db.query(`
  select c.relname as table, t.tgname as name
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal and t.tgname = 'trg_enforce_country_confirmed'
`);
const alreadyBackstopped = new Set(triggers.map((t) => t.table));

function policyAllowsAuthenticatedWrite(p) {
  if (!['ALL', 'INSERT'].includes(p.cmd)) return false;
  const roles = p.roles.replace(/[{}]/g, '').split(',').map((r) => r.trim());
  return roles.includes('authenticated') || roles.includes('public');
}

const results = [];
for (const t of tables) {
  const tablePolicies = policies.filter((p) => p.table === t.table);
  const writePolicies = tablePolicies.filter(policyAllowsAuthenticatedWrite);
  const hasAuthenticatedWrite = t.rls && writePolicies.length > 0;
  results.push({
    table: t.table,
    rls: t.rls,
    authenticatedWritePolicyCount: writePolicies.length,
    authenticatedCanInsertDirectly: hasAuthenticatedWrite,
    alreadyBackstopped: alreadyBackstopped.has(t.table),
  });
}

const needsReview = results.filter((r) => r.authenticatedCanInsertDirectly && !r.alreadyBackstopped);
const noRls = results.filter((r) => !r.rls);
const rlsNoAuthWrite = results.filter((r) => r.rls && r.authenticatedWritePolicyCount === 0);

console.log(`Total public-schema tables: ${results.length}`);
console.log(`Already backstopped (round 1, the 8 named tables): ${results.filter((r) => r.alreadyBackstopped).length}`);
console.log(`RLS enabled, NO authenticated-write policy at all (safe by construction — nothing to backstop): ${rlsNoAuthWrite.length}`);
console.log(`RLS NOT enabled at all (reference/lookup tables, world-readable, never end-user-writable): ${noRls.length}`);
console.log(`\n=== Tables where an authenticated end-user CAN insert directly under RLS, and are NOT yet backstopped ===`);
for (const r of needsReview) {
  console.log(`  ${r.table}  (${r.authenticatedWritePolicyCount} write polic${r.authenticatedWritePolicyCount === 1 ? 'y' : 'ies'})`);
}
console.log(`\nCount needing a decision: ${needsReview.length}`);

fs.writeFileSync(
  path.join(HERE, 'mcc_full_table_inventory.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), results, needsReview: needsReview.map((r) => r.table) }, null, 2)
);
console.log('\nFull machine-readable inventory written to scripts/mcc_full_table_inventory.json');
