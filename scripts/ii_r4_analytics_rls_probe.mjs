// R4 — focused probe: can an ordinary authenticated user forge a row in the
// ii_analytics_results table AS IT CURRENTLY EXISTS IN DEV (the migration-0035
// shape, whose RLS policy is `for all using (auth.uid() = user_id)`)?
//
// This distinguishes a genuine RLS rejection from the incidental
// "column does not exist" rejection seen when the R4 columns are absent.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (fs.existsSync(p)) {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return env;
    }
  }
  throw new Error('No .env.local found');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

async function req(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const password = 'TestPass!' + stamp;
const email = `ii-r4-rlsprobe-${stamp}@fhip-test.local`;

const created = await req('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
const userId = created.json?.id;
const signIn = await req('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });
const token = signIn.json?.access_token;
if (!userId || !token) { console.error('setup failed', created.text, signIn.text); process.exit(2); }
console.log(`Test user: ${userId}`);

// Discover the live column shape via an OPTIONS-style select of known 0035 columns.
const shapeProbe = await req('/rest/v1/ii_analytics_results?select=subject_type,subject_id,metric_key,metric_value,calculation_version,input_snapshot&limit=1');
console.log(`\n0035-shape columns present: ${shapeProbe.ok ? 'YES' : 'NO'}`);
if (!shapeProbe.ok) console.log(`  ${shapeProbe.text.slice(0, 200)}`);

const r4ShapeProbe = await req('/rest/v1/ii_analytics_results?select=data_as_of_date,input_snapshot_version,scope_type,engine_version&limit=1');
console.log(`0043-shape columns present: ${r4ShapeProbe.ok ? 'YES' : 'NO'}`);
if (!r4ShapeProbe.ok) console.log(`  ${r4ShapeProbe.text.slice(0, 200)}`);

// THE ACTUAL SECURITY QUESTION: forge a row using the CURRENT live shape.
if (shapeProbe.ok) {
  const forge = await req('/rest/v1/ii_analytics_results', {
    apikey: ANON,
    token,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      user_id: userId,
      subject_type: 'portfolio',
      subject_id: '00000000-0000-0000-0000-000000000001',
      metric_key: 'portfolio_twrr',
      metric_value: '9.999999',
      calculation_version: 'FORGED-BY-CLIENT',
      input_snapshot: { forged: true },
    },
  });
  console.log(`\n>>> Ordinary user INSERT into live ii_analytics_results: HTTP ${forge.status}`);
  console.log(`    ${forge.text.slice(0, 300)}`);
  console.log(
    forge.ok
      ? '    RESULT: *** SECURITY GAP *** — an ordinary user CAN write analytics rows under the current DEV schema.'
      : '    RESULT: rejected.'
  );
  if (forge.ok) {
    const id = forge.json?.[0]?.id;
    if (id) await req(`/rest/v1/ii_analytics_results?id=eq.${id}`, { method: 'DELETE' });
  }
}

await req(`/rest/v1/ii_analytics_results?user_id=eq.${userId}`, { method: 'DELETE' });
await req(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
console.log('\nCleanup done.');
