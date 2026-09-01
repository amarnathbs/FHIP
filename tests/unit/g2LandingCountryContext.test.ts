import { describe, it, expect, afterEach } from 'vitest';
import {
  computeLandingCountryContext,
  normalizeLandingCountryCode,
  isKnownLandingCountry,
  serializeLandingCountryCookie,
  parseLandingCountryCookie,
  readRawDetectedCountry,
  isTestDetectionHeaderAllowed,
  LANDING_DETECTED_COUNTRY_HEADER,
  LANDING_TEST_DETECTED_COUNTRY_HEADER,
  type LandingCountryRegistrySnapshot,
} from '@/lib/services/landingCountryContext';

// Mirrors the exact G1 registry seed (migration 0122): AU/IN = FULL,
// GB/US/SG/AE = GENERIC. This fixture is the ONLY place this test file
// hardcodes registry shape — computeLandingCountryContext itself never
// hardcodes a country list, it only ever reads this injected snapshot.
function registryFixture(): LandingCountryRegistrySnapshot {
  return {
    experienceByCountry: new Map([
      ['AU', 'FULL'],
      ['IN', 'FULL'],
      ['GB', 'GENERIC'],
      ['US', 'GENERIC'],
      ['SG', 'GENERIC'],
      ['AE', 'GENERIC'],
    ]),
  };
}

function headersFixture(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

const notAuthenticated = { isAuthenticated: false, primaryCountry: null, billingConfirmed: false };

describe('G2 landing country context — 20-scenario matrix (spec section 13)', () => {
  const registry = registryFixture();

  it('G2-01: anonymous visitor detected in AU -> AU presentation, presentation-only', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'DETECTED_REQUEST', isAuthoritative: false, billingConfirmed: false, pricingRegion: 'AU' });
  });

  it('G2-02: anonymous visitor detected in IN -> IN presentation, presentation-only', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'DETECTED_REQUEST', pricingRegion: 'IN', billingConfirmed: false });
  });

  it.each(['GB', 'US', 'SG', 'AE'])('G2-03..06: anonymous visitor detected in %s -> generic presentation, presentation-only', (code) => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: code,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx.presentationCountry).toBe(code);
    expect(ctx.experienceLevel).toBe('GENERIC');
    expect(ctx.pricingRegion).toBe('GENERIC');
    expect(ctx.billingConfirmed).toBe(false);
    expect(ctx.isAuthoritative).toBe(false);
  });

  it('G2-07: anonymous visitor, unsupported detected country -> generic fallback, no authority', () => {
    const normalized = normalizeLandingCountryCode('ZZ');
    const detected = isKnownLandingCountry(normalized, registry) ? normalized : null;
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: detected,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: null, source: 'GENERIC_FALLBACK', pricingRegion: 'UNAVAILABLE' });
  });

  it('G2-08: no trusted country signal at all -> generic fallback / neutral prompt (no PO-approved platform default configured)', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: null,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: null, source: 'GENERIC_FALLBACK', experienceLevel: 'GENERIC', pricingRegion: 'UNAVAILABLE', billingConfirmed: false });
  });

  it('G2-08b: platform-default tier is real when a PO value IS configured (proves tier 4 is reachable, not dead code)', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: null,
      platformDefaultCountry: 'AU',
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'PLATFORM_DEFAULT' });
  });

  it('G2-09: manual IN selection overrides detected AU -> IN presentation, no billing confirmation', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'IN',
      detectedCountry: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'ANONYMOUS_SELECTION', billingConfirmed: false });
  });

  it('G2-10: manual AU selection overrides detected IN -> AU presentation, no billing confirmation', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'AU',
      detectedCountry: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'ANONYMOUS_SELECTION', billingConfirmed: false });
  });

  it('G2-11: malformed/forged cookie is ignored, falls through to detected AU, no authority', () => {
    // parseLandingCountryCookie is exercised directly here (forgery surface).
    const forged = parseLandingCountryCookie('not-valid-base64!!!', registry);
    expect(forged).toBeNull();
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: forged,
      detectedCountry: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'DETECTED_REQUEST' });
  });

  it('G2-12: forged/unsupported detected-country header resolves to safe fallback, no authority', () => {
    const rawForged = 'A1'; // MaxMind-style anonymizer pseudo-code -- never a real registry member
    const normalized = normalizeLandingCountryCode(rawForged);
    const detected = isKnownLandingCountry(normalized, registry) ? normalized : null;
    expect(detected).toBeNull();
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountry: detected,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: null, source: 'GENERIC_FALLBACK' });
  });

  it('G2-13: authenticated AU user travelling (detected IN, cookie IN) -> confirmed AU wins', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'AU', billingConfirmed: false },
      anonymousSelection: 'IN',
      detectedCountry: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'AUTHENTICATED_PRIMARY', experienceLevel: 'FULL' });
  });

  it('G2-14: authenticated IN user travelling (detected AU, cookie AU) -> confirmed IN wins', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'IN', billingConfirmed: false },
      anonymousSelection: 'AU',
      detectedCountry: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'AUTHENTICATED_PRIMARY', experienceLevel: 'FULL' });
  });

  it('G2-15: authenticated GB (generic) user -> GB generic experience wins over any anonymous/detected signal', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'GB', billingConfirmed: false },
      anonymousSelection: 'IN',
      detectedCountry: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'GB', source: 'AUTHENTICATED_PRIMARY', experienceLevel: 'GENERIC', pricingRegion: 'GENERIC' });
  });

  it('G2-16: unconfirmed account (primaryCountry null) behaves as anonymous for landing presentation (MCC gate is a separate, untouched mechanism)', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: null, billingConfirmed: false },
      anonymousSelection: null,
      detectedCountry: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'DETECTED_REQUEST' });
  });

  it('G2-17: anonymous detected IN, manual GB selection -> generic/GB presentation, no India billing implied', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'GB',
      detectedCountry: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'GB', source: 'ANONYMOUS_SELECTION', pricingRegion: 'GENERIC', billingConfirmed: false });
  });

  it('G2-18: anonymous detected GB, manual IN selection -> India presentation, no India billing', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'IN',
      detectedCountry: 'GB',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'ANONYMOUS_SELECTION', pricingRegion: 'IN', billingConfirmed: false });
  });

  it('G2-19: returning anonymous visitor, IP now detected as a different country -> stored manual AU selection still wins', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'AU',
      detectedCountry: 'IN', // changed "IP" this visit
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'ANONYMOUS_SELECTION' });
  });

  it('G2-20: signed-in after anonymous selection -> authenticated primary wins, cookie cannot override', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'AU', billingConfirmed: true },
      anonymousSelection: 'IN', // prior anonymous cookie, now stale
      detectedCountry: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'AUTHENTICATED_PRIMARY', billingConfirmed: true });
  });
});

describe('G2 cookie security (spec section 8) — forgery cannot grant authority', () => {
  const registry = registryFixture();

  it('a validly-serialized cookie round-trips to its own country', () => {
    const cookie = serializeLandingCountryCookie('IN');
    expect(parseLandingCountryCookie(cookie, registry)).toBe('IN');
  });

  it('garbage base64 is rejected', () => {
    expect(parseLandingCountryCookie('!!!not-base64!!!', registry)).toBeNull();
  });

  it('valid base64 but non-JSON payload is rejected', () => {
    const raw = Buffer.from('not json', 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw, registry)).toBeNull();
  });

  it('wrong version field is rejected (no silent migration)', () => {
    const raw = Buffer.from(JSON.stringify({ v: 999, country: 'AU', source: 'MANUAL', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw, registry)).toBeNull();
  });

  it('a forged country not in the registry (e.g. "ZZ") is rejected even with an otherwise-valid shape', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, country: 'ZZ', source: 'MANUAL', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw, registry)).toBeNull();
  });

  it('a forged "source" other than MANUAL is rejected', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, country: 'AU', source: 'AUTHENTICATED_PRIMARY', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw, registry)).toBeNull();
  });

  it('missing cookie resolves to null, not an error', () => {
    expect(parseLandingCountryCookie(null, registry)).toBeNull();
    expect(parseLandingCountryCookie(undefined, registry)).toBeNull();
    expect(parseLandingCountryCookie('', registry)).toBeNull();
  });

  it('a forged cookie can never produce anything beyond a non-authoritative presentation value in the full pipeline', () => {
    const raw = Buffer.from(JSON.stringify({ v: 1, country: 'AU', source: 'MANUAL', setAt: new Date().toISOString(), billingConfirmed: true, isAuthoritative: true }), 'utf8').toString('base64url');
    const country = parseLandingCountryCookie(raw, registry);
    expect(country).toBe('AU'); // the extra forged fields are simply ignored -- shape is fixed, not extensible by the client
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: country,
      detectedCountry: null,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx.isAuthoritative).toBe(false);
    expect(ctx.billingConfirmed).toBe(false);
  });
});

describe('G2 detected-country header handling (spec section 6)', () => {
  const originalEnv = process.env.G2_ALLOW_TEST_DETECTION_HEADER;
  afterEach(() => {
    process.env.G2_ALLOW_TEST_DETECTION_HEADER = originalEnv;
  });

  it('reads the canonical CloudFront-Viewer-Country header', () => {
    delete process.env.G2_ALLOW_TEST_DETECTION_HEADER;
    const headers = headersFixture({ [LANDING_DETECTED_COUNTRY_HEADER]: 'AU' });
    expect(readRawDetectedCountry(headers)).toBe('AU');
  });

  it('ignores the test-only header when the allow flag is not set', () => {
    delete process.env.G2_ALLOW_TEST_DETECTION_HEADER;
    expect(isTestDetectionHeaderAllowed()).toBe(false);
    const headers = headersFixture({ [LANDING_TEST_DETECTED_COUNTRY_HEADER]: 'IN' });
    expect(readRawDetectedCountry(headers)).toBeNull();
  });

  it('honours the test-only header only when explicitly enabled', () => {
    process.env.G2_ALLOW_TEST_DETECTION_HEADER = 'true';
    expect(isTestDetectionHeaderAllowed()).toBe(true);
    const headers = headersFixture({ [LANDING_TEST_DETECTED_COUNTRY_HEADER]: 'IN' });
    expect(readRawDetectedCountry(headers)).toBe('IN');
  });

  it('normalizes/validates whatever the header actually contained', () => {
    const registry = registryFixture();
    expect(normalizeLandingCountryCode('au')).toBe('AU');
    expect(normalizeLandingCountryCode('  in ')).toBe('IN');
    expect(normalizeLandingCountryCode('AUS')).toBeNull(); // 3-letter code rejected, not silently truncated
    expect(normalizeLandingCountryCode('')).toBeNull();
    expect(normalizeLandingCountryCode(null)).toBeNull();
    expect(isKnownLandingCountry('ZZ', registry)).toBe(false);
    expect(isKnownLandingCountry('AU', registry)).toBe(true);
  });
});
