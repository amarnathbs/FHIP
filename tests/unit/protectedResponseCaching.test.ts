// Responses that a shared cache must never keep (26-11-2026).
//
// On production the static /onboarding page (`s-maxage=31536000`) was saved by the CDN and served to a user with a complete profile 29 hours later, without proxy.ts running. A local reproduction of
// the same build also showed a refreshed session cookie going out on a publicly cacheable page and being replayed to a visitor who was not signed in.
//
// NAMED NEGATIVE CONTROLS
//   NC-C1  every way the proxy can answer a signed-in app route is private: pass-through, each redirect, and the signed-out redirect;
//   NC-C2  a public page whose response writes a session cookie is private;
//   NC-C3  any request that carries a session cookie (API calls, the OAuth callback's code verifier, a signed-in visit to a public page) is private;
//   NC-C4  an anonymous public page keeps its normal caching (the proxy sets no Cache-Control on it);
//   NC-C5  /onboarding is rendered per request, never prerendered.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';

type Read = { data: unknown; error: { code?: string; message?: string } | null };
let signedIn = true;
let read: Read;
let refreshCookieOnGetUser = false;

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (c: Array<{ name: string; value: string }>) => void } }) => ({
    auth: {
      getUser: async () => {
        if (refreshCookieOnGetUser) options.cookies.setAll([{ name: 'sb-test-auth-token', value: 'refreshed' }]);
        return { data: { user: signedIn ? { id: 'user-1' } : null } };
      },
    },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => read }) }) }),
  }),
}));
vi.mock('@/lib/services/countryGate', () => ({ loadCountryRegistrySnapshot: async () => new Map([['GB', { experienceLevel: 'GENERIC' }]]) }));

import { proxy } from '../../proxy';
import { mustNotBeShared, PRIVATE_CACHE_CONTROL } from '@/lib/services/responseCaching';

const call = (path: string, cookie?: string) => proxy(new NextRequest(`http://app.test${path}`, cookie ? { headers: { cookie } } : undefined));
const profile = (over: Record<string, unknown>): Read => ({ data: { onboarding_completed: true, country_of_residence: 'AU', country_confirmed_at: '2026-08-04T00:00:00Z', ...over }, error: null });
const noRow: Read = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
const failed: Read = { data: null, error: { code: 'PGRST303', message: 'JWT issued at future' } };

describe('proxy: responses a shared cache must never keep', () => {
  beforeEach(() => {
    signedIn = true;
    read = profile({});
    refreshCookieOnGetUser = false;
  });

  it.each([
    ['pass-through for a completed user', '/dashboard', profile({}), null],
    ['the blank wizard for a user with no profile (the response the CDN saved)', '/onboarding', noRow, null],
    ['a completed user leaving /onboarding', '/onboarding', profile({}), '/dashboard'],
    ['a not-onboarded user sent to /onboarding', '/dashboard', noRow, '/onboarding'],
    ['a failed read sent to /session-check', '/onboarding', failed, '/session-check'],
    ['a generic-experience user sent to /global-setup', '/dashboard', profile({ country_of_residence: 'GB' }), '/global-setup'],
  ])('NC-C1: %s is private', async (_label, path, result, destination) => {
    read = result;
    const res = await call(path);
    const to = res.headers.get('location');
    expect(to ? new URL(to).pathname : null).toBe(destination);
    expect(res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('NC-C1: the signed-out redirect from an app route is private', async () => {
    signedIn = false;
    const res = await call('/onboarding');
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
  });

  it.each(['/login', '/terms', '/'])('NC-C2: a refreshed session cookie makes the public page %s private', async (path) => {
    refreshCookieOnGetUser = true;
    const res = await call(path);
    expect(res.cookies.getAll().length).toBeGreaterThan(0);
    expect(res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
  });

  it.each([
    ['/login', 'sb-abc-auth-token=x'],
    ['/api/user/profile', 'sb-abc-auth-token.0=x; sb-abc-auth-token.1=y'],
    ['/auth/callback?code=1', 'sb-abc-auth-token-code-verifier=x'],
  ])('NC-C3: a request for %s that carries a session cookie is private', async (path, cookie) => {
    const res = await call(path, cookie);
    expect(res.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
  });

  it.each([
    ['/login', undefined],
    ['/terms', 'fhip_landing_country=AU'],
    ['/', undefined],
  ])('NC-C4: an anonymous visit to %s keeps its normal caching', async (path, cookie) => {
    signedIn = false;
    const res = await call(path, cookie);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('the rule itself: any one fact is enough, and none means shareable', () => {
    const none = { isAppRoute: false, requestCookieNames: ['theme'], responseCookieCount: 0 };
    expect(mustNotBeShared(none)).toBe(false);
    expect(mustNotBeShared({ ...none, isAppRoute: true })).toBe(true);
    expect(mustNotBeShared({ ...none, responseCookieCount: 1 })).toBe(true);
    expect(mustNotBeShared({ ...none, requestCookieNames: ['sb-abc-auth-token'] })).toBe(true);
    expect(PRIVATE_CACHE_CONTROL).toMatch(/private/);
    expect(PRIVATE_CACHE_CONTROL).toMatch(/no-store/);
    expect(PRIVATE_CACHE_CONTROL).not.toMatch(/s-maxage|public/);
  });

  it('NC-C5: /onboarding is rendered per request, never prerendered', () => {
    const source = fs.readFileSync('app/(onboarding)/onboarding/page.tsx', 'utf8');
    expect(source).toMatch(/^export const dynamic = 'force-dynamic';$/m);
  });
});
