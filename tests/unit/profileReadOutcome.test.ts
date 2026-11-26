// A failed profile read is not a missing profile (25-11-2026). Pure parts: the classification, the only destinations the retry page may send a visitor to, and the bounded, spaced retries.
//
// NAMED NEGATIVE CONTROLS
//   NC-O1  only the database's own "no row" answer (PGRST116) means "missing"; a 401 on a fresh token (PGRST303), a timeout, a schema-cache reload and a network failure are "failed";
//   NC-O2  the retry page can never be an open redirect or a loop: only a same-origin path is accepted;
//   NC-O3  the retries are bounded (four, spaced) and then stop; an old failure never shortens a new visit's tries.
import { describe, expect, it } from 'vitest';
import {
  classifyProfileRead,
  nextCheckStep,
  parseSessionCheckState,
  safeInternalPath,
  sessionCheckUrl,
  SESSION_CHECK_DELAYS_MS,
  SESSION_CHECK_MAX_ATTEMPTS,
  SESSION_CHECK_RESET_MS,
} from '@/lib/services/profileReadOutcome';

describe('classifyProfileRead', () => {
  it('a row is "read"; an empty row with no error is "missing" (the earlier behaviour)', () => {
    expect(classifyProfileRead({ onboarding_completed: true }, null)).toBe('read');
    expect(classifyProfileRead(null, null)).toBe('missing');
    expect(classifyProfileRead(null, undefined)).toBe('missing');
  });

  it('NC-O1: PGRST116 (no row, or not exactly one) is the only error that means "missing"', () => {
    expect(classifyProfileRead(null, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toBe('missing');
  });

  it.each([
    ['the 25-11-2026 production failure: a token issued seconds earlier', { code: 'PGRST303', message: 'JWT issued at future' }],
    ['an invalid token', { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }],
    ['a schema-cache reload', { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }],
    ['a network failure with no code', { message: 'TypeError: fetch failed' }],
    ['an empty code', { code: '', message: 'boom' }],
    ['a database timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
  ])('NC-O1: %s is "failed", never "no profile"', (_label, error) => {
    expect(classifyProfileRead(null, error)).toBe('failed');
    // even when the client also returns stale row data next to the error
    expect(classifyProfileRead({ onboarding_completed: true }, error)).toBe('failed');
  });
});

describe('safeInternalPath', () => {
  it('accepts same-origin paths, with a query or a fragment', () => {
    expect(safeInternalPath('/dashboard')).toBe('/dashboard');
    expect(safeInternalPath('/dashboard?tab=a&x=1')).toBe('/dashboard?tab=a&x=1');
    expect(safeInternalPath('/reports/123#top')).toBe('/reports/123#top');
    expect(safeInternalPath('/onboarding')).toBe('/onboarding');
  });

  it.each([
    ['//evil.example'], ['//evil.example/path'], ['/\\evil.example'], ['https://evil.example'], ['http://evil.example/x'], ['javascript:alert(1)'], ['data:text/html,x'],
    ['evil.example'], [''], ['dashboard'], ['/da\u0000shboard'], ['/da\nshboard'], ['/dash\\board'], ['/' + 'a'.repeat(600)],
  ])('NC-O2: %j becomes the fallback', (value) => {
    expect(safeInternalPath(value)).toBe('/dashboard');
    expect(safeInternalPath(value, '/login')).toBe('/login');
  });

  it('NC-O2: null and undefined become the fallback, and the check page can never point at itself', () => {
    expect(safeInternalPath(null)).toBe('/dashboard');
    expect(safeInternalPath(undefined)).toBe('/dashboard');
    expect(safeInternalPath('/session-check')).toBe('/dashboard');
    expect(safeInternalPath('/session-check?next=%2Fdashboard')).toBe('/dashboard');
    expect(safeInternalPath('/session-check/anything')).toBe('/dashboard');
    expect(safeInternalPath('/session-checkout')).toBe('/session-checkout'); // a different path that merely starts with the same letters
  });

  it('sessionCheckUrl carries the destination, encoded, and sanitises it', () => {
    expect(sessionCheckUrl('/dashboard')).toBe('/session-check?next=%2Fdashboard');
    expect(sessionCheckUrl('/dashboard?x=1&y=2')).toBe('/session-check?next=%2Fdashboard%3Fx%3D1%26y%3D2');
    expect(sessionCheckUrl('//evil.example')).toBe('/session-check?next=%2Fdashboard');
  });
});

describe('nextCheckStep: bounded, spaced retries', () => {
  const T0 = 1_800_000_000_000;

  it('NC-O3: four retries with growing waits, then it gives up and stays given up', () => {
    let state: { n: number; t: number } | null = null;
    const delays: number[] = [];
    for (let i = 1; i <= SESSION_CHECK_MAX_ATTEMPTS; i += 1) {
      const step = nextCheckStep(state, T0 + i * 1000);
      expect(step.action).toBe('retry');
      expect(step.attempt).toBe(i);
      if (step.action === 'retry') delays.push(step.delayMs);
      state = step.state;
    }
    expect(delays).toEqual([...SESSION_CHECK_DELAYS_MS]);
    const fifth = nextCheckStep(state, T0 + 10_000);
    expect(fifth.action).toBe('give_up');
    const sixth = nextCheckStep(fifth.state, T0 + 11_000);
    expect(sixth.action).toBe('give_up'); // a reload of the final screen does not start the tries again
  });

  it('the first wait is longer than the 4 seconds seen on production, and the whole sequence is bounded', () => {
    expect(SESSION_CHECK_DELAYS_MS[0]).toBeGreaterThanOrEqual(5_000);
    expect(SESSION_CHECK_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
    for (let i = 1; i < SESSION_CHECK_DELAYS_MS.length; i += 1) expect(SESSION_CHECK_DELAYS_MS[i]).toBeGreaterThanOrEqual(SESSION_CHECK_DELAYS_MS[i - 1]);
  });

  it('NC-O3: after two quiet minutes the counter starts again', () => {
    const last = nextCheckStep({ n: SESSION_CHECK_MAX_ATTEMPTS - 1, t: T0 }, T0 + 1000);
    expect(last.action).toBe('retry'); // the fourth and last try
    expect(nextCheckStep({ n: SESSION_CHECK_MAX_ATTEMPTS, t: T0 }, T0 + 1000).action).toBe('give_up'); // four already made, within the window
    const again = nextCheckStep({ n: 5, t: T0 }, T0 + SESSION_CHECK_RESET_MS + 1);
    expect(again.action).toBe('retry');
    expect(again.attempt).toBe(1);
  });

  it('missing, clock-skewed and garbage state all start at the first attempt', () => {
    expect(nextCheckStep(null, T0).attempt).toBe(1);
    expect(nextCheckStep(undefined, T0).attempt).toBe(1);
    expect(nextCheckStep({ n: 3, t: T0 + 60_000 }, T0).attempt).toBe(1); // stored time in the future
    expect(nextCheckStep({ n: Number.NaN, t: T0 }, T0 + 10).attempt).toBe(1);
    expect(nextCheckStep({ n: -4, t: T0 }, T0 + 10).attempt).toBe(1);
  });

  it('parseSessionCheckState tolerates anything the browser storage can hold', () => {
    expect(parseSessionCheckState('{"n":2,"t":5}')).toEqual({ n: 2, t: 5 });
    for (const bad of [null, undefined, '', 'not json', '[]', '{"n":"2","t":5}', '{"n":2}', '42']) expect(parseSessionCheckState(bad as string | null | undefined)).toBeNull();
  });
});
