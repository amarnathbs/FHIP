// DEV only. Puts the five fixture users back as they were before the Stage 3 journeys (NOT the PO seed, which this never touches):
// derived data (reset_user.mjs), the business entities, the manual investment and the household members the journeys created, then the profile and plan rows.
//   node scripts/nav2_stage3/cleanup_fixtures.mjs [--dry]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { db, HERE, USERS, userIdOf } from './_lib.mjs';
const dry = process.argv.includes('--dry');
const SINCE = '2026-10-05T00:00:00Z';
for (const k of Object.keys(USERS)) {
  const id = await userIdOf(USERS[k]);
  console.log(`--- ${k} ${USERS[k]}`);
  execFileSync(process.execPath, [path.join(HERE, 'reset_user.mjs'), k, ...(dry ? ['--dry'] : [])], { stdio: 'inherit' });
  const ents = (await db.from('business_entities').select('id, name, created_at').eq('user_id', id).gte('created_at', SINCE)).data ?? [];
  const man = (await db.from('investments').select('id, investment_name, created_at').eq('user_id', id).gte('created_at', SINCE)).data ?? [];
  const mem = (await db.from('household_members').select('id, full_name, relationship, created_at').eq('user_id', id).gte('created_at', SINCE)).data ?? [];
  console.log(`  created by the journeys: ${ents.length} entities, ${man.length} investments, ${mem.length} members`);
  if (dry) continue;
  if (man.length) { await db.from('goal_funding_sources').delete().in('investment_id', man.map((x) => x.id)).then(() => {}, () => {}); const r = await db.from('investments').delete().in('id', man.map((x) => x.id)); if (r.error) console.log('  investments:', r.error.message); }
  if (ents.length) { const r = await db.from('business_entities').delete().in('id', ents.map((x) => x.id)); if (r.error) console.log('  entities:', r.error.message); }
  if (mem.length) { const r = await db.from('household_members').delete().in('id', mem.map((x) => x.id)); if (r.error) console.log('  members:', r.error.message); }
}
if (!dry) execFileSync(process.execPath, [path.join(HERE, 'setup.mjs'), 'revert'], { stdio: 'inherit' });
