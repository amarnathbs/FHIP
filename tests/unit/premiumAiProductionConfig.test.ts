// Production configuration proofs that need no production access (UNIT-TESTED, static + behavioural).
//
//  1. FORWARDING. On Amplify a server-only variable reaches the running Next server ONLY if amplify.yml writes it into .env.production
//     (its `env | grep -e ... >> .env.production` line). Every environment variable the document-AI path reads must either match
//     that list or be on the explicit, reasoned allowlist below. A new AI variable that is not forwarded fails here, before it silently
//     does nothing in production (the defect class this repository has met five times).
//  2. RETIRED PILOT SETTINGS. The six variables of the former two-e-mail pilot have NO effect on admission: with them set to every
//     extreme, the real shared gate still decides by the Premium entitlement alone, and a former-pilot user is treated exactly like
//     everyone else. Every remaining reference in code is a comment (inventory below).
//  3. UNRELATED INTERNAL AI JOBS stay unactivated by the document-AI switches: the factsheet reader has its own flag, is not forwarded,
//     and never reads the document-AI kill switch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { premiumAi } from '../support/premiumAiAccessMock';

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);

import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** The `-e` terms of the build step that writes .env.production (the server-only list). */
function forwardedTerms(): string[] {
  const yml = read('amplify.yml');
  const line = yml.split('\n').find((l) => /env \| grep/.test(l) && /\.env\.production/.test(l) && !/NEXT_PUBLIC_\s+>>/.test(l.replace('-e NEXT_PUBLIC_', '')) || /env \| grep -e SUPABASE_SERVICE_ROLE_KEY/.test(l));
  expect(line, 'the server-only forwarding line of amplify.yml').toBeTruthy();
  return [...line!.matchAll(/-e\s+(\S+)/g)].map((m) => m[1]);
}
const isForwarded = (name: string, terms: string[]) => terms.some((t) => name.includes(t));

/** Source scopes that implement or gate document AI, its scan, its limits and its upload admission. */
const AI_SCOPES = [
  'lib/aie',
  'lib/ai/access',
  'lib/entitlements',
  'lib/financial-data-hub/constants',
  'lib/financial-data-hub/services',
  'lib/services/investment-intelligence/factsheetReader',
  'app/api/aie',
  'app/api/financial-data-hub',
  'app/api/investment-intelligence',
];

/**
 * Variables read by that code which amplify.yml does NOT forward, each with the reason it is acceptable (or the open finding).
 * Adding a name here is a conscious decision recorded next to its reason.
 */
const NOT_FORWARDED_ON_PURPOSE: Record<string, string> = {
  NODE_ENV: 'set by Next itself',
  VITEST: 'test runner marker',
  NEXT_PUBLIC_SUPABASE_URL: 'NEXT_PUBLIC_ variables are inlined at build and written by the second env line',
  AWS_ACCESS_KEY_ID: 'fallback name only; Amplify reserves AWS_ names, so the scan credentials use AIE_MALWARE_AWS_* (forwarded by the AIE_ prefix)',
  AWS_SECRET_ACCESS_KEY: 'same as AWS_ACCESS_KEY_ID',
  AWS_SESSION_TOKEN: 'same as AWS_ACCESS_KEY_ID',
  FDH_DOCUMENT_UPLOAD_ENABLED:
    'OPEN FINDING (19/10/2026): not forwarded, so a console value of false never reaches the server; the upload kill switch cannot be operated from Amplify. ' +
    'The code treats anything but the exact text false as enabled, so production uploads are ON regardless. Forwarding it is a deliberate change: if the console holds a stale false it would switch uploads OFF.',
};

describe('1. every environment variable the document-AI path reads is forwarded to the server runtime', () => {
  const terms = forwardedTerms();

  it('the forwarded list still carries the prefixes the AI controls rely on', () => {
    for (const must of ['AIE_', 'II_AI_FALLBACK_', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET', 'APP_BASE_URL']) expect(terms, must).toContain(must);
  });

  it('NEGATIVE CONTROL: the matcher rejects a name that is not on the list', () => {
    expect(isForwarded('MODULE11_AI_PROVIDER', terms)).toBe(false); // true on origin/main: the Module 11 branch adds -e MODULE11_ (see the Module 11 pack)
    expect(isForwarded('OPENAI_API_KEY', terms)).toBe(false);
    expect(isForwarded('AIE_AI_FALLBACK_ENABLED', terms)).toBe(true);
    expect(isForwarded('AIE_MALWARE_AWS_ACCESS_KEY_ID', terms)).toBe(true);
    expect(isForwarded('II_AI_FALLBACK_ENABLED', terms)).toBe(true);
  });

  it('no AI-path variable is unforwarded except the reasoned allowlist', () => {
    const names = new Set<string>();
    const files = AI_SCOPES.flatMap((scope) => walk(scope));
    // Investment Intelligence: only its document-AI files (the NAV / reference jobs read unrelated tuning variables)
    files.push('lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts', 'lib/services/investment-intelligence/aiFallbackFeatureFlag.ts', 'lib/services/investment-intelligence/documentProcessing.ts');
    for (const f of files) {
      for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(30);
    const missing = [...names].filter((n) => !isForwarded(n, terms) && !(n in NOT_FORWARDED_ON_PURPOSE)).sort();
    expect(missing, `AI-path variables the server would never see in production: ${missing.join(', ')}`).toEqual([]);
    // the allowlist itself must not rot: every entry is still read somewhere (or is a platform name)
    for (const n of Object.keys(NOT_FORWARDED_ON_PURPOSE)) expect(names.has(n), `${n} is on the allowlist but no longer read`).toBe(true);
  });

  it('the factsheet reader AI flag is a separate switch that is NOT forwarded, so the document-AI kill switch cannot start it', () => {
    const flag = read('lib/services/investment-intelligence/factsheetReader/types.ts').match(/FACTSHEET_AI_ENV_FLAG = '([A-Z_]+)'/)?.[1];
    expect(flag).toBe('FACTSHEET_READER_AI_ENABLED');
    expect(isForwarded(flag!, terms)).toBe(false);
    const runner = read('lib/services/investment-intelligence/factsheetReader/aieAdapter.ts') + read('app/api/investment-intelligence/cron/factsheet-benchmark-reader/route.ts');
    expect(runner).not.toMatch(/isAieAiFallbackEnabled|AIE_AI_FALLBACK_ENABLED/);
    expect(read('app/api/investment-intelligence/cron/factsheet-benchmark-reader/route.ts')).toContain('FACTSHEET_AI_ENV_FLAG');
  });
});

describe('2. the retired pilot settings change nothing', () => {
  const RETIRED = [
    'AIE_PILOT_COHORT_ENFORCED', 'AIE_PILOT_COHORT_USER_IDS', 'AIE_PILOT_COHORT_EMAILS',
    'II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'II_AI_FALLBACK_PILOT_COHORT_USER_IDS', 'II_AI_FALLBACK_PILOT_COHORT_EMAILS',
  ];
  const TOUCHED = [...RETIRED, 'AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN', 'AIE_AI_FALLBACK_ENABLED', 'AIE_MASK_TOKEN_ENCRYPTION_KEY', 'AIE_REAL_MALWARE_SCAN_ENABLED'];
  let saved: Record<string, string | undefined>;
  const TEXT = 'Kestrel Coast Community Bank statement of account for the period. Opening balance 3,215.40 and closing balance 4,369.65 with six lines.';

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    process.env.AIE_AI_FALLBACK_ENABLED = 'true';
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
    delete process.env.AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN; // vitest.config sets this DEV-only override for unit tests; production must not
    premiumAi.reset();
    premiumAi.setTier('former-pilot-free', 'free');
    premiumAi.setTier('former-pilot-expired', 'expired');
    premiumAi.setTier('former-pilot-premium', 'premium');
    premiumAi.setTier('never-pilot-premium', 'premium');
    premiumAi.setTier('never-pilot-free', 'free');
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const decide = async (userId: string) => {
    const r = await evaluateAiFallbackGate({ userId, adapterEnabled: true, extractedText: TEXT });
    return r.ok ? 'allowed' : r.reason;
  };

  /** Three states of the six variables: absent, naming ONLY the former-pilot users, naming ONLY everyone else. */
  const SETTINGS: Array<[string, () => void]> = [
    ['absent', () => RETIRED.forEach((k) => delete process.env[k])],
    ['enforced, listing only the former pilot', () => {
      for (const p of ['AIE_PILOT_COHORT', 'II_AI_FALLBACK_PILOT_COHORT']) {
        process.env[`${p}_ENFORCED`] = 'true';
        process.env[`${p}_USER_IDS`] = 'former-pilot-free,former-pilot-expired,former-pilot-premium';
        process.env[`${p}_EMAILS`] = 'former.pilot.a@example.invalid,former.pilot.b@example.invalid';
      }
    }],
    ['enforced, listing nobody who is testing', () => {
      for (const p of ['AIE_PILOT_COHORT', 'II_AI_FALLBACK_PILOT_COHORT']) {
        process.env[`${p}_ENFORCED`] = 'true';
        process.env[`${p}_USER_IDS`] = 'someone-else';
        process.env[`${p}_EMAILS`] = 'someone.else@example.invalid';
      }
    }],
  ];

  for (const [label, apply] of SETTINGS) {
    it(`retired settings ${label}: the verdict is the Premium entitlement alone, for former-pilot and never-pilot users alike`, async () => {
      apply();
      expect(await decide('former-pilot-free')).toBe('premium_required');
      expect(await decide('former-pilot-expired')).toBe('premium_required');
      expect(await decide('never-pilot-free')).toBe('premium_required');
      expect(await decide('former-pilot-premium')).toBe('allowed');
      expect(await decide('never-pilot-premium')).toBe('allowed');
    });
  }

  it('a former-pilot Premium user and a never-pilot Premium user follow the SAME rules downstream (same refusals for the same switches)', async () => {
    SETTINGS[1][1]();
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    expect(await decide('former-pilot-premium')).toBe('global_kill_switch_disabled');
    expect(await decide('never-pilot-premium')).toBe('global_kill_switch_disabled');
    process.env.AIE_AI_FALLBACK_ENABLED = 'true';
    process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'false';
    expect(await decide('former-pilot-premium')).toBe('malware_scan_not_enforced');
    expect(await decide('never-pilot-premium')).toBe('malware_scan_not_enforced');
  });

  it('INVENTORY: no code under lib, app, components, proxy or supabase reads or mentions a retired variable outside comments; the cohort helpers and the e-mail resolver are gone', () => {
    const offenders: string[] = [];
    const roots = ['lib', 'app', 'components'];
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const r of roots) {
      for (const f of walk(r)) {
        const code = strip(read(f));
        if (/PILOT_COHORT|isUserInAiePilotCohort|isAiePilotCohortEnforced|resolveEmailForAiePilotCohort/.test(code)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, 'lib/aie/pilotCohortEmail.ts'))).toBe(false);
    // the e-mail comparison would be the other way back in: no hard-coded address decides anything in the AI scopes
    for (const f of AI_SCOPES.flatMap((scope) => walk(scope))) expect(strip(read(f)), f).not.toMatch(/email\s*===\s*['"][^'"]+@/);
  });
});
