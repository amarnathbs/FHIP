import { describe, it, expect, afterEach } from 'vitest';
import {
  computeLandingCountryContext,
  normalizeLandingCountryCode,
  bucketCountryCodeForLanding,
  isPlausibleCountryCode,
  parseLandingCountryCookie,
  serializeLandingCountryCookie,
  readRawDetectedCountry,
  isTestDetectionHeaderAllowed,
  isLandingPresentationCountry,
  toAuthoritativeCountryCodeOrNull,
  LANDING_DETECTED_COUNTRY_HEADER,
  LANDING_TEST_DETECTED_COUNTRY_HEADER,
  LANDING_PRESENTATION_COUNTRIES,
  type LandingCountryRegistrySnapshot,
} from '@/lib/services/landingCountryContext';

// Mirrors the G1 registry's own experience-level facts for AU/IN (migration
// 0122). GB/US/SG/AE/anything-else are never looked up here any more — the
// PO's AU/IN/Global model buckets all of them to 'GLOBAL' before this
// snapshot is ever consulted.
function registryFixture(): LandingCountryRegistrySnapshot {
  return {
    experienceByCountry: new Map([
      ['AU', 'FULL'],
      ['IN', 'FULL'],
    ]),
  };
}

function headersFixture(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

const notAuthenticated = { isAuthenticated: false, primaryCountry: null, billingConfirmed: false };

describe('G2 landing country context — AU/IN/Global model (PO clarification 2026-09-02)', () => {
  const registry = registryFixture();

  it('G2-01: anonymous visitor detected in AU -> AU presentation, presentation-only', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'DETECTED_REQUEST', isAuthoritative: false, billingConfirmed: false, pricingRegion: 'AU' });
  });

  it('G2-02: anonymous visitor detected in IN -> IN presentation, presentation-only', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'DETECTED_REQUEST', pricingRegion: 'IN', billingConfirmed: false });
  });

  it.each(['GB', 'US', 'SG', 'AE'])('G2-03..06: anonymous visitor detected in %s -> GLOBAL presentation (non-AU/IN detection maps to Global)', (code) => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: code,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx.presentationCountry).toBe('GLOBAL');
    expect(ctx.experienceLevel).toBe('GENERIC');
    expect(ctx.pricingRegion).toBe('GLOBAL');
    expect(ctx.billingConfirmed).toBe(false);
    expect(ctx.isAuthoritative).toBe(false);
  });

  it('a valid non-AU/IN country NOT in the old 6-country list (e.g. Germany) also maps to Global (PO table row 3: "another valid non-AU/IN country")', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: 'DE',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'GLOBAL', source: 'DETECTED_REQUEST', pricingRegion: 'GLOBAL' });
  });

  it('G2-07: unsupported/pseudo detected code (not a real country) -> neutral, no preselection, no authority', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: 'ZZ', // ISO 3166-1 reserved "unknown or unspecified country"
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: null, source: 'GENERIC_FALLBACK', pricingRegion: 'UNAVAILABLE' });
  });

  it('G2-08: no trusted country signal at all -> neutral selector, NO preselected country (PO detection table row 4)', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: null, source: 'GENERIC_FALLBACK', experienceLevel: 'GENERIC', pricingRegion: 'UNAVAILABLE', billingConfirmed: false });
  });

  it('G2-08b: platform-default tier is real when a PO value IS configured (proves tier 4 is reachable, not dead code) — but is formally CLOSED as a gap since PO row 4 already specifies null as the approved "no signal" behaviour', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: null,
      platformDefaultCountry: 'AU',
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'PLATFORM_DEFAULT' });
  });

  it('G2-09: manual IN selection overrides detected AU -> IN presentation, no billing confirmation', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'IN',
      detectedCountryRaw: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'ANONYMOUS_SELECTION', billingConfirmed: false });
  });

  it('G2-10: manual AU selection overrides detected IN -> AU presentation, no billing confirmation', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'AU',
      detectedCountryRaw: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'ANONYMOUS_SELECTION', billingConfirmed: false });
  });

  it('Global selection -> neutral GLOBAL presentation, no billing confirmation, no AU/IN domestic capability implied', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'GLOBAL',
      detectedCountryRaw: 'AU', // detection must not override the manual Global choice
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({
      presentationCountry: 'GLOBAL',
      source: 'ANONYMOUS_SELECTION',
      experienceLevel: 'GENERIC', // never FULL -- no AU/IN domestic capability implied
      pricingRegion: 'GLOBAL',
      billingConfirmed: false,
      isAuthoritative: false,
    });
  });

  it('G2-11: malformed/forged cookie is ignored, falls through to detected AU, no authority', () => {
    const forged = parseLandingCountryCookie('not-valid-base64!!!');
    expect(forged).toBeNull();
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: forged,
      detectedCountryRaw: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'DETECTED_REQUEST' });
  });

  it('G2-12: forged/unsupported detected-country header resolves to safe fallback, no authority', () => {
    const rawForged = 'A1'; // MaxMind-style anonymizer pseudo-code -- never a real country
    expect(isPlausibleCountryCode(rawForged)).toBe(false);
    const normalized = normalizeLandingCountryCode(rawForged);
    const detected = bucketCountryCodeForLanding(normalized);
    expect(detected).toBeNull();
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: null,
      detectedCountryRaw: normalized,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: null, source: 'GENERIC_FALLBACK' });
  });

  it('G2-13: authenticated AU user travelling (detected IN, cookie IN) -> confirmed AU wins', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'AU', billingConfirmed: false },
      anonymousSelection: 'IN',
      detectedCountryRaw: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'AUTHENTICATED_PRIMARY', experienceLevel: 'FULL' });
  });

  it('G2-14: authenticated IN user travelling (detected AU, cookie AU) -> confirmed IN wins', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'IN', billingConfirmed: false },
      anonymousSelection: 'AU',
      detectedCountryRaw: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'AUTHENTICATED_PRIMARY', experienceLevel: 'FULL' });
  });

  it('G2-15: authenticated GB (non-AU/IN) user -> buckets to GLOBAL, wins over any anonymous/detected signal', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'GB', billingConfirmed: false },
      anonymousSelection: 'IN',
      detectedCountryRaw: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'GLOBAL', source: 'AUTHENTICATED_PRIMARY', experienceLevel: 'GENERIC', pricingRegion: 'GLOBAL' });
  });

  it('G2-16: unconfirmed account (primaryCountry null) behaves as anonymous for landing presentation (MCC gate is a separate, untouched mechanism)', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: null, billingConfirmed: false },
      anonymousSelection: null,
      detectedCountryRaw: 'AU',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'DETECTED_REQUEST' });
  });

  it('G2-17: anonymous detected IN, manual Global selection -> Global presentation, no India billing implied', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'GLOBAL',
      detectedCountryRaw: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'GLOBAL', source: 'ANONYMOUS_SELECTION', pricingRegion: 'GLOBAL', billingConfirmed: false });
  });

  it('G2-18: anonymous detected GB (Global), manual IN selection -> India presentation, no India billing', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'IN',
      detectedCountryRaw: 'GB',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'IN', source: 'ANONYMOUS_SELECTION', pricingRegion: 'IN', billingConfirmed: false });
  });

  it('G2-19: returning anonymous visitor, IP now detected as a different country -> stored manual AU selection still wins', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'AU',
      detectedCountryRaw: 'IN', // changed "IP" this visit
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'ANONYMOUS_SELECTION' });
  });

  it('G2-20: signed-in after anonymous selection -> authenticated primary wins, cookie cannot override', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'AU', billingConfirmed: true },
      anonymousSelection: 'GLOBAL', // prior anonymous cookie, now stale
      detectedCountryRaw: 'IN',
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx).toMatchObject({ presentationCountry: 'AU', source: 'AUTHENTICATED_PRIMARY', billingConfirmed: true });
  });

  it('a Global user with an AUD-flavoured currency preference (modelled by the authenticated tier never even accepting a currency parameter) remains Global', () => {
    // computeLandingCountryContext's authenticated input has no currency
    // field at all -- this is itself the structural proof that currency
    // cannot influence presentation. This test exercises the GB (Global)
    // case explicitly regardless of any currency context a caller might
    // separately be carrying.
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'GB', billingConfirmed: false },
      anonymousSelection: null,
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx.presentationCountry).toBe('GLOBAL');
  });

  it('a Global user remains Global regardless of an INR-flavoured currency context for the same reason', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'US', billingConfirmed: false },
      anonymousSelection: null,
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry,
    });
    expect(ctx.presentationCountry).toBe('GLOBAL');
  });
});

describe('GLOBAL is not a country — structural enforcement (PO clarification section 4)', () => {
  it('GLOBAL is a valid landing PRESENTATION value...', () => {
    expect(isLandingPresentationCountry('GLOBAL')).toBe(true);
    expect(LANDING_PRESENTATION_COUNTRIES).toContain('GLOBAL');
  });

  it('...but toAuthoritativeCountryCodeOrNull() never lets it become an authoritative CountryCode', () => {
    expect(toAuthoritativeCountryCodeOrNull('GLOBAL')).toBeNull();
    expect(toAuthoritativeCountryCodeOrNull('AU')).toBe('AU');
    expect(toAuthoritativeCountryCodeOrNull('IN')).toBe('IN');
    expect(toAuthoritativeCountryCodeOrNull(null)).toBeNull();
  });

  it('an arbitrary/forged presentation value is rejected by isLandingPresentationCountry', () => {
    expect(isLandingPresentationCountry('GB')).toBe(false);
    expect(isLandingPresentationCountry('global')).toBe(false); // case-sensitive, no silent normalization here
    expect(isLandingPresentationCountry('')).toBe(false);
    expect(isLandingPresentationCountry(null)).toBe(false);
    expect(isLandingPresentationCountry(123)).toBe(false);
  });
});

describe('G2 cookie security (spec section 8) — forgery cannot grant authority, and only {AU, IN, GLOBAL} are ever accepted', () => {
  it('a validly-serialized cookie round-trips to its own bucket, for all three values', () => {
    for (const value of ['AU', 'IN', 'GLOBAL'] as const) {
      const cookie = serializeLandingCountryCookie(value);
      expect(parseLandingCountryCookie(cookie)).toBe(value);
    }
  });

  it('garbage base64 is rejected', () => {
    expect(parseLandingCountryCookie('!!!not-base64!!!')).toBeNull();
  });

  it('valid base64 but non-JSON payload is rejected', () => {
    const raw = Buffer.from('not json', 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw)).toBeNull();
  });

  it('wrong version field is rejected (no silent migration)', () => {
    const raw = Buffer.from(JSON.stringify({ v: 999, country: 'AU', source: 'MANUAL', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw)).toBeNull();
  });

  it('a forged country outside {AU, IN, GLOBAL} (e.g. a raw ISO code like "GB", or garbage like "ZZ") is rejected even with an otherwise-valid shape', () => {
    for (const forgedCountry of ['GB', 'ZZ', 'AUS', 'global', '']) {
      const raw = Buffer.from(JSON.stringify({ v: 2, country: forgedCountry, source: 'MANUAL', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
      expect(parseLandingCountryCookie(raw)).toBeNull();
    }
  });

  it('a forged "source" other than MANUAL is rejected', () => {
    const raw = Buffer.from(JSON.stringify({ v: 2, country: 'AU', source: 'AUTHENTICATED_PRIMARY', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(raw)).toBeNull();
  });

  it('missing cookie resolves to null, not an error', () => {
    expect(parseLandingCountryCookie(null)).toBeNull();
    expect(parseLandingCountryCookie(undefined)).toBeNull();
    expect(parseLandingCountryCookie('')).toBeNull();
  });

  it('a forged cookie can never produce anything beyond a non-authoritative presentation value in the full pipeline', () => {
    const raw = Buffer.from(JSON.stringify({ v: 2, country: 'AU', source: 'MANUAL', setAt: new Date().toISOString(), billingConfirmed: true, isAuthoritative: true }), 'utf8').toString('base64url');
    const bucket = parseLandingCountryCookie(raw);
    expect(bucket).toBe('AU'); // the extra forged fields are simply ignored -- shape is fixed, not extensible by the client
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: bucket,
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry: registryFixture(),
    });
    expect(ctx.isAuthoritative).toBe(false);
    expect(ctx.billingConfirmed).toBe(false);
  });

  it('an old-format (v1, raw-ISO-code) cookie from before the AU/IN/Global migration is safely rejected, not silently accepted', () => {
    const oldFormatRaw = Buffer.from(JSON.stringify({ v: 1, country: 'GB', source: 'MANUAL', setAt: new Date().toISOString() }), 'utf8').toString('base64url');
    expect(parseLandingCountryCookie(oldFormatRaw)).toBeNull();
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

  it('normalizes whatever the header actually contained; bucketing (AU/IN/Global/unresolved) is a separate, dedicated step', () => {
    expect(normalizeLandingCountryCode('au')).toBe('AU');
    expect(normalizeLandingCountryCode('  in ')).toBe('IN');
    expect(normalizeLandingCountryCode('AUS')).toBeNull(); // 3-letter code rejected, not silently truncated
    expect(normalizeLandingCountryCode('')).toBeNull();
    expect(normalizeLandingCountryCode(null)).toBeNull();
    expect(bucketCountryCodeForLanding('AU')).toBe('AU');
    expect(bucketCountryCodeForLanding('IN')).toBe('IN');
    expect(bucketCountryCodeForLanding('FR')).toBe('GLOBAL');
    expect(bucketCountryCodeForLanding('ZZ')).toBeNull();
    expect(bucketCountryCodeForLanding(null)).toBeNull();
  });
});
