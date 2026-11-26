// proxy.ts -- a failed profile read is not a missing profile (25-11-2026).
//
// On production (13-11 and 25-11-2026) a signed-in user with a COMPLETE profile was sent to /onboarding and shown a blank wizard asking for everything again. The Supabase edge log of the
// second time: GET /auth/v1/user 200, then GET /rest/v1/user_profiles 401 (PostgREST error PGRST303) for a token issued 4 seconds earlier. The row was intact; the read failed.
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  a failed read on an app page goes to /session-check (never to the blank wizard) and still carries the diagnostic header;
//   NC-R2  a failed read on /onboarding does not serve the wizard either: it goes to /session-check as well;
//   NC-R3  the database's own "no row" answer (PGRST116) is unchanged: an app page still goes to /onboarding, /onboarding still stays, and there is no retry;
//   NC-R4  a failure that clears on the quick second try changes nothing for the visitor (no redirect, no header);
//   NC-R5  the visitor's destination, query string included, travels with the redirect, and only as a same-origin path;
//   NC-R6  a session cookie refreshed on this very request travels with the redirect (it is not lost);
//   NC-R7  /session-check itself is never gated or redirected by the proxy (no loop), and a signed-out visitor is untouched.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Read = { data: unknown; error: { code?: string; message?: string } | null };
let signedIn = true;
let reads: Read[] = [];
let readCalls = 0;
let refreshCookieOnGetUser = false;

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (c: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void } }) => ({
    auth: {
      getUser: async () => {
        if (refreshCookieOnGetUser) options.cookies.setAll([{ name: 'sb-test-auth-token', value: 'refreshed', options: { path: '/', httpOnly: true } }]);
        return { data: { user: signedIn ? { id: 'user-1' } : null } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            const r = reads[Math.min(readCalls, reads.length - 1)];
            readCalls += 1;
            return r;
          },
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/services/countryGate', () => ({ loadCountryRegistrySnapshot: async () => null }));

import { proxy } from '../../proxy';
import { PROFILE_READ_HEADER } from '@/lib/services/profileReadDiagnostic';

const call = (path: string) => proxy(new NextRequest(`http://app.test${path}`));
const completed: Read = { data: { onboarding_completed: true, country_of_residence: 'AU', country_confirmed_at: '2026-08-04T00:00:00Z' }, error: null };
const tokenTooNew: Read = { data: null, error: { code: 'PGRST303', message: 'JWT issued at future' } };
const noRow: Read = { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
const where = (res: Response) => { const l = res.headers.get('location'); return l ? new URL(l) : null; };

describe('proxy: a failed profile read is not a missing profile', () => {
  beforeEach(() => {
    signedIn = true;
    reads = [completed];
    readCalls = 0;
    refreshCookieOnGetUser = false;
  });

  it('NC-R1: the 25-11-2026 production failure (a token the data API refuses) sends an app page to /session-check, not to the blank wizard', async () => {
    reads = [tokenTooNew];
    const res = await call('/dashboard');
    expect(res.status).toBe(307);
    const to = where(res)!;
    expect(to.pathname).toBe('/session-check');
    expect(to.searchParams.get('next')).toBe('/dashboard');
    expect(to.pathname).not.toBe('/onboarding');
    expect(res.headers.get(PROFILE_READ_HEADER)).toBe('PGRST303: JWT issued at future');
  });

  it.each([
    ['a network failure with no code', { message: 'TypeError: fetch failed' }],
    ['a schema-cache reload', { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }],
    ['an invalid token', { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }],
    ['a database timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
  ])('NC-R1: %s is also a failed read, never "no profile"', async (_label, error) => {
    reads = [{ data: null, error }];
    const res = await call('/income');
    expect(res.status).toBe(307);
    expect(where(res)!.pathname).toBe('/session-check');
  });

  it('NC-R2: a failed read on /onboarding does not serve the blank wizard either', async () => {
    reads = [tokenTooNew];
    const res = await call('/onboarding');
    expect(res.status).toBe(307);
    const to = where(res)!;
    expect(to.pathname).toBe('/session-check');
    expect(to.searchParams.get('next')).toBe('/onboarding');
    expect(res.headers.get(PROFILE_READ_HEADER)).toBe('PGRST303: JWT issued at future');
  });

  it('NC-R3: the database answering "no row" (PGRST116) is unchanged: an app page goes to /onboarding, /onboarding stays, and nothing is retried', async () => {
    reads = [noRow];
    const dash = await call('/dashboard');
    expect(dash.status).toBe(307);
    expect(where(dash)!.pathname).toBe('/onboarding');
    expect(readCalls).toBe(1);
    readCalls = 0;
    const stay = await call('/onboarding');
    expect(stay.status).toBe(200);
    expect(stay.headers.get('location')).toBeNull();
    expect(readCalls).toBe(1);
  });

  it('NC-R3: an empty read with no error at all is still "no profile" (the earlier behaviour)', async () => {
    reads = [{ data: null, error: null }];
    const dash = await call('/dashboard');
    expect(where(dash)!.pathname).toBe('/onboarding');
  });

  it('NC-R4: a failure that clears on the quick second try changes nothing for the visitor', async () => {
    reads = [tokenTooNew, completed];
    const dash = await call('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.headers.get('location')).toBeNull();
    expect(dash.headers.get(PROFILE_READ_HEADER)).toBeNull();
    expect(readCalls).toBe(2);
    readCalls = 0;
    const away = await call('/onboarding'); // a completed profile still leaves /onboarding for /dashboard
    expect(where(away)!.pathname).toBe('/dashboard');
  });

  it('NC-R4: a persistent failure is tried exactly twice (not an endless loop inside the proxy)', async () => {
    reads = [tokenTooNew];
    await call('/dashboard');
    expect(readCalls).toBe(2);
  });

  it('NC-R5: the query string travels with the destination, encoded, as a same-origin path', async () => {
    reads = [tokenTooNew];
    const res = await call('/reports/abc?tab=summary&x=1');
    expect(where(res)!.searchParams.get('next')).toBe('/reports/abc?tab=summary&x=1');
    expect(where(res)!.origin).toBe('http://app.test');
  });

  it('NC-R6: a session cookie refreshed on this very request is carried on the redirect', async () => {
    reads = [tokenTooNew];
    refreshCookieOnGetUser = true;
    const res = await call('/dashboard');
    expect(res.status).toBe(307);
    expect(res.cookies.get('sb-test-auth-token')?.value).toBe('refreshed');
  });

  it('NC-R7: /session-check is not an app route: no read, no redirect, no loop', async () => {
    reads = [tokenTooNew];
    const res = await call('/session-check?next=%2Fdashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(readCalls).toBe(0);
  });

  it('NC-R7: a signed-out visitor is untouched (still /login, no read)', async () => {
    signedIn = false;
    const res = await call('/dashboard');
    expect(res.status).toBe(307);
    expect(where(res)!.pathname).toBe('/login');
    expect(readCalls).toBe(0);
  });

  it('a successful read is exactly as before: no redirect, no header', async () => {
    const res = await call('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get(PROFILE_READ_HEADER)).toBeNull();
    expect(readCalls).toBe(1);
  });
});
