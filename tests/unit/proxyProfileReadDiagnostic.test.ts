// proxy.ts -- TEMPORARY DIAGNOSTIC (13-11-2026): when the profile read fails, its error code and a short message go out in a response header,
// and NO decision changes. Found on production: a signed-in user with a completed profile was sent to /onboarding while the database never
// received the profile query, and the proxy had thrown the error away.
//
// NAMED NEGATIVE CONTROLS
//   NC-P1  a failed read puts code + short message in x-fhip-profile-read on the document, on the redirect to /onboarding too;
//   NC-P2  the decisions are exactly the old ones: a failed read still redirects an app page to /onboarding and still stays on /onboarding;
//   NC-P3  a read that works adds no header, and a completed profile still moves from /onboarding to /dashboard;
//   NC-P4  the header never carries more than a code and 100 plain ASCII characters, and nothing but the error text (no row data);
//   NC-P5  a signed-out visitor is untouched.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Read = { data: unknown; error: { code?: string; message?: string } | null };
let signedIn = true;
let read: Read = { data: null, error: null };

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: 'user-1' } : null } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => read }) }) }),
  }),
}));
vi.mock('@/lib/services/countryGate', () => ({ loadCountryRegistrySnapshot: async () => null }));

import { proxy } from '../../proxy';
import { describeProfileReadError, PROFILE_READ_HEADER } from '@/lib/services/profileReadDiagnostic';

const call = (path: string) => proxy(new NextRequest(`http://app.test${path}`));
const completed: Read = { data: { onboarding_completed: true, country_of_residence: 'AU', country_confirmed_at: '2026-08-04T00:00:00Z' }, error: null };

describe('proxy profile read diagnostic', () => {
  beforeEach(() => {
    signedIn = true;
    read = completed;
  });

  it('NC-P1: a failed read tags the response with the code and a short message (document and redirect)', async () => {
    read = { data: null, error: { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' } };
    const onOnboarding = await call('/onboarding');
    expect(onOnboarding.headers.get(PROFILE_READ_HEADER)).toBe('PGRST301: JWSError JWSInvalidSignature');
    const onDashboard = await call('/dashboard');
    expect(onDashboard.headers.get(PROFILE_READ_HEADER)).toBe('PGRST301: JWSError JWSInvalidSignature');
  });

  it('NC-P2: a failed read changes no decision: an app page still goes to /onboarding, /onboarding still stays', async () => {
    read = { data: null, error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } };
    const dash = await call('/dashboard');
    expect(dash.status).toBe(307);
    expect(new URL(dash.headers.get('location')!).pathname).toBe('/onboarding');
    const stay = await call('/onboarding');
    expect(stay.status).toBe(200);
    expect(stay.headers.get('location')).toBeNull();
  });

  it('NC-P3: a read that works adds no header, and a completed profile still leaves /onboarding for /dashboard', async () => {
    const dash = await call('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.headers.get(PROFILE_READ_HEADER)).toBeNull();
    const away = await call('/onboarding');
    expect(away.status).toBe(307);
    expect(new URL(away.headers.get('location')!).pathname).toBe('/dashboard');
    expect(away.headers.get(PROFILE_READ_HEADER)).toBeNull();
  });

  it('NC-P4: the header is a code plus at most 100 plain ASCII characters, whatever the error says', () => {
    const v = describeProfileReadError({ code: 'PGRST3\n01 <>', message: `line one\nline two ${'é中'.repeat(10)} ${'x'.repeat(300)}` });
    expect(v.startsWith('PGRST301: ')).toBe(true);
    expect(v.slice('PGRST301: '.length).length).toBeLessThanOrEqual(100);
    expect(/^[\x20-\x7E]+$/.test(v)).toBe(true);
    expect(describeProfileReadError({ code: null, message: null })).toBe('no_code: ');
    expect(describeProfileReadError({ message: 'fetch failed' })).toBe('no_code: fetch failed');
  });

  it('NC-P4: the row data of a read is never put in the header', async () => {
    read = { data: { onboarding_completed: true, country_of_residence: 'AU' }, error: { code: 'X1', message: 'boom' } };
    const res = await call('/dashboard');
    const header = res.headers.get(PROFILE_READ_HEADER)!;
    expect(header).toBe('X1: boom');
    expect(header).not.toMatch(/AU|onboarding_completed/);
  });

  it('NC-P5: a signed-out visitor still goes to /login with no header', async () => {
    signedIn = false;
    const res = await call('/dashboard');
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(res.headers.get(PROFILE_READ_HEADER)).toBeNull();
  });
});
