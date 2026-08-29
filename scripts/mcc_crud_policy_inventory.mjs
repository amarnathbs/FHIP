// Mandatory Country Confirmation, round 3 closure — Gap 2: full CRUD
// (SELECT/INSERT/UPDATE/DELETE) inventory, not INSERT-only. For every table
// this feature has ever considered (the 8 originally-named + 91 reviewed in
// round 2 + any new table added by a merged branch since), reports exactly
// which operations `authenticated`/`public` have ANY policy-granted access
// to, so the trigger extension in migration 0107 is based on real discovery,
// not assumption.
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

const { rows: tables } = await db.query(`
  select c.relname as table, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by 1
`);
const { rows: policies } = await db.query(`
  select tablename as table, policyname as name, cmd, roles::text as roles
  from pg_policies where schemaname = 'public' order by 1, 2
`);

function rolesOf(p) {
  return p.roles.replace(/[{}]/g, '').split(',').map((r) => r.trim());
}
function grantsTo(p, op) {
  if (p.cmd !== 'ALL' && p.cmd !== op) return false;
  const roles = rolesOf(p);
  return roles.includes('authenticated') || roles.includes('public');
}

const report = [];
for (const t of tables) {
  const tablePolicies = policies.filter((p) => p.table === t.table);
  const ops = { SELECT: false, INSERT: false, UPDATE: false, DELETE: false };
  for (const op of Object.keys(ops)) {
    ops[op] = t.rls && tablePolicies.some((p) => grantsTo(p, op));
  }
  report.push({ table: t.table, rls: t.rls, ...ops });
}

fs.writeFileSync(path.join(HERE, 'mcc_crud_policy_inventory.json'), JSON.stringify(report, null, 2));

const anyWrite = report.filter((r) => r.INSERT || r.UPDATE || r.DELETE);
console.log(`Total tables: ${report.length}`);
console.log(`Tables with ANY authenticated write policy (INSERT/UPDATE/DELETE): ${anyWrite.length}\n`);
for (const r of anyWrite) {
  console.log(`${r.table.padEnd(45)} SELECT=${r.SELECT ? 'Y' : 'n'}  INSERT=${r.INSERT ? 'Y' : 'n'}  UPDATE=${r.UPDATE ? 'Y' : 'n'}  DELETE=${r.DELETE ? 'Y' : 'n'}`);
}
console.log('\nWritten to scripts/mcc_crud_policy_inventory.json');
