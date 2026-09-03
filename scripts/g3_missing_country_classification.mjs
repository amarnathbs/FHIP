// G3 closure governance — classification of DEV profiles with no country.
//
// STRICTLY READ-ONLY. Performs no INSERT, UPDATE or DELETE of any kind, and
// deliberately contains no code that could. Its only job is to answer, with
// evidence, what the missing-country rows on DEV actually are, so the
// Product Owner can decide their treatment.
//
// PRIVACY: reports PATTERNS and AGGREGATES. Individual email addresses are
// never printed in full — synthetic identities are summarised by their
// fixture prefix, and anything not matching a known fixture pattern is
// reported only as a redacted shape (first character + domain), which is
// enough to tell a real signup from a fixture without disclosing personal
// data into a report.
//
//   node --env-file=.env.local scripts/g3_missing_country_classification.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('missing DEV credentials'); process.exit(2); }
if (/prod/i.test(url)) { console.error('REFUSING: looks like production'); process.exit(3); }

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// Known synthetic-fixture prefixes across this repository's certification
// history. Sourced by grepping the repo's own scripts/ and tests/ for the
// email patterns they generate — not guessed.
const FIXTURE_PATTERNS = [
  [/^g3cert\./i, 'G3 live-DEV certification (this workstream)'],
  [/^g3e2e\./i, 'G3 browser certification (this workstream)'],
  [/^nav-test\+/i, 'navigation.spec.ts e2e fixture'],
  [/^test\+/i, 'onboarding.spec.ts / generic e2e fixture'],
  [/^fdh/i, 'Financial Data Hub certification'],
  [/^ii[-._]/i, 'Investment Intelligence certification'],
  [/^r\d+[-._]/i, 'Resources phase certification'],
  [/^admin[-._]/i, 'Admin A0.2 certification'],
  [/^a02/i, 'Admin A0.2 certification'],
  [/^mcc/i, 'Mandatory Country Confirmation certification'],
  [/^egl/i, 'Education Goal Linkage certification'],
  [/^module11/i, 'Module 11 certification'],
  [/^cert[-._+]/i, 'generic certification fixture'],
  [/^seed[-._+]/i, 'seed fixture'],
  [/^user\d+@/i, '50-user regression fixture'],
  [/@fhip-certification\.test$/i, 'explicitly-marked certification domain'],
  [/@example\.com$/i, 'RFC-2606 reserved example domain (never a real mailbox)'],
  [/@t\.test$/i, 'reserved .test TLD fixture'],
  // RFC 2606 / RFC 6761 reserve .test, .invalid, .example and .localhost so
  // they can never resolve to a real mailbox. An address in one of these is
  // synthetic by construction, whatever its local part says.
  [/\.invalid$/i, 'RFC-2606 reserved .invalid domain (can never be a real mailbox)'],
  [/\.local$/i, 'reserved .local domain (never routable mail)'],
  [/\.test$/i, 'RFC-6761 reserved .test TLD'],
];

function classifyEmail(email) {
  for (const [re, label] of FIXTURE_PATTERNS) if (re.test(email)) return label;
  return null;
}
function redact(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain ?? '?'}`;
}

// ---------------------------------------------------------------------------
const { data: authData, error: authErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (authErr) { console.error(authErr.message); process.exit(1); }
const authById = new Map((authData?.users ?? []).map((u) => [u.id, u]));

const { data: profiles, error: pErr } = await admin
  .from('user_profiles')
  .select('user_id, country_of_residence, country_confirmed_at, onboarding_completed, preferred_currency, created_at');
if (pErr) { console.error(pErr.message); process.exit(1); }

const missing = profiles.filter((p) => !p.country_of_residence);
console.log(`total profiles: ${profiles.length}`);
console.log(`profiles with NO country_of_residence: ${missing.length}\n`);

// ---------------------------------------------------------------------------
console.log('--- A. Classification by identity pattern ---');
// ---------------------------------------------------------------------------
const buckets = new Map();
const unclassified = [];
for (const p of missing) {
  const u = authById.get(p.user_id);
  const email = u?.email ?? '';
  if (!u) {
    const k = 'ORPHANED PROFILE (no matching auth.users row)';
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
    continue;
  }
  const label = classifyEmail(email);
  if (label) buckets.set(label, (buckets.get(label) ?? 0) + 1);
  else unclassified.push({ p, u, email });
}
for (const [label, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${label}`);
}
console.log(`  ${String(unclassified.length).padStart(4)}  NOT MATCHED BY ANY KNOWN FIXTURE PATTERN`);

// ---------------------------------------------------------------------------
console.log('\n--- B. The unmatched rows, in detail (redacted) ---');
// ---------------------------------------------------------------------------
if (unclassified.length === 0) {
  console.log('  (none — every missing-country profile matches a known fixture pattern)');
} else {
  for (const { p, u, email } of unclassified.sort((a, b) => (a.u.created_at < b.u.created_at ? -1 : 1))) {
    console.log(
      `  ${redact(email).padEnd(28)} created=${String(u.created_at).slice(0, 10)}` +
      ` last_sign_in=${u.last_sign_in_at ? String(u.last_sign_in_at).slice(0, 10) : 'never'}` +
      ` onboarded=${p.onboarding_completed === true}` +
      ` currency=${p.preferred_currency ?? 'null'}`
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- C. Do any missing-country profiles hold real financial data? ---');
// ---------------------------------------------------------------------------
// This is the question that decides whether a row is a throwaway fixture or
// an account someone actually used. A missing-country profile CANNOT have
// created financial rows since MCC shipped, so any that has predates it.
const missingIds = missing.map((p) => p.user_id);
const FIN = ['income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'insurance_policies', 'user_goals'];
const withData = new Set();
for (const table of FIN) {
  const { data, error } = await admin.from(table).select('user_id').in('user_id', missingIds);
  if (error) { console.log(`  WARN could not read ${table}: ${error.message}`); continue; }
  const ids = new Set((data ?? []).map((r) => r.user_id));
  for (const id of ids) withData.add(id);
  console.log(`  ${table.padEnd(22)} rows owned by missing-country profiles: ${(data ?? []).length}`);
}
console.log(`  DISTINCT missing-country profiles holding ANY financial row: ${withData.size}`);
// WHICH ones hold data is the decisive question: a fixture holding rows is
// still a fixture, but a genuine mailbox holding rows is an account someone
// actually used and must never be touched.
for (const id of withData) {
  const u = authById.get(id);
  const email = u?.email ?? '(no auth row)';
  const label = classifyEmail(email) ?? 'NOT MATCHED — treat as potentially genuine';
  console.log(`    holder: ${redact(email).padEnd(28)} -> ${label}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- D. Sign-in evidence (has a human ever actually used it?) ---');
// ---------------------------------------------------------------------------
let neverSignedIn = 0, signedInOnce = 0, signedInMultiple = 0;
for (const p of missing) {
  const u = authById.get(p.user_id);
  if (!u) continue;
  if (!u.last_sign_in_at) neverSignedIn++;
  else if (u.last_sign_in_at === u.created_at) signedInOnce++;
  else signedInMultiple++;
}
console.log(`  never signed in:            ${neverSignedIn}`);
console.log(`  signed in (same ts as create): ${signedInOnce}`);
console.log(`  signed in later than create:   ${signedInMultiple}`);

// ---------------------------------------------------------------------------
console.log('\n--- E. Creation-date distribution ---');
// ---------------------------------------------------------------------------
const byMonth = {};
for (const p of missing) {
  const u = authById.get(p.user_id);
  const d = (u?.created_at ?? p.created_at ?? '').slice(0, 7);
  byMonth[d] = (byMonth[d] ?? 0) + 1;
}
for (const [m, n] of Object.entries(byMonth).sort()) console.log(`  ${m}: ${n}`);

// ---------------------------------------------------------------------------
console.log('\n--- F. Are they currently blocked? (MCC still holds) ---');
// ---------------------------------------------------------------------------
const sample = missing.slice(0, 5).map((p) => p.user_id);
for (const id of sample) {
  const { data } = await admin.rpc('is_country_confirmed', { p_user_id: id });
  const { data: reg } = await admin.rpc('is_country_registration_confirmed', { p_user_id: id });
  console.log(`  sample profile: financial-tier=${data} registration-tier=${reg} (both must be false)`);
}

console.log('\n=== READ-ONLY. No row was created, modified or deleted by this script. ===');
