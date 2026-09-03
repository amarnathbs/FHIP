// G3 live-DEV PREFLIGHT — read-only.
//
// Independently establishes, against real DEV, that migration 0127 is
// genuinely applied and active BEFORE any certification writes happen. This
// is deliberately a separate script from the certification itself: §18
// requires the migration to be "independently proven active" first, and a
// certification that silently passed because an object was missing would be
// worse than one that failed loudly.
//
// Performs ZERO writes. Run with:
//   node --env-file=.env.local scripts/g3_live_dev_preflight.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}
// Guard against ever pointing this at production by accident.
if (/prod/i.test(url)) {
  console.error('REFUSING TO RUN: the Supabase URL looks like production.');
  process.exit(3);
}
console.log(`target project ref: ${url.replace(/^https:\/\/([^.]+)\..*$/, '$1')}\n`);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

// ---------------------------------------------------------------------------
console.log('--- 1. Registry state (0127 section 2) ---');
// ---------------------------------------------------------------------------
const { data: countries, error: cErr } = await admin
  .from('countries')
  .select('country_code, country_name, experience_level, is_supported, selectable, active')
  .order('country_code');
check('countries registry is readable', !cErr && Array.isArray(countries), cErr ? `(${cErr.message})` : '');

const { data: caps, error: capErr } = await admin
  .from('country_capabilities')
  .select('country_code, capability, enabled, updated_at')
  .eq('capability', 'REGISTRATION')
  .order('country_code');
check('country_capabilities is readable', !capErr && Array.isArray(caps), capErr ? `(${capErr.message})` : '');

if (countries && caps) {
  const byCode = Object.fromEntries(countries.map((c) => [c.country_code.trim(), c]));
  const regOn = new Set(caps.filter((r) => r.enabled).map((r) => r.country_code.trim()));

  for (const c of ['AU', 'IN', 'GB', 'US', 'SG', 'AE']) {
    check(`${c} exists in the registry`, Boolean(byCode[c]));
    check(`${c} has REGISTRATION enabled`, regOn.has(c));
  }
  check('AU/IN are FULL', byCode.AU?.experience_level === 'FULL' && byCode.IN?.experience_level === 'FULL');
  for (const c of ['GB', 'US', 'SG', 'AE']) {
    check(`${c} is GENERIC`, byCode[c]?.experience_level === 'GENERIC');
  }
  // THE load-bearing invariant of the whole two-tier design.
  check('is_supported is TRUE for AU/IN only', byCode.AU?.is_supported === true && byCode.IN?.is_supported === true);
  for (const c of ['GB', 'US', 'SG', 'AE']) {
    check(`${c} is_supported remains FALSE (financial backstop untouched)`, byCode[c]?.is_supported === false);
  }
  console.log(`  INFO  REGISTRATION updated_at: ${caps.map((r) => `${r.country_code.trim()}=${String(r.updated_at).slice(0, 10)}`).join(' ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. New columns (0127 section 3) ---');
// ---------------------------------------------------------------------------
{
  const { error } = await admin
    .from('user_profiles')
    .select('generic_disclosure_version, generic_disclosure_acknowledged_at, generic_disclosure_country')
    .limit(1);
  check('the three generic_disclosure_* columns exist and are selectable', !error, error ? `(${error.message})` : '');
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. New functions are callable (0127 sections 5, 9) ---');
// ---------------------------------------------------------------------------
for (const [fn, args, expect] of [
  ['is_country_registration_eligible', { p_country_code: 'GB' }, true],
  ['is_country_registration_eligible', { p_country_code: 'AU' }, true],
  ['is_country_registration_eligible', { p_country_code: 'NZ' }, false],
]) {
  const { data, error } = await admin.rpc(fn, args);
  check(`${fn}('${args.p_country_code}') === ${expect}`, !error && data === expect, error ? `(${error.message})` : `(got ${data})`);
}
{
  // Existence probe only. Called with the SERVICE-ROLE client, which carries
  // no auth.uid(), so the expected outcome is UNAUTHENTICATED — and that is
  // itself worth asserting twice over: it proves the function is deployed,
  // AND it proves the function refuses to act for a caller with no user
  // identity, which is exactly what stops a service-role context from
  // confirming a country on someone's behalf.
  const { error } = await admin.rpc('confirm_country_of_residence', { p_country_code: 'ZZ', p_disclosure_version: null });
  check(
    'confirm_country_of_residence() is deployed and refuses a caller with no auth.uid()',
    Boolean(error) && /UNAUTHENTICATED/i.test(error.message),
    error ? `(${error.message.slice(0, 90)})` : '(unexpectedly succeeded)'
  );
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. Existing-user BASELINE (read-only aggregates, no identifiers) ---');
// ---------------------------------------------------------------------------
const { data: profiles, error: pErr } = await admin
  .from('user_profiles')
  .select('country_of_residence, country_confirmed_at, preferred_currency, primary_country, billing_country, billing_country_confirmed_at, generic_disclosure_version');
check('user_profiles is readable', !pErr && Array.isArray(profiles), pErr ? `(${pErr.message})` : '');

if (profiles) {
  const agg = {
    total: profiles.length,
    au_confirmed: profiles.filter((p) => p.country_of_residence?.trim() === 'AU' && p.country_confirmed_at).length,
    in_confirmed: profiles.filter((p) => p.country_of_residence?.trim() === 'IN' && p.country_confirmed_at).length,
    generic_confirmed: profiles.filter((p) => ['GB', 'US', 'SG', 'AE'].includes(p.country_of_residence?.trim()) && p.country_confirmed_at).length,
    missing_country: profiles.filter((p) => !p.country_of_residence).length,
    invalid_country: profiles.filter((p) => p.country_of_residence && !['AU', 'IN', 'GB', 'US', 'SG', 'AE'].includes(p.country_of_residence.trim())).length,
    currency_AUD: profiles.filter((p) => p.preferred_currency?.trim() === 'AUD').length,
    currency_INR: profiles.filter((p) => p.preferred_currency?.trim() === 'INR').length,
    currency_other: profiles.filter((p) => p.preferred_currency && !['AUD', 'INR'].includes(p.preferred_currency.trim())).length,
    currency_null: profiles.filter((p) => !p.preferred_currency).length,
    billing_confirmed: profiles.filter((p) => p.billing_country || p.billing_country_confirmed_at).length,
    generic_disclosure_rows: profiles.filter((p) => p.generic_disclosure_version).length,
  };
  console.log(`  BASELINE ${JSON.stringify(agg)}`);
  check('zero invalid country values exist on DEV', agg.invalid_country === 0, `(${agg.invalid_country})`);
  check('zero reporting currencies outside AUD/INR exist on DEV', agg.currency_other === 0, `(${agg.currency_other})`);
  check('zero billing countries are confirmed on DEV', agg.billing_confirmed === 0, `(${agg.billing_confirmed})`);
  // Write the baseline out so the post-certification run can diff it.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const out = path.join(process.cwd(), 'test-artifacts', 'g3_dev_baseline.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(agg, null, 2));
  console.log(`  INFO  baseline written to ${out}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. Synthetic-identity hygiene (no leftovers from a prior run) ---');
// ---------------------------------------------------------------------------
{
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const leftovers = (data?.users ?? []).filter((u) => (u.email ?? '').includes('g3cert'));
  check('admin auth API is reachable', !error, error ? `(${error.message})` : '');
  check('no synthetic g3cert identities exist before this run', leftovers.length === 0, `(found ${leftovers.length})`);
  if (leftovers.length) console.log(`  INFO  leftover ids: ${leftovers.map((u) => u.id).join(', ')}`);
}

console.log(`\n=== G3 live-DEV preflight: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
