#!/usr/bin/env node
/**
 * Mandatory Country Confirmation — Gate B read-only production inventory.
 *
 * STRICTLY READ-ONLY. Every request in this file is a GET against
 * PostgREST (`/rest/v1/...`) or the GoTrue admin read endpoint
 * (`/auth/v1/admin/users`) — there is no POST/PATCH/PUT/DELETE anywhere in
 * this file, and none should ever be added to it. Uses
 * PRODUCTION_SUPABASE_URL / PRODUCTION_SUPABASE_SERVICE_ROLE_KEY from
 * .env.local (repo root), which the Product Owner confirmed is the correct
 * production project (twwpnltizhtjxhamyoxt) — this script never prints the
 * key itself, and only prints masked emails / shortened user ids.
 *
 * Run from the repo root: `node scripts/mcc_production_readonly_audit.mjs`
 *
 * Output: a masked summary to stdout (safe to paste into a report/PR) and,
 * separately, a restricted detailed JSON manifest written OUTSIDE the repo
 * (see RESTRICTED_OUT_DIR below) containing exact ids/emails for eventual
 * controlled execution — never committed to git.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Written outside the repo tree entirely, in addition to being gitignored —
// belt and braces against ever committing exact ids/emails (spec 7.4: "Do
// not commit the restricted detailed cleanup manifest to Git").
const RESTRICTED_OUT_DIR =
  process.env.MCC_RESTRICTED_MANIFEST_DIR ??
  join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'fhip-mcc-restricted-manifests');

function loadEnvLocal() {
  const path = join(REPO_ROOT, '.env.local');
  const text = readFileSync(path, 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function maskEmail(email) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local[0] ?? '*'}***@${domain}`;
}

function shortId(id) {
  return id ? `${id.slice(0, 8)}…` : null;
}

const COUNTRY_CODE_SHAPE = /^[A-Za-z]{2}$/;
const SUPPORTED = new Set(['AU', 'IN']);
function classify(raw) {
  if (raw == null || String(raw).trim() === '') return 'MISSING';
  const trimmed = String(raw).trim();
  if (!COUNTRY_CODE_SHAPE.test(trimmed)) return 'INVALID';
  const upper = trimmed.toUpperCase();
  return SUPPORTED.has(upper) ? 'SUPPORTED' : 'UNSUPPORTED';
}

const FINANCIAL_TABLES = [
  'income_sources',
  'expense_items',
  'assets',
  'liabilities',
  'investments',
  'retirement_accounts',
  'insurance_policies',
  'user_goals',
];
const OTHER_DEPENDENCY_TABLES = [
  'households',
  'consents',
  'audit_events',
  'financial_records_audit',
  'reports',
  'report_generation_runs',
];

async function main() {
  const env = loadEnvLocal();
  const url = env.PRODUCTION_SUPABASE_URL ?? 'https://twwpnltizhtjxhamyoxt.supabase.co';
  const key = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY not found in .env.local — refusing to guess/fabricate.');

  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  async function getJson(path) {
    const res = await fetch(`${url}${path}`, { headers, method: 'GET' });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  }
  async function count(path) {
    const res = await fetch(`${url}${path}`, { headers: { ...headers, Prefer: 'count=exact' }, method: 'GET' });
    const range = res.headers.get('content-range');
    return range ? Number(range.split('/')[1]) : 0;
  }

  // --- Auth users (GoTrue admin read endpoint — GET only) -----------------
  const authRes = await getJson('/auth/v1/admin/users?per_page=1000');
  const authUsers = authRes.users ?? [];

  // --- Profiles -------------------------------------------------------------
  const profiles = await getJson(
    '/rest/v1/user_profiles?select=user_id,country_of_residence,preferred_currency,onboarding_completed,created_at,updated_at&order=created_at.asc'
  );

  const authById = new Map(authUsers.map((u) => [u.id, u]));
  const profileById = new Map(profiles.map((p) => [p.user_id, p]));

  const authWithoutProfile = authUsers.filter((u) => !profileById.has(u.id));
  const orphanProfiles = profiles.filter((p) => !authById.has(p.user_id));

  const classified = profiles.map((p) => ({ ...p, shape: classify(p.country_of_residence) }));
  const countryDistribution = {};
  for (const p of classified) {
    const key2 = p.shape === 'SUPPORTED' ? p.country_of_residence.trim().toUpperCase() : p.shape;
    countryDistribution[key2] = (countryDistribution[key2] ?? 0) + 1;
  }

  const unresolved = classified.filter((p) => p.shape !== 'SUPPORTED');

  // --- Per-unresolved-user dependency inventory ------------------------------
  const dependencyByUser = {};
  for (const p of unresolved) {
    const row = { user_id: p.user_id };
    for (const t of [...FINANCIAL_TABLES, ...OTHER_DEPENDENCY_TABLES]) {
      row[t] = await count(`/rest/v1/${t}?select=user_id&user_id=eq.${p.user_id}&limit=1`);
    }
    dependencyByUser[p.user_id] = row;
  }

  // --- Entitlements (subscription/payment signal) --------------------------
  const entitlements = await getJson('/rest/v1/user_entitlements?select=user_id,plan_tier');
  const entitlementByUser = new Map(entitlements.map((e) => [e.user_id, e.plan_tier]));

  // --- Classification + proposed action (spec 7.2) --------------------------
  const candidates = unresolved.map((p) => {
    const auth = authById.get(p.user_id);
    const deps = dependencyByUser[p.user_id];
    const financialRows = FINANCIAL_TABLES.reduce((sum, t) => sum + (deps[t] ?? 0), 0);
    const otherRows = OTHER_DEPENDENCY_TABLES.reduce((sum, t) => sum + (deps[t] ?? 0), 0);
    const neverSignedIn = !auth?.last_sign_in_at;
    const hasAnyData = financialRows > 0 || otherRows > 0;
    const planTier = entitlementByUser.get(p.user_id) ?? null;

    let classification;
    let action;
    let reason;
    if (hasAnyData) {
      classification = 'HAS_FINANCIAL_DATA';
      action = 'PRESERVE_REQUIRE_CONFIRMATION';
      reason = `Holds ${financialRows} financial row(s) and/or ${otherRows} other dependency row(s) — not disposable regardless of country state.`;
    } else if (neverSignedIn) {
      classification = 'UNCERTAIN';
      action = 'MANUAL_REVIEW';
      reason =
        'Zero financial/dependency rows and never signed in, but email is unconfirmed and/or the address does not conclusively indicate a synthetic account — email domain/pattern alone is not sufficient proof of disposability (spec 7.2).';
    } else {
      classification = 'EMPTY_BETA_CANDIDATE';
      action = 'PROPOSE_DELETE';
      reason =
        'Authenticated at least once, completed no onboarding step, and holds zero rows in every checked financial/dependency table. Proposed for Product Owner review only — this task does not delete anything.';
    }

    return {
      user_id: p.user_id,
      email: auth?.email ?? null,
      shape: p.shape,
      country_of_residence: p.country_of_residence,
      created_at: p.created_at,
      last_sign_in_at: auth?.last_sign_in_at ?? null,
      email_confirmed_at: auth?.email_confirmed_at ?? null,
      provider: auth?.app_metadata?.provider ?? null,
      plan_tier: planTier,
      dependencies: deps,
      financialRows,
      otherRows,
      classification,
      proposed_action: action,
      reason,
    };
  });

  // --- Masked summary (stdout — safe to paste into the closure report) -----
  console.log('=== Mandatory Country Confirmation — Gate B read-only production audit ===');
  console.log('Run at:', new Date().toISOString());
  console.log('Total auth users:', authUsers.length);
  console.log('Total profiles:', profiles.length);
  console.log('Auth users without a profile:', authWithoutProfile.length);
  console.log('Orphan profiles without an auth user:', orphanProfiles.length);
  console.log('Country distribution:', JSON.stringify(countryDistribution));
  console.log('Unresolved (non-SUPPORTED) profiles:', unresolved.length);
  console.log('');
  for (const c of candidates) {
    console.log(
      `Candidate ${shortId(c.user_id)} | ${maskEmail(c.email)} | created ${c.created_at?.slice(0, 7)} | last-sign-in ${
        c.last_sign_in_at ? c.last_sign_in_at.slice(0, 7) : 'never'
      } | ${c.classification} -> ${c.proposed_action} | financial_rows=${c.financialRows} other_rows=${c.otherRows}`
    );
  }

  // --- Restricted detailed manifest (local file, outside repo, gitignored) -
  mkdirSync(RESTRICTED_OUT_DIR, { recursive: true });
  const restrictedPath = join(RESTRICTED_OUT_DIR, `mcc_restricted_manifest_${Date.now()}.json`);
  writeFileSync(
    restrictedPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        production_host: url,
        totals: {
          authUsers: authUsers.length,
          profiles: profiles.length,
          authWithoutProfile: authWithoutProfile.length,
          orphanProfiles: orphanProfiles.length,
          countryDistribution,
        },
        candidates,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log('');
  console.log('Restricted detailed manifest written to (NOT in the repo, NOT for the general report):', restrictedPath);
}

main().catch((err) => {
  console.error('Gate B audit failed:', err.message);
  process.exitCode = 1;
});
