// Determine G4_APP_CAPABILITY_LAYER_ENABLED's ACTUAL runtime-effective
// value in production -- not what the Amplify console shows, but what
// requireModuleCapability() actually does with a real GENERIC user, since
// amplify.yml's build script may never forward this var into
// .env.production (see amplify.yml's own comment on this exact bug class).
//
// Method: a real disposable synthetic PRODUCTION GENERIC (GB) user,
// confirmed and disclosure-acknowledged, attempting a real HTTP request
// against the real production app's own API route for a G4-gated-only
// module. If G4 is effectively OFF at runtime, requireModuleCapability()
// takes the LEGACY path (requireCountryConfirmedUser-equivalent), which
// refuses a GENERIC user outright, before ever consulting G5B or the
// rollout gate. If G4 is effectively ON, a GENERIC user reaches the
// module-capability resolver instead, which behaves differently.
//
// This test targets a route that is SAFE to probe with a real GET request
// (VIEW operation, no write): GET /api/cross-border-relationships, since
// G6 Contract 7 (docs/country-programme/g6-data-contracts.md) explicitly
// documented this module as "already generic-accessible pre-G4" via
// allowGenericWhenG4Off -- meaning it is NOT a clean discriminator between
// G4 on/off (it lets GENERIC through either way). Use GET /api/income
// instead (a VIEW operation): G4 off refuses GENERIC entirely (403); G4 on
// admits GENERIC at VIEW for all six universal modules per the manifest.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const ANON_KEY = 'sb_publishable_pWgbqCKmXZBCbqOtMr23Cw_V_oM8cZy';
const SERVICE_KEY = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE = 'https://app.financialhealthplatform.com';

if (!SERVICE_KEY) { console.error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const stamp = Date.now();
const email = `g8-g4check-${stamp}@fhip-internal-test.invalid`;
const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;

let userId;
try {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userId = data.user.id;

  await admin.from('user_profiles').update({
    country_of_residence: 'GB',
    country_confirmed_at: new Date().toISOString(),
    country_source: 'USER_CONFIRMED',
    generic_disclosure_version: 'G8-G4-RUNTIME-CHECK-V1',
    generic_disclosure_acknowledged_at: new Date().toISOString(),
    generic_disclosure_country: 'GB',
  }).eq('user_id', userId);

  // Real sign-in to get a real session (cookie needed for the app's own
  // route, not just the Supabase REST API -- construct the exact
  // @supabase/ssr cookie format, matching this project's own established
  // reverse-engineered format from this session's real browser inspection).
  const { data: signInData, error: signInErr } = await createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    .auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;

  const projectRef = new URL(SUPABASE_URL).host.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(signInData.session), 'utf8').toString('base64');
  const cookie = `sb-${projectRef}-auth-token=${cookieValue}`;

  const res = await fetch(`${APP_BASE}/api/income`, { method: 'GET', headers: { Cookie: cookie } });
  const bodyText = await res.text();
  let body = null;
  try { body = JSON.parse(bodyText); } catch { /* not json */ }

  console.log(`GET /api/income as confirmed GENERIC (GB) production user -> status ${res.status}`);
  console.log(`Body: ${bodyText.slice(0, 300)}`);

  if (res.status === 200) {
    console.log('\nCONCLUSION: G4_APP_CAPABILITY_LAYER_ENABLED is EFFECTIVELY ON at runtime -- a GENERIC user was admitted to a G4-manifest module at VIEW.');
  } else if (res.status === 403) {
    console.log(`\nCONCLUSION: G4_APP_CAPABILITY_LAYER_ENABLED is EFFECTIVELY OFF at runtime -- a GENERIC user was refused (${body?.error ?? 'no error code'}), consistent with the LEGACY (flag-off) gate that refuses GENERIC unconditionally, not the manifest-driven CAPABILITY_NOT_ENABLED/WRITE_NOT_CERTIFIED_FOR_GENERIC reasons.`);
  } else {
    console.log(`\nCONCLUSION: inconclusive -- unexpected status ${res.status}.`);
  }
} catch (e) {
  console.error('SCRIPT ERROR:', e.message);
} finally {
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.error('cleanup error:', error.message);
    const { data: check } = await admin.auth.admin.getUserById(userId);
    console.log(check?.user ? 'RESIDUE: user still exists' : 'Zero residue confirmed.');
  }
}
