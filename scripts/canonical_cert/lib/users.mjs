/**
 * Canonical-upload certification harness: synthetic-user allocator.
 *
 * ONLY EXISTING standing synthetic fixture users are allocated -- nothing here creates an account.
 * Two fixture sets exist on DEV (both loaded long ago by the project's own seed scripts):
 *
 *   FCAST  "User tests/forecasting test/FHIP_Forecasting_50_Case_Test_Data.json" (.users[])
 *          email forecast.tcNNN@example.test; the fixture file ALSO carries each user's test password
 *          (seeded by scripts/seedForecastingTestData.ts). Password sign-in or service-role mint.
 *   E2E50  "User tests/FHIP_50_User_E2E_Test_Package/FHIP_50_User_Test_Data.json" (TC001-TC050)
 *          email fhip.e2e.tcNNN@test.fhip.invalid; created by harness/loadFixtures.ts with a RANDOM
 *          password that was never stored, so these users can ONLY be signed in by service-role mint.
 *
 * Both sets carry standing fixture data (income/expenses/assets/...), used by other regression suites.
 * Never delete or edit it: journeys are asserted as DELTAS against a ledger baseline, and the ledger
 * (lib/residueLedger.mjs) deletes only what the run created.
 *
 * Allocation is deterministic from the fixture files alone: users are split by country (AU / IN) and
 * dealt round-robin into ranges A-D, so every range gets a similar AU/IN mix and the ranges are disjoint.
 */
import fs from 'node:fs';
import path from 'node:path';

export const RANGES = ['A', 'B', 'C', 'D'];
/** Held back from A-D for the harness's own smoke test, so it can never collide with a certifier. */
export const HARNESS_RESERVED = ['fhip.e2e.tc050@test.fhip.invalid'];
export const RANGE_PORTS = { A: 3971, B: 3972, C: 3973, D: 3974, SMOKE: 3970 };

const FIXTURE_ROOTS = [process.cwd(), path.join('D:', 'FHIP')];
export const FCAST_FILE = path.join('User tests', 'forecasting test', 'FHIP_Forecasting_50_Case_Test_Data.json');
export const E2E50_FILE = path.join('User tests', 'FHIP_50_User_E2E_Test_Package', 'FHIP_50_User_Test_Data.json');

export function findFixture(rel) {
  const hit = FIXTURE_ROOTS.map((r) => path.join(r, rel)).find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`fixture file not found: ${rel} (looked in ${FIXTURE_ROOTS.join(', ')}). It is gitignored and lives in D:\\FHIP\\User tests.`);
  return hit;
}

export function normaliseCountry(c) {
  const v = String(c ?? '').trim().toUpperCase();
  return v === 'AU' || v === 'AUSTRALIA' ? 'AU' : v === 'IN' || v === 'INDIA' ? 'IN' : v || null;
}

/** Fixture users WITHOUT secrets: [{set, fixtureId, email, country}] */
export function fixtureUsers() {
  const fcast = JSON.parse(fs.readFileSync(findFixture(FCAST_FILE), 'utf8')).users.map((u) => ({
    set: 'FCAST', fixtureId: u.scenario_id, email: u.email, country: normaliseCountry(u.country), signIn: ['password', 'mint'],
  }));
  const e2eData = JSON.parse(fs.readFileSync(findFixture(E2E50_FILE), 'utf8'));
  const e2eRows = e2eData.Test_Cases ?? Object.values(e2eData).find((rows) => Array.isArray(rows) && rows.some((r) => /^TC\d{3}$/.test(String(r.TestCaseID ?? '')) && (r.Country || r.country)));
  const countryOf = new Map((e2eRows ?? []).map((r) => [String(r.TestCaseID), normaliseCountry(r.Country ?? r.country)]));
  const e2e = Array.from({ length: 50 }, (_, i) => {
    const id = `TC${String(i + 1).padStart(3, '0')}`;
    return { set: 'E2E50', fixtureId: id, email: `fhip.e2e.${id.toLowerCase()}@test.fhip.invalid`, country: countryOf.get(id) ?? null, signIn: ['mint'] };
  });
  return [...fcast, ...e2e];
}

/** Read ONE fixture password at runtime (never logged, never written anywhere). */
export function fixturePassword(email) {
  const u = JSON.parse(fs.readFileSync(findFixture(FCAST_FILE), 'utf8')).users.find((x) => x.email === email);
  if (!u?.password) throw new Error(`no fixture password for ${email} (only FCAST users have one; E2E50 users sign in by --method=mint)`);
  return u.password;
}

/** Deterministic disjoint allocation: {A:[...],B:[...],C:[...],D:[...]} */
export function allocate(allUsers = fixtureUsers()) {
  const users = allUsers.filter((u) => !HARNESS_RESERVED.includes(u.email));
  const out = Object.fromEntries(RANGES.map((r) => [r, []]));
  let k = 0; // one running dealer position across every group, so range sizes differ by at most 1
  for (const set of ['FCAST', 'E2E50']) {
    for (const country of ['AU', 'IN', null]) {
      const group = users.filter((u) => u.set === set && (country ? u.country === country : !['AU', 'IN'].includes(u.country)))
        .sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
      for (const u of group) { const r = RANGES[k++ % RANGES.length]; out[r].push({ ...u, range: r }); }
    }
  }
  return out;
}

/** Look the allocated emails up on DEV (read-only) and attach DEV user ids + gate state. */
export async function resolveOnDev(allocation, sb) {
  const all = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    all.push(...data.users);
    if (data.users.length < 1000) break;
  }
  const byEmail = new Map(all.map((u) => [u.email, u]));
  const resolved = {};
  for (const [range, list] of Object.entries(allocation)) {
    resolved[range] = [];
    for (const u of list) {
      const au = byEmail.get(u.email);
      if (!au) { resolved[range].push({ ...u, devUserId: null, note: 'NOT ON DEV' }); continue; }
      const { data: prof } = await sb.from('user_profiles').select('onboarding_completed,country_of_residence,country_confirmed_at').eq('user_id', au.id).maybeSingle();
      const { count: members } = await sb.from('household_members').select('*', { count: 'exact', head: true }).eq('user_id', au.id);
      resolved[range].push({
        ...u, devUserId: au.id,
        onboarded: Boolean(prof?.onboarding_completed), profileCountry: prof?.country_of_residence ?? null,
        countryConfirmed: Boolean(prof?.country_confirmed_at), householdMembers: members ?? 0,
      });
    }
  }
  return resolved;
}
