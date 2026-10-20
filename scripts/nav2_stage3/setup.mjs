// Journey setup / teardown of the DEV fixture-user state (reversible; the original rows are saved to the ledger first).
//   node scripts/nav2_stage3/setup.mjs apply      confirm country IN, Premium for holder/other/spare/admin (free stays free)
//   node scripts/nav2_stage3/setup.mjs revert     put every touched row back to its saved original
import fs from 'node:fs';
import path from 'node:path';
import { db, OUT, USERS, userIdOf } from './_lib.mjs';

const ledgerFile = path.join(OUT, 'setup_ledger.json');
const mode = process.argv[2];
const premium = ['holder', 'other', 'spare', 'admin'];

if (mode === 'apply') {
  if (fs.existsSync(ledgerFile)) throw new Error('a ledger already exists: revert first');
  const ledger = { at: new Date().toISOString(), users: {} };
  for (const [k, email] of Object.entries(USERS)) {
    const id = await userIdOf(email);
    const prof = (await db.from('user_profiles').select('*').eq('user_id', id).maybeSingle()).data;
    const ent = (await db.from('user_entitlements').select('*').eq('user_id', id).maybeSingle()).data;
    ledger.users[k] = { id, email, prof, ent };
  }
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  for (const [k, u] of Object.entries(ledger.users)) {
    if (!u.prof) throw new Error(`no user_profiles row for ${k}`);
    const r = await db.from('user_profiles').update({ country_of_residence: 'IN', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED' }).eq('user_id', u.id);
    if (r.error) throw new Error(`profile update failed for ${k}: ${r.error.message}`);
    if (premium.includes(k)) {
      const e = await db.from('user_entitlements').update({ plan_tier: 'premium', effective_from: '2026-10-01', effective_to: '2026-11-30' }).eq('user_id', u.id);
      if (e.error) throw new Error(`entitlement update failed for ${k}: ${e.error.message}`);
    }
    console.log(k, u.id.slice(0, 8), 'confirmed IN', premium.includes(k) ? '+ premium' : '(free)');
  }
} else if (mode === 'revert') {
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  for (const [k, u] of Object.entries(ledger.users)) {
    const p = u.prof;
    await db.from('user_profiles').update({ country_of_residence: p.country_of_residence, country_confirmed_at: p.country_confirmed_at, country_source: p.country_source }).eq('user_id', u.id);
    await db.from('user_entitlements').update({ plan_tier: u.ent.plan_tier, effective_from: u.ent.effective_from, effective_to: u.ent.effective_to }).eq('user_id', u.id);
    console.log(k, 'reverted');
  }
  fs.renameSync(ledgerFile, ledgerFile.replace('.json', '.reverted.json'));
} else {
  console.log('usage: setup.mjs apply|revert');
}
