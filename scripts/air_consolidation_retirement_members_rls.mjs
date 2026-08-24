import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = 'D:/FHIP/.claude/worktrees/agent-aea78414a1d0421f7/supabase';
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync('D:/FHIP/.claude/worktrees/agent-aea78414a1d0421f7/scripts/db-rebuild-check/shim.sql', 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
for (const f of fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);
await db.exec(`insert into retirement_members (user_id, member_type, target_retirement_age) values ('${A}','self',60),('${B}','self',65);`);

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('PASS', label); } else { fail++; console.log('FAIL', label); } };

await asTenant(A, async () => {
  const own = (await db.query(`select count(*)::int c from retirement_members`)).rows[0].c;
  check('Tenant A sees only own retirement_members row', own === 1);
  const leak = (await db.query(`select count(*)::int c from retirement_members where user_id='${B}'`)).rows[0].c;
  check('Tenant A cannot read Tenant B retirement_members', leak === 0);
  let forged = false;
  try {
    await db.query(`insert into retirement_members (user_id, member_type, target_retirement_age) values ('${B}','spouse',50)`);
    forged = true;
  } catch { forged = false; }
  check('Tenant A cannot forge a retirement_members row for Tenant B', !forged);
  const upd = await db.query(`update retirement_members set target_retirement_age=99 where user_id='${B}'`);
  check('Tenant A cannot update Tenant B retirement_members', (upd.rows ?? []).length === 0);
});

// Negative control: prove the RLS test itself isn't vacuous.
await db.exec(`alter table retirement_members disable row level security;`);
await asTenant(A, async () => {
  const leak = (await db.query(`select count(*)::int c from retirement_members where user_id='${B}'`)).rows[0].c;
  check('control: RLS off -> Tenant A DOES see Tenant B retirement_members (proves test not vacuous)', leak === 1);
});
await db.exec(`alter table retirement_members enable row level security;`);
await asTenant(A, async () => {
  const leak = (await db.query(`select count(*)::int c from retirement_members where user_id='${B}'`)).rows[0].c;
  check('control: isolation restored', leak === 0);
});

console.log(`retirement_members RLS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
