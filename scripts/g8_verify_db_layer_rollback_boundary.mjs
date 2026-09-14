// G8 verification -- Point 4 §16: does the app-layer rollout kill switch
// (ROLLOUT_G5B_GENERIC_WRITE_ENABLED=false/unset) have ANY effect on a
// GENERIC user's own DIRECT authenticated PostgREST INSERT/UPDATE against
// income_sources -- i.e., does the app-layer control reach the DB layer at
// all, or is migration 0129's grant genuinely unconditional once applied
// (as its own governing comment claims)? Real DEV, one synthetic user,
// full cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(import.meta.dirname, '..');
function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^\uFEFF/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
  return env;
}
const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
function check(label, cond, detail = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); cond ? pass++ : fail++; }

const stamp = Date.now();
const email = `g8-dbboundary-${stamp}@example.com`;
const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
let userId, rowId;
try {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  await admin.from('user_profiles').update({
    country_of_residence: 'GB', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED',
    generic_disclosure_version: 'G8-DBBOUNDARY-V1', generic_disclosure_acknowledged_at: new Date().toISOString(), generic_disclosure_country: 'GB',
  }).eq('user_id', userId);

  const { data: signInData, error: signInErr } = await createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    .auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(signInErr.message);

  // Direct client using the user's OWN bearer token -- NOT service-role,
  // NOT going through any Next.js app route at all. This is exactly what
  // migration 0129's is_write_permitted() trigger evaluates.
  const direct = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signInData.session.access_token}` } },
  });

  // NOTE: no app-layer ROLLOUT_* or G4/G5B_* env vars are set for THIS
  // script's own process at all (this process never imports appCapability.ts
  // or rolloutCohort.ts -- it only holds a raw Supabase client), which is
  // the point: proving the DB layer's behaviour is independent of whatever
  // the application process's env vars say, because a direct PostgREST call
  // never passes through requireModuleCapability() in the first place.
  const insertRes = await direct.from('income_sources').insert({
    user_id: userId, source_name: 'g8 dbboundary income', income_type: 'salary', amount: 999, frequency: 'monthly', currency_code: 'AUD',
  }).select('id').single();
  check('Direct authenticated PostgREST INSERT succeeds regardless of app-layer rollout/kill-switch state (DB grant is unconditional)', !insertRes.error, insertRes.error?.message ?? JSON.stringify(insertRes.data));
  rowId = insertRes.data?.id;

  if (rowId) {
    const updateRes = await direct.from('income_sources').update({ amount: 1000 }).eq('id', rowId);
    check('Direct authenticated PostgREST ordinary UPDATE also succeeds (unconditional grant)', !updateRes.error, updateRes.error?.message);

    const archiveRes = await direct.from('income_sources').update({ is_active: false }, { count: 'exact' }).eq('id', rowId);
    check('0147: direct archive-via-UPDATE (is_active:false) still BLOCKED regardless of app-layer rollout state', !!archiveRes.error || archiveRes.count === 0, archiveRes.error?.message ?? `count=${archiveRes.count}`);

    const deleteRes = await direct.from('income_sources').delete({ count: 'exact' }).eq('id', rowId);
    check('Direct literal SQL DELETE also blocked (GENERIC has no DELETE grant at all)', !!deleteRes.error || deleteRes.count === 0, deleteRes.error?.message ?? `count=${deleteRes.count}`);
  }
} catch (e) {
  console.error('SCRIPT ERROR:', e.message);
  fail++;
} finally {
  if (rowId) await admin.from('income_sources').delete().eq('id', rowId);
  if (userId) {
    await admin.auth.admin.deleteUser(userId);
    const { data } = await admin.auth.admin.getUserById(userId);
    check('ZERO RESIDUE: user gone', !data?.user);
  }
  const { count } = userId ? await admin.from('income_sources').select('id', { count: 'exact', head: true }).eq('user_id', userId) : { count: 0 };
  check('ZERO RESIDUE: no rows remain', !count || count === 0);
  console.log(`\n=== SUMMARY: ${pass}/${pass + fail} checks passed ===`);
}
