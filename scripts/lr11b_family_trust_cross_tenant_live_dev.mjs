// LR-11B (Family Trust, migration 0136) — live-DEV cross-tenant isolation +
// constraint-widening proof. Two disposable users: A (owner, creates a real
// family_trust business_entity as an authenticated user via the anon-key
// client -- exercising the actual widened CHECK constraint end-to-end, not
// just via service-role) and B (attacker, real session, real JWT). B
// attempts to read/list/update/forge-insert against A's entity and its
// child rows. Cleans up both users (and, defensively, the entity itself)
// afterwards. Mirrors scripts/r10_repro_cross_user.mjs's exact method.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function mkUser() {
  const email = `lr11b-xuser-${Date.now()}-${Math.random().toString(36).slice(2)}@fhip-test.invalid`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  return { email, password };
}

let uidA, uidB, entityId, assetId;
const results = [];
const check = (name, expected, actual) => { results.push({ name, expected, actual }); console.log(`[${expected === actual ? 'OK' : '!!'}] ${name} -> ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`); };

try {
  const credsA = mkUser(); const credsB = mkUser();
  const { data: createdA } = await admin.auth.admin.createUser({ email: credsA.email, password: credsA.password, email_confirm: true });
  const { data: createdB } = await admin.auth.admin.createUser({ email: credsB.email, password: credsB.password, email_confirm: true });
  uidA = createdA.user.id; uidB = createdB.user.id;

  const aClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await aClient.auth.signInWithPassword({ email: credsA.email, password: credsA.password });

  // A creates a REAL family_trust entity as an authenticated user via the anon-key
  // client (RLS-scoped, not service-role) -- proves 0136's widened CHECK constraint
  // is live end-to-end through the exact write path the real app uses, not just that
  // the ALTER TABLE ran without error.
  const { data: entity, error: createErr } = await aClient.from('business_entities').insert({
    user_id: uidA, entity_type: 'family_trust', name: 'LR-11B disposable test trust',
    ownership_percentage: 60, valuation_mode: 'summary', currency_code: 'AUD',
  }).select('*').single();
  check('A can create a family_trust entity as an authenticated (non-service) user', true, !createErr && entity?.entity_type === 'family_trust');
  entityId = entity?.id;

  // Negative control on the constraint itself: an arbitrary third entity_type value
  // must still be rejected (proves the widening is exactly {'company','family_trust'},
  // not accidentally opened up further).
  const { error: badTypeErr } = await aClient.from('business_entities').insert({
    user_id: uidA, entity_type: 'sole_trader_partnership_zzz', name: 'should be rejected',
    ownership_percentage: 50, valuation_mode: 'summary', currency_code: 'AUD',
  });
  check('an arbitrary third entity_type value is still rejected (23514 check violation)', '23514', badTypeErr?.code);

  // A's child asset row (business_entity_assets), matching the Detailed-mode shape.
  const { data: asset } = await aClient.from('business_entity_assets').insert({
    user_id: uidA, business_entity_id: entityId, label: 'trust-held property', value: 500000, currency_code: 'AUD',
  }).select('*').single();
  assetId = asset?.id;
  check('A can create a child asset row under the family_trust entity', true, !!assetId);

  const bClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await bClient.auth.signInWithPassword({ email: credsB.email, password: credsB.password });

  const { data: readEntity } = await bClient.from('business_entities').select('*').eq('id', entityId);
  check('B cannot read A entity row by real id', 0, readEntity?.length ?? 0);

  const { data: listEntities } = await bClient.from('business_entities').select('*');
  check('B\'s own list does not include A\'s entity', false, (listEntities ?? []).some((r) => r.id === entityId));

  const { data: readAsset } = await bClient.from('business_entity_assets').select('*').eq('id', assetId);
  check('B cannot read A\'s child asset row', 0, readAsset?.length ?? 0);

  const { data: updateResult, error: updateErr } = await bClient.from('business_entities').update({ ownership_percentage: 1 }).eq('id', entityId).select('*');
  check('B\'s update of A\'s entity affects 0 rows', 0, updateResult?.length ?? 0);

  // B attempts to forge a row claiming A's user_id (ownership forgery).
  const { error: forgeErr } = await bClient.from('business_entities').insert({
    user_id: uidA, entity_type: 'company', name: 'forged by B', ownership_percentage: 100, valuation_mode: 'summary', currency_code: 'AUD',
  });
  check('B cannot insert a row forging A\'s user_id (RLS with-check denial)', true, !!forgeErr);

  // Re-read as A to prove ownership_percentage genuinely untouched by B's attempted update.
  const { data: reread } = await aClient.from('business_entities').select('ownership_percentage').eq('id', entityId).single();
  check('A\'s ownership_percentage genuinely unchanged after B\'s attempted update', 60, reread?.ownership_percentage);

  const succeeded = results.filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.actual));
  console.log(`\n${results.length - succeeded.length}/${results.length} checks matched expected (isolation + constraint-widening held) — ${succeeded.length} unexpected result(s).`);
  if (succeeded.length) process.exitCode = 1;
} finally {
  // Supabase's query builder is thenable but doesn't expose .catch() directly on the
  // pre-await chain -- wrap each cleanup step so one failure can't skip the rest.
  if (assetId) { try { await admin.from('business_entity_assets').delete().eq('id', assetId); } catch { /* best-effort cleanup */ } }
  if (entityId) { try { await admin.from('business_entities').delete().eq('id', entityId); } catch { /* best-effort cleanup */ } }
  if (uidA) { try { await admin.auth.admin.deleteUser(uidA); } catch { /* best-effort cleanup */ } }
  if (uidB) { try { await admin.auth.admin.deleteUser(uidB); } catch { /* best-effort cleanup */ } }
  console.log('cleaned up both disposable users and any residual test rows');
}
