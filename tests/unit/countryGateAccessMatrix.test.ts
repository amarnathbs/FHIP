// Mandatory Country Confirmation, round-2 closure — item 5: an EXECUTABLE
// proof (not just an assertion) that every account function spec section
// 1.2 requires to stay reachable pre-confirmation actually IS reachable, for
// a user in every one of the 4 non-CONFIRMED states, and that a genuinely
// protected route is correctly NOT reachable in those same states — so the
// distinction this whole feature depends on is real, not assumed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const USER_ID = 'user-under-test';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

// countryAudit writes via the service-role client — never exercised for
// real in this unit test; mocked to a no-op so a missing-env-var
// createAdminClient() throw (expected in a test environment) can't leak
// into the assertions below. recordCountryAuditEvent already swallows this
// itself in production code (never lets audit failure break the primary
// request) — this mock just keeps the test's own console output clean.
vi.mock('@/lib/services/countryAudit', () => ({
  recordCountryAuditEvent: vi.fn(async () => undefined),
}));

import { GET as stateGET } from '@/app/api/user/country/state/route';
import { POST as confirmPOST } from '@/app/api/user/country/confirm/route';
import { GET as incomeGET } from '@/app/api/income/route';

type ProfileRow = {
  country_of_residence: string | null;
  country_confirmed_at: string | null;
  country_source: string | null;
  onboarding_completed: boolean;
};

const STATES: Record<string, ProfileRow> = {
  COUNTRY_MISSING: { country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: true },
  COUNTRY_UNCONFIRMED: { country_of_residence: 'AU', country_confirmed_at: null, country_source: null, onboarding_completed: true },
  COUNTRY_UNSUPPORTED: { country_of_residence: 'NZ', country_confirmed_at: '2026-01-01T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true },
  COUNTRY_INVALID: { country_of_residence: '###', country_confirmed_at: null, country_source: null, onboarding_completed: true },
};

// Builds a fake Supabase client's .from() implementation for a given
// profile-state fixture. Handles both the read-only shape the state/income
// routes use (select().eq().maybeSingle()) and the update shape the confirm
// route uses (select().eq().maybeSingle() for its pre-read, then
// update().eq().select().single() for the write).
function fakeFromFor(profile: ProfileRow) {
  return (table: string) => {
    if (table !== 'user_profiles') throw new Error(`unexpected table in this test: ${table}`);
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: profile, error: null }),
        }),
      }),
      update: (patch: Partial<ProfileRow>) => ({
        eq: () => ({
          select: () => ({
            single: async () => ({ data: { ...profile, ...patch }, error: null }),
          }),
        }),
      }),
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

describe('MC-13/MC-14 — narrowly-required pre-confirmation endpoints stay reachable in every non-CONFIRMED state', () => {
  for (const [stateName, profile] of Object.entries(STATES)) {
    it(`GET /api/user/country/state returns 200 while the caller is ${stateName}`, async () => {
      mockFrom.mockImplementation(fakeFromFor(profile));
      const res = await stateGET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.state).toBe(stateName);
    });

    it(`POST /api/user/country/confirm succeeds (200) while the caller starts as ${stateName}`, async () => {
      mockFrom.mockImplementation(fakeFromFor(profile));
      const res = await confirmPOST(
        new Request('http://test/api/user/country/confirm', {
          method: 'POST',
          body: JSON.stringify({ country_of_residence: 'AU' }),
        })
      );
      expect(res.status).toBe(200);
    });
  }
});

describe('MC-04/06-09 contrast — the SAME 4 states correctly block a genuinely protected route', () => {
  for (const [stateName, profile] of Object.entries(STATES)) {
    it(`GET /api/income is blocked while the caller is ${stateName} (proves the distinction above is real, not accidental)`, async () => {
      mockFrom.mockImplementation(fakeFromFor(profile));
      const res = await incomeGET();
      expect(res.status).not.toBe(200);
      const body = await res.json();
      expect(['COUNTRY_CONFIRMATION_REQUIRED', 'COUNTRY_UNSUPPORTED', 'COUNTRY_INVALID']).toContain(body.error);
    });
  }

  it('GET /api/income succeeds once CONFIRMED, using the identical harness', async () => {
    // income's registry.list() also calls .from('income_sources') — extend
    // the fake for this one test only (real chain: select().eq().eq().order()).
    const confirmed = { country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
    const base = fakeFromFor(confirmed);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'income_sources') {
        return { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }) };
      }
      return base(table);
    });
    const res = await incomeGET();
    expect(res.status).toBe(200);
  });
});

describe('MC-12 — Sign out is never gated by the country-confirmation check', () => {
  // Real source inspection at test time (not a hand-maintained duplicate
  // assumption) — this test would fail the moment anyone added a
  // countryConfirmationBlockResponse/requireCountryConfirmedUser call ahead
  // of a signOut() call in either of the two places the app signs a user
  // out from.
  const filesWithSignOut = [
    path.resolve(__dirname, '../../components/ui/AppShell.tsx'),
    path.resolve(__dirname, '../../app/(onboarding)/confirm-country/ConfirmCountryForm.tsx'),
  ];

  for (const file of filesWithSignOut) {
    it(`${path.basename(file)}'s sign-out path calls supabase.auth.signOut() with no preceding country-gate call`, () => {
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toMatch(/auth\.signOut\(\)/);
      // The gate functions are never imported into either file that performs
      // sign-out — if they were, sign-out could not be spec-compliant
      // ("Missing country -> Sign out -> Allowed" unconditionally).
      expect(src).not.toMatch(/requireCountryConfirmedUser|countryConfirmationBlockResponse|assertCountryConfirmedForUser/);
    });
  }
});

describe('MC-13 — Privacy/Terms pages are never reachable through, or gated by, the country-confirmation machinery', () => {
  const marketingPages = [
    path.resolve(__dirname, '../../app/(marketing)/privacy'),
    path.resolve(__dirname, '../../app/(marketing)/terms'),
  ];

  for (const dir of marketingPages) {
    it(`no file under ${path.basename(dir)}/ imports the country gate`, () => {
      expect(fs.existsSync(dir)).toBe(true);
      const files = fs.readdirSync(dir, { recursive: true }) as string[];
      const tsFiles = files.filter((f) => /\.(ts|tsx)$/.test(f));
      expect(tsFiles.length).toBeGreaterThan(0);
      for (const f of tsFiles) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        expect(src).not.toMatch(/requireCountryConfirmedUser|countryConfirmationBlockResponse|assertCountryConfirmedForUser/);
      }
    });
  }

  it("proxy.ts's isAppRoute regex (extracted from the real source, not a hand-copied duplicate) does not match /privacy, /terms, /login or /signup, but DOES match /confirm-country", () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../proxy.ts'), 'utf8');
    // Matches the exact literal text /^\/(...)/ proxy.ts's isAppRoute regex
    // is written as — extracting the alternation list from the real source
    // rather than hand-copying it, so this test breaks (not silently
    // drifts) if that regex is ever rewritten.
    const match = src.match(/\/\^\\\/\(([^)]+)\)\//);
    expect(match).not.toBeNull();
    const regex = new RegExp(`^/(${match![1]})`);
    expect(regex.test('/privacy')).toBe(false);
    expect(regex.test('/terms')).toBe(false);
    expect(regex.test('/login')).toBe(false);
    expect(regex.test('/signup')).toBe(false);
    expect(regex.test('/confirm-country')).toBe(true);
    expect(regex.test('/dashboard')).toBe(true);
  });
});

describe('MC-15 — Account deletion: "if currently supported" — verified still NOT supported, so nothing to gate or leave open', () => {
  it('no account/user-deletion API route exists anywhere under app/api', () => {
    const apiRoot = path.resolve(__dirname, '../../app/api');
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name === 'route.ts') out.push(full);
      }
      return out;
    }
    const suspects = walk(apiRoot).filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return /deleteUser|auth\.admin\.deleteUser|DELETE.*account|deleteAccount/i.test(src) && /user|account/i.test(f);
    });
    // Documents the current true state rather than asserting a guess — if
    // this ever finds a real candidate, the closure report's "not currently
    // supported" claim needs updating, not this test.
    expect(suspects).toEqual([]);
  });
});

describe('MC-16 — every authenticated API route is country-gated (reconciliation regression guard)', () => {
  // Added by the terminal certification (2026-08-31) after reconciling this
  // branch onto origin/main 2ade18b. That merge brought in 15 brand-new
  // FDH-11/FDH-12 routes under app/api/financial-data-hub/{investment,
  // retirement}-statement/** that imported the UNGATED `requireUser` — so an
  // authenticated user with no confirmed country could have driven the whole
  // statement upload/approve/apply pipeline through the API layer. The same
  // class of gap was closed by hand once before (commit d77b8c3, "gate new
  // FDH-10 routes") and then silently reappeared with the next module merge,
  // which is precisely why this needs to be a test rather than a review step.
  //
  // This walks the REAL app/api tree at test time, so any future route that
  // lands using the ungated helper fails here instead of shipping.
  const apiRoot = path.resolve(__dirname, '../../app/api');

  function walkRoutes(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkRoutes(full));
      else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
  }

  // The ONE legitimate exemption: a pg_cron-triggered endpoint that has no
  // user session at all and authorises via the CRON_SECRET shared secret
  // (see the route's own header comment). It is not reachable by an
  // authenticated browser client, so there is no country to confirm.
  const ALLOWED_UNGATED = new Set([path.join('app', 'api', 'reports', 'cron', 'monthly-generate', 'route.ts')]);

  const routes = walkRoutes(apiRoot);

  it('finds a realistic number of API routes (guards against the walker silently matching nothing)', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('no route.ts imports the ungated requireUser except the documented CRON_SECRET-authorised cron route', () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const src = fs.readFileSync(file, 'utf8');
      if (!/\brequireUser\b/.test(src)) continue;
      if (/requireCountryConfirmedUser/.test(src)) continue;
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      if (ALLOWED_UNGATED.has(rel)) continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the one allowed exemption really is secret-authorised, not merely allowlisted', () => {
    const src = fs.readFileSync(path.resolve(apiRoot, 'reports/cron/monthly-generate/route.ts'), 'utf8');
    expect(src).toMatch(/process\.env\.CRON_SECRET/);
    expect(src).toMatch(/x-cron-secret/);
    // And it must not quietly gain a user-session path later.
    expect(src).not.toMatch(/auth\.getUser\(\)/);
  });
});
