// G3 — Registration and Existing-User Alignment.
//
// Covers the specification's mandatory negative controls (section 14) and the
// application-layer half of the 25-scenario matrix (section 13). The
// database-layer half — the migration's own triggers and predicates — is
// certified separately against real PostgreSQL by
// scripts/db-rebuild-check/g3_registration_alignment_cert.mjs, because a
// mocked Supabase client cannot prove a trigger fires.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertCountryConfirmedForUser,
  countryConfirmationBlockResponse,
  classifyCountryValue,
  isRegistrationPermitted,
  isGenericExperienceRestricted,
  loadCountryRegistrySnapshot,
  resolveConfirmCountryPreselect,
  shouldRedirectToConfirmCountry,
  SUPPORTED_COUNTRY_CODES,
  REGISTRATION_COUNTRY_OPTIONS,
  __resetCountryRegistryCacheForTests,
  type CountryGateResult,
  type CountryRegistryEntry,
} from '@/lib/services/countryGate';
import {
  AUTHORITATIVE_COUNTRY_CODES,
  FULL_EXPERIENCE_COUNTRY_CODES,
  isKnownCountry,
  isFullExperienceCountry,
  toFullExperienceCountryOrNull,
} from '@/lib/services/jurisdiction';
import {
  buildCoverageDisclosure,
  isDisclosureAcknowledgementValid,
  GENERIC_DISCLOSURE_VERSION,
} from '@/lib/services/countryDisclosure';
import { validatePriceForBilling } from '@/lib/services/billingAuthority';
import { profileSchema } from '@/lib/validation/profile';
import { COUNTRY_TO_CURRENCY, expectedCurrencyForCountry } from '@/lib/constants';
import { toAuthoritativeCountryCodeOrNull } from '@/lib/services/landingCountryContext';

// ---------------------------------------------------------------------------
// Fake Supabase client — routes by table, like the real gate's three reads.
// ---------------------------------------------------------------------------
const COUNTRY_ROWS = [
  { country_code: 'AU', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'IN', experience_level: 'FULL', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'GB', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'US', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'SG', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
  { country_code: 'AE', experience_level: 'GENERIC', selectable: true, active: true, effective_from: '2020-01-01T00:00:00Z', effective_to: null },
];
const CAPABILITY_ROWS = COUNTRY_ROWS.map((c) => ({ country_code: c.country_code, capability: 'REGISTRATION', enabled: true }));

type ProfileRow = Record<string, unknown> | null;

function client(
  profile: ProfileRow,
  overrides: { countryRows?: typeof COUNTRY_ROWS; capabilityRows?: typeof CAPABILITY_ROWS; registryError?: boolean } = {}
) {
  const countryRows = overrides.countryRows ?? COUNTRY_ROWS;
  const capabilityRows = overrides.capabilityRows ?? CAPABILITY_ROWS;
  const err = overrides.registryError ? { message: 'registry down' } : null;
  return {
    from: (table: string) => {
      if (table === 'countries') {
        return { select: () => Promise.resolve({ data: err ? null : countryRows, error: err }) };
      }
      if (table === 'country_capabilities') {
        return { select: () => ({ eq: () => Promise.resolve({ data: err ? null : capabilityRows, error: err }) }) };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: profile, error: null }) }) }),
      };
    },
  } as unknown as Parameters<typeof assertCountryConfirmedForUser>[0];
}

function confirmedProfile(country: string, extra: Record<string, unknown> = {}) {
  return {
    country_of_residence: country,
    country_confirmed_at: '2026-09-01T00:00:00Z',
    country_source: 'USER_CONFIRMED',
    onboarding_completed: true,
    ...extra,
  };
}

beforeEach(() => {
  __resetCountryRegistryCacheForTests();
});

// ===========================================================================
// Section 5 — the authoritative country model
// ===========================================================================
describe('G3 — authoritative six-country model', () => {
  it('exposes exactly AU, IN, GB, US, SG, AE — no more, no fewer', () => {
    expect([...AUTHORITATIVE_COUNTRY_CODES].sort()).toEqual(['AE', 'AU', 'GB', 'IN', 'SG', 'US']);
    expect([...SUPPORTED_COUNTRY_CODES].sort()).toEqual(['AE', 'AU', 'GB', 'IN', 'SG', 'US']);
    expect(REGISTRATION_COUNTRY_OPTIONS.map((o) => o.value).sort()).toEqual(['AE', 'AU', 'GB', 'IN', 'SG', 'US']);
  });

  it('never admits a GLOBAL/OTHER/INTERNATIONAL/REST_OF_WORLD pseudo-country', () => {
    for (const pseudo of ['GLOBAL', 'OTHER', 'INTERNATIONAL', 'REST_OF_WORLD', 'WORLD', 'ROW']) {
      expect(isKnownCountry(pseudo)).toBe(false);
      expect((SUPPORTED_COUNTRY_CODES as readonly string[]).includes(pseudo)).toBe(false);
    }
  });

  it('rejects arbitrary syntactically-valid two-letter codes (section 5.1)', () => {
    for (const code of ['NZ', 'FR', 'DE', 'JP', 'XX', 'ZZ']) {
      expect(isKnownCountry(code)).toBe(false);
      expect(classifyCountryValue(code)).toBe('UNSUPPORTED');
    }
  });

  it('keeps FULL-experience countries as a strict, separate two-country subset', () => {
    expect([...FULL_EXPERIENCE_COUNTRY_CODES].sort()).toEqual(['AU', 'IN']);
    for (const c of ['GB', 'US', 'SG', 'AE']) expect(isFullExperienceCountry(c)).toBe(false);
    for (const c of ['AU', 'IN']) expect(isFullExperienceCountry(c)).toBe(true);
  });
});

// ===========================================================================
// Section 14 — mandatory negative controls
// ===========================================================================
describe('G3 negative controls — "not IN" never becomes AU, "not AU" never becomes IN', () => {
  it('narrows every GENERIC country to null, never to AU and never to IN', () => {
    for (const c of ['GB', 'US', 'SG', 'AE'] as const) {
      const narrowed = toFullExperienceCountryOrNull(c);
      expect(narrowed).toBeNull();
      expect(narrowed).not.toBe('AU');
      expect(narrowed).not.toBe('IN');
    }
  });

  it('passes FULL countries through unchanged — the narrowing is not a rewrite', () => {
    expect(toFullExperienceCountryOrNull('AU')).toBe('AU');
    expect(toFullExperienceCountryOrNull('IN')).toBe('IN');
    expect(toFullExperienceCountryOrNull(null)).toBeNull();
  });

  it('has no country->currency entry for any GENERIC country, so a currency can never be guessed for one', () => {
    expect(Object.keys(COUNTRY_TO_CURRENCY).sort()).toEqual(['AU', 'IN']);
    for (const c of ['GB', 'US', 'SG', 'AE']) {
      expect(expectedCurrencyForCountry(c)).toBeUndefined();
    }
  });
});

describe('G3 negative controls — currency never implies, grants or changes a country', () => {
  it('AUD does not make a user Australian and INR does not make a user Indian', async () => {
    // An IN resident reporting in AUD stays IN and stays FULL.
    const inAud = await assertCountryConfirmedForUser(client(confirmedProfile('IN', { preferred_currency: 'AUD' })), 'u');
    expect(inAud.state).toBe('CONFIRMED');
    expect(inAud.countryOfResidence).toBe('IN');
    expect(inAud.experienceLevel).toBe('FULL');

    // An AU resident reporting in INR stays AU and stays FULL.
    const auInr = await assertCountryConfirmedForUser(client(confirmedProfile('AU', { preferred_currency: 'INR' })), 'u');
    expect(auInr.state).toBe('CONFIRMED');
    expect(auInr.countryOfResidence).toBe('AU');
    expect(auInr.experienceLevel).toBe('FULL');

    // A GB resident reporting in INR is still GENERIC — INR grants nothing.
    const gbInr = await assertCountryConfirmedForUser(client(confirmedProfile('GB', { preferred_currency: 'INR' })), 'u');
    expect(gbInr.experienceLevel).toBe('GENERIC');
  });

  it('the profile schema ties currency to nothing — every country/currency pair validates', () => {
    for (const country of AUTHORITATIVE_COUNTRY_CODES) {
      for (const currency of ['AUD', 'INR'] as const) {
        const parsed = profileSchema.safeParse({
          full_name: 'Test User',
          country_of_residence: country,
          preferred_currency: currency,
        });
        expect(parsed.success).toBe(true);
      }
    }
  });

  it('rejects any currency outside AUD/INR, whatever the country (scenarios G3-16, G3-17)', () => {
    for (const country of ['GB', 'AU'] as const) {
      for (const forged of ['USD', 'GBP', 'SGD', 'AED', 'EUR', '']) {
        const parsed = profileSchema.safeParse({
          full_name: 'Test User',
          country_of_residence: country,
          preferred_currency: forged,
        });
        expect(parsed.success).toBe(false);
      }
    }
  });
});

describe('G3 negative controls — GLOBAL and the landing cookie are never authoritative', () => {
  it('the only landing->authoritative bridge maps GLOBAL to null', () => {
    expect(toAuthoritativeCountryCodeOrNull('GLOBAL')).toBeNull();
    expect(toAuthoritativeCountryCodeOrNull(null)).toBeNull();
    expect(toAuthoritativeCountryCodeOrNull('AU')).toBe('AU');
    expect(toAuthoritativeCountryCodeOrNull('IN')).toBe('IN');
  });

  it('GLOBAL cannot pass the country-value classifier at all (scenario G3-10)', () => {
    expect(classifyCountryValue('GLOBAL')).toBe('INVALID');
  });

  it('the profile schema refuses GLOBAL as a country of residence', () => {
    const parsed = profileSchema.safeParse({
      full_name: 'Test User',
      country_of_residence: 'GLOBAL',
      preferred_currency: 'AUD',
    });
    expect(parsed.success).toBe(false);
  });

  it('the country gate reads only the profile — it has no cookie, header, locale or IP input', async () => {
    // Structural: assertCountryConfirmedForUser's signature accepts a
    // Supabase client and a user id, and nothing else. There is no parameter
    // through which a detected/anonymous/landing signal could arrive.
    expect(assertCountryConfirmedForUser.length).toBe(2);
  });
});

describe('G3 negative controls — a client cannot forge FULL experience or a capability flag', () => {
  it('derives the experience level from the registry, ignoring anything stored on the profile', async () => {
    // The profile row carries forged fields claiming FULL and enabled
    // capabilities. The gate must not read them.
    const forged = confirmedProfile('GB', {
      experience_level: 'FULL',
      experienceLevel: 'FULL',
      capabilities: { DOMESTIC_CALCULATIONS: true, DOMESTIC_TAX_OUTPUTS: true },
      is_supported: true,
    });
    const gate = await assertCountryConfirmedForUser(client(forged), 'u');
    expect(gate.experienceLevel).toBe('GENERIC'); // scenario G3-15
  });

  it('reports GENERIC even when the registry row itself would be the only place to look', async () => {
    const gate = await assertCountryConfirmedForUser(client(confirmedProfile('SG')), 'u');
    expect(gate.experienceLevel).toBe('GENERIC');
  });
});

// ===========================================================================
// Section 6.2 — the landing handoff
// ===========================================================================
describe('G3 — the G2 landing bucket only ever chooses a starting option', () => {
  const ALL = ['AU', 'IN', 'GB', 'US', 'SG', 'AE'];

  it('AU and IN buckets preselect their own country (spec table rows 1-2)', () => {
    expect(resolveConfirmCountryPreselect({ currentCountry: null, landingBucket: 'AU', offeredCountries: ALL })).toBe('AU');
    expect(resolveConfirmCountryPreselect({ currentCountry: null, landingBucket: 'IN', offeredCountries: ALL })).toBe('IN');
  });

  it('a GLOBAL bucket preselects NOTHING — it is never silently converted to AU or IN (spec table row 3)', () => {
    const r = resolveConfirmCountryPreselect({ currentCountry: null, landingBucket: 'GLOBAL', offeredCountries: ALL });
    expect(r).toBe('');
    expect(r).not.toBe('AU');
    expect(r).not.toBe('IN');
  });

  it('a missing bucket preselects nothing and leaves all six choices open (spec table row 4)', () => {
    expect(resolveConfirmCountryPreselect({ currentCountry: null, landingBucket: null, offeredCountries: ALL })).toBe('');
  });

  it('G3-14: a forged AU cookie loses to the country actually on the account', () => {
    expect(resolveConfirmCountryPreselect({ currentCountry: 'IN', landingBucket: 'AU', offeredCountries: ALL })).toBe('IN');
  });

  it('a cookie naming a country the registry does not currently offer preselects nothing', () => {
    expect(resolveConfirmCountryPreselect({ currentCountry: null, landingBucket: 'IN', offeredCountries: ['AU', 'GB'] })).toBe('');
  });

  it('an unoffered value already on the account is never presented as a real choice', () => {
    expect(resolveConfirmCountryPreselect({ currentCountry: 'NZ', landingBucket: null, offeredCountries: ALL })).toBe('');
  });

  it('a forged cookie cannot widen the offered list — the list is the only input, and it comes from the registry', () => {
    // Whatever the bucket says, the function can only ever return a member of
    // offeredCountries or ''. Exhaustively true by construction.
    for (const bucket of ['AU', 'IN', 'GLOBAL', null] as const) {
      const r = resolveConfirmCountryPreselect({ currentCountry: 'US', landingBucket: bucket, offeredCountries: ['AU', 'IN'] });
      expect(r === '' || ['AU', 'IN'].includes(r)).toBe(true);
    }
  });
});

// ===========================================================================
// Section 6.3 — server authority over registration eligibility
// ===========================================================================
describe('G3 — registration eligibility is registry-derived and fails closed', () => {
  const base: CountryRegistryEntry = {
    countryCode: 'GB',
    experienceLevel: 'GENERIC',
    registrationEnabled: true,
    active: true,
    selectable: true,
    effectiveFrom: '2020-01-01T00:00:00Z',
    effectiveTo: null,
  };

  it('permits a country only when every registry condition holds', () => {
    expect(isRegistrationPermitted(base)).toBe(true);
  });

  it('refuses an absent, inactive, unselectable or registration-disabled country', () => {
    expect(isRegistrationPermitted(undefined)).toBe(false);
    expect(isRegistrationPermitted({ ...base, active: false })).toBe(false);
    expect(isRegistrationPermitted({ ...base, selectable: false })).toBe(false);
    expect(isRegistrationPermitted({ ...base, registrationEnabled: false })).toBe(false);
  });

  it('refuses a country outside its effective window (not yet started, or already ended)', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    expect(isRegistrationPermitted({ ...base, effectiveFrom: '2030-01-01T00:00:00Z' }, now)).toBe(false);
    expect(isRegistrationPermitted({ ...base, effectiveTo: '2025-01-01T00:00:00Z' }, now)).toBe(false);
    expect(isRegistrationPermitted({ ...base, effectiveTo: '2030-01-01T00:00:00Z' }, now)).toBe(true);
  });

  it('classifies a confirmed country the registry no longer permits as NOT PERMITTED, never as CONFIRMED', async () => {
    const disabled = CAPABILITY_ROWS.map((r) => (r.country_code === 'GB' ? { ...r, enabled: false } : r));
    const gate = await assertCountryConfirmedForUser(
      client(confirmedProfile('GB'), { capabilityRows: disabled }),
      'u'
    );
    expect(gate.state).toBe('COUNTRY_REGISTRATION_NOT_PERMITTED');
  });

  it('fails CLOSED (DB_ERROR, not CONFIRMED) when the registry cannot be read', async () => {
    const gate = await assertCountryConfirmedForUser(client(confirmedProfile('AU'), { registryError: true }), 'u');
    expect(gate.state).toBe('DB_ERROR');
    expect(gate.experienceLevel).toBeNull();
  });

  it('returns null rather than an empty snapshot on a registry read failure', async () => {
    expect(await loadCountryRegistrySnapshot(client(null, { registryError: true }))).toBeNull();
  });
});

// ===========================================================================
// Section 10 — the interim pre-G4 boundary
// ===========================================================================
describe('G3 — generic users are contained until G4', () => {
  it('blocks a GENERIC user from a route that has not opted in (the default)', async () => {
    for (const country of ['GB', 'US', 'SG', 'AE']) {
      const res = await countryConfirmationBlockResponse(client(confirmedProfile(country)), 'u');
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      expect(await res!.json()).toEqual({ error: 'GENERIC_EXPERIENCE_RESTRICTED' });
    }
  });

  it('admits a GENERIC user only where the route explicitly opted in', async () => {
    const res = await countryConfirmationBlockResponse(client(confirmedProfile('GB')), 'u', {
      allowGenericExperience: true,
    });
    expect(res).toBeNull();
  });

  it('never blocks a FULL user, with or without the opt-in (scenarios G3-18, G3-19)', async () => {
    for (const country of ['AU', 'IN']) {
      expect(await countryConfirmationBlockResponse(client(confirmedProfile(country)), 'u')).toBeNull();
      expect(
        await countryConfirmationBlockResponse(client(confirmedProfile(country)), 'u', { allowGenericExperience: true })
      ).toBeNull();
    }
  });

  it('the generic restriction is a route decision, not a confirmation failure — it never loops back to /confirm-country', () => {
    const generic: CountryGateResult = {
      state: 'GENERIC_EXPERIENCE_RESTRICTED',
      countryOfResidence: 'GB',
      countryConfirmedAt: '2026-09-01T00:00:00Z',
      countrySource: 'USER_CONFIRMED',
      onboardingCompleted: true,
      experienceLevel: 'GENERIC',
    };
    expect(shouldRedirectToConfirmCountry(generic)).toBe(false);
  });

  it('isGenericExperienceRestricted only ever fires for a CONFIRMED GENERIC user without the opt-in', () => {
    const g = (state: CountryGateResult['state'], level: CountryGateResult['experienceLevel']): CountryGateResult => ({
      state,
      countryOfResidence: 'GB',
      countryConfirmedAt: null,
      countrySource: null,
      onboardingCompleted: true,
      experienceLevel: level,
    });
    expect(isGenericExperienceRestricted(g('CONFIRMED', 'GENERIC'), false)).toBe(true);
    expect(isGenericExperienceRestricted(g('CONFIRMED', 'GENERIC'), true)).toBe(false);
    expect(isGenericExperienceRestricted(g('CONFIRMED', 'FULL'), false)).toBe(false);
    expect(isGenericExperienceRestricted(g('COUNTRY_MISSING', 'GENERIC'), false)).toBe(false);
  });

  it('an unconfirmed user is still blocked by MCC regardless of experience level (scenario G3-20)', async () => {
    const res = await countryConfirmationBlockResponse(
      client({ country_of_residence: null, country_confirmed_at: null, country_source: null, onboarding_completed: true }),
      'u'
    );
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: 'COUNTRY_CONFIRMATION_REQUIRED' });
  });
});

describe('G3 — a generic user cannot reach billing or domestic pricing', () => {
  const catalogue = [
    { priceId: 'price_in_monthly', region: 'IN' as const },
    { priceId: 'price_generic_monthly', region: 'GENERIC' as const },
  ];

  it('denies every price to a GENERIC billing country, generic-region prices included', () => {
    for (const country of ['GB', 'US', 'SG', 'AE'] as const) {
      for (const priceId of ['price_in_monthly', 'price_generic_monthly']) {
        const result = validatePriceForBilling({
          billingCountry: country,
          billingConfirmed: true,
          requestedPriceId: priceId,
          catalogue,
        });
        expect(result.allowed).toBe(false);
      }
    }
  });

  it('still denies India pricing to a GB billing country — the pre-G3 certified property is unchanged', () => {
    const result = validatePriceForBilling({
      billingCountry: 'GB',
      billingConfirmed: true,
      requestedPriceId: 'price_in_monthly',
      catalogue,
    });
    expect(result.allowed).toBe(false);
  });

  it('unconfirmed billing still fails closed for a FULL country', () => {
    const result = validatePriceForBilling({
      billingCountry: 'IN',
      billingConfirmed: false,
      requestedPriceId: 'price_in_monthly',
      catalogue,
    });
    expect(result).toEqual({ allowed: false, reason: 'BILLING_COUNTRY_NOT_CONFIRMED' });
  });
});

// ===========================================================================
// Section 7 — FULL/GENERIC disclosure
// ===========================================================================
describe('G3 — coverage disclosure', () => {
  it('requires an acknowledgement for GENERIC and none for FULL', () => {
    expect(buildCoverageDisclosure('GENERIC', 'United Kingdom').requiresAcknowledgement).toBe(true);
    expect(buildCoverageDisclosure('FULL', 'Australia').requiresAcknowledgement).toBe(false);
  });

  it('states each unavailable category explicitly rather than hedging', () => {
    const d = buildCoverageDisclosure('GENERIC', 'Singapore');
    const all = [d.body, ...d.points].join(' ').toLowerCase();
    for (const topic of ['tax', 'retirement', 'regulatory', 'pricing']) {
      expect(all).toContain(topic);
    }
  });

  it('never claims comprehensive domestic coverage for a FULL country (section 7.1)', () => {
    const d = buildCoverageDisclosure('FULL', 'India');
    const all = [d.body, ...d.points].join(' ');
    expect(all).not.toMatch(/EPF|PPF|NPS/);
    expect(all).not.toMatch(/all (Australian )?tax outputs/i);
    expect(d.body).toMatch(/only the capabilities actually enabled/i);
  });

  it('offers an UNAVAILABLE country no way in, and warns against picking a false country (section 5.2)', () => {
    const d = buildCoverageDisclosure('UNAVAILABLE', 'New Zealand');
    expect(d.requiresAcknowledgement).toBe(false);
    expect(d.version).toBeNull();
    expect(d.acknowledgementLabel).toBeNull();
    expect(d.body).toMatch(/not yet available/i);
    expect(d.body).toMatch(/do not select another country unless it is genuinely your residence/i);
  });

  it('accepts only the CURRENT disclosure version for a GENERIC country', () => {
    expect(isDisclosureAcknowledgementValid({ experienceLevel: 'GENERIC', acknowledgedVersion: GENERIC_DISCLOSURE_VERSION })).toBe(true);
    for (const bad of [null, undefined, '', 'g3-generic-coverage-2020-01', 'true', 'yes']) {
      expect(isDisclosureAcknowledgementValid({ experienceLevel: 'GENERIC', acknowledgedVersion: bad })).toBe(false);
    }
  });

  it('needs no acknowledgement for FULL, and refuses UNAVAILABLE outright', () => {
    expect(isDisclosureAcknowledgementValid({ experienceLevel: 'FULL', acknowledgedVersion: null })).toBe(true);
    expect(isDisclosureAcknowledgementValid({ experienceLevel: 'UNAVAILABLE', acknowledgedVersion: GENERIC_DISCLOSURE_VERSION })).toBe(false);
  });
});

// ===========================================================================
// Section 10 / 15 — routing containment and redirect-loop safety
// ===========================================================================
describe('G3 — proxy routing containment, read from the real proxy.ts source', () => {
  const src = readFileSync(join(process.cwd(), 'proxy.ts'), 'utf8');

  // Both regexes are extracted from the real source rather than hand-copied,
  // so this test breaks loudly if either is rewritten.
  const allRegexes = [...src.matchAll(/\/\^\\\/\(([^)]+)\)\//g)].map((m) => new RegExp(`^/(${m[1]})`));
  const isAppRoute = allRegexes[0];
  const isGenericAllowed = allRegexes[1];

  it('extracted both the app-route and generic-allowlist regexes', () => {
    expect(allRegexes.length).toBeGreaterThanOrEqual(2);
  });

  it('every directory under app/(app)/ is matched by the app-route regex', () => {
    const appDir = join(process.cwd(), 'app', '(app)');
    const dirs = readdirSync(appDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs).toContain('global-setup');
    for (const d of dirs) {
      expect(isAppRoute.test(`/${d}`)).toBe(true);
    }
  });

  it('the generic destination is itself allowed — otherwise the redirect would loop forever', () => {
    expect(isGenericAllowed.test('/global-setup')).toBe(true);
  });

  it('allows a generic user exactly the reasoned-about surfaces, and nothing else', () => {
    for (const allowed of ['/global-setup', '/profile', '/confirm-country', '/onboarding']) {
      expect(isGenericAllowed.test(allowed)).toBe(true);
    }
    for (const blocked of [
      '/dashboard', '/income', '/expenses', '/assets', '/liabilities', '/investments',
      '/investment-intelligence', '/retirement', '/insurance', '/score', '/dna', '/resilience',
      '/goals', '/financial-twin', '/financial-data-hub', '/forecast', '/recommendations',
      '/reports', '/admin', '/ai-insights',
    ]) {
      expect(isGenericAllowed.test(blocked)).toBe(false);
      // ...and each one IS an app route, so the redirect actually fires.
      expect(isAppRoute.test(blocked)).toBe(true);
    }
  });

  it('the generic redirect is conditioned on a CONFIRMED country, so it cannot race the confirm-country redirect', () => {
    expect(src).toMatch(/profile\?\.country_confirmed_at\s*&&\s*profile\.country_of_residence\s*&&\s*!isGenericAllowedRoute/);
  });

  it('the experience level in the proxy comes from the registry, never from the country code or currency', () => {
    const start = src.indexOf('G3: generic-experience containment');
    const end = src.indexOf("redirect(new URL('/global-setup'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain('loadCountryRegistrySnapshot');
    expect(block).toContain("experienceLevel === 'GENERIC'");
    // The decision must not be reachable from any lower-authority signal.
    expect(block).not.toMatch(/preferred_currency/);
    expect(block).not.toMatch(/cookies?\./i);
    expect(block).not.toMatch(/headers?\./i);
    expect(block).not.toMatch(/=== 'AU'|=== 'IN'/);
  });
});

describe('G3 — the generic API opt-in is used by exactly the reasoned-about routes (drift guard)', () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name === 'route.ts') out.push(full);
    }
    return out;
  }

  it('only four route files opt out of the generic block, and they are the four G3 authorises', () => {
    const routes = walk(join(process.cwd(), 'app', 'api'));
    const optedIn = routes
      .filter((f) => readFileSync(f, 'utf8').includes('requireCountryConfirmedUserAllowingGeneric'))
      .map((f) => f.replace(process.cwd(), '').replace(/\\/g, '/'))
      .sort();

    expect(optedIn).toEqual([
      '/app/api/user/cross-border-relationships/[id]/route.ts',
      '/app/api/user/cross-border-relationships/route.ts',
      '/app/api/user/primary-country/confirm/route.ts',
      '/app/api/user/primary-country/preview/route.ts',
    ]);
  });

  it('no financial, report, admin or billing route opts in', () => {
    const routes = walk(join(process.cwd(), 'app', 'api'));
    for (const f of routes) {
      const rel = f.replace(process.cwd(), '').replace(/\\/g, '/');
      if (!readFileSync(f, 'utf8').includes('requireCountryConfirmedUserAllowingGeneric')) continue;
      for (const forbidden of ['/income', '/expenses', '/assets', '/liabilities', '/investments', '/retirement', '/insurance', '/goals', '/reports', '/admin', '/billing', '/forecast', '/resilience']) {
        expect(rel.startsWith(`/app/api${forbidden}`)).toBe(false);
      }
    }
  });

  it('the billing-country confirm route still uses the NON-generic guard (G3 must not confirm billing country)', () => {
    const src = readFileSync(join(process.cwd(), 'app', 'api', 'user', 'billing-country', 'confirm', 'route.ts'), 'utf8');
    expect(src).not.toContain('requireCountryConfirmedUserAllowingGeneric');
    expect(src).toContain('requireCountryConfirmedUser');
  });
});

// ===========================================================================
// Section 12 — the migration itself, read as evidence
// ===========================================================================
describe('G3 migration 0127 — structural guarantees, read from the SQL', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '0127_g3_registration_country_expansion.sql'),
    'utf8'
  );

  it('never sets is_supported = true, so the ~85-table financial backstop stays AU/IN-only', () => {
    expect(sql).not.toMatch(/is_supported\s*=\s*true/i);
    expect(sql).not.toMatch(/set\s+is_supported/i);
  });

  it('never redefines is_country_confirmed() — MCC is extended alongside, never weakened', () => {
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.is_country_confirmed\b/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function\s+public\.enforce_country_confirmed\s*\(/i);
  });

  it('enables REGISTRATION for exactly the four generic countries and touches no AU/IN capability', () => {
    const start = sql.indexOf('insert into country_capabilities');
    const end = sql.indexOf('-- 3. Generic-disclosure acknowledgement');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sql.slice(start, end);
    for (const c of ['GB', 'US', 'SG', 'AE']) expect(block).toContain(`('${c}', 'REGISTRATION', true)`);
    expect(block).not.toMatch(/\('AU',/);
    expect(block).not.toMatch(/\('IN',/);
  });

  it('adds the GLOBAL/catch-all guard on the countries registry', () => {
    expect(sql).toMatch(/countries_country_code_is_real_iso_check/);
    expect(sql).toMatch(/country_code\s*~\s*'\^\[A-Z\]\{2\}\$'/);
    for (const placeholder of ['XX', 'ZZ', 'AA', 'QQ']) {
      expect(sql).toContain(`'${placeholder}'`);
    }
  });

  it('enforces the generic disclosure acknowledgement at the database layer', () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.enforce_generic_disclosure_acknowledgement/i);
    expect(sql).toMatch(/trg_enforce_generic_disclosure/);
    expect(sql).toMatch(/GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED/);
  });

  // Anchored on the full section HEADINGS, not on '-- 7.' / '-- 8.'. Those
  // short prefixes also match spec cross-references inside prose comments
  // (e.g. a line wrapping onto "-- 8.2 forbids ..."), which silently produced
  // an empty slice and a vacuously-passing test until this run caught it.
  const SECTION_7 = '-- 7. Repoint exactly two triggers';
  const SECTION_8 = '-- 8. Cross-border declarations may not name';

  it('the section anchors this file relies on are unique and correctly ordered', () => {
    expect(sql.indexOf(SECTION_7)).toBeGreaterThan(-1);
    expect(sql.indexOf(SECTION_8)).toBeGreaterThan(sql.indexOf(SECTION_7));
    expect(sql.indexOf(SECTION_7)).toBe(sql.lastIndexOf(SECTION_7));
    expect(sql.indexOf(SECTION_8)).toBe(sql.lastIndexOf(SECTION_8));
  });

  it('repoints only the two non-financial G1 tables onto the weaker registration predicate', () => {
    const triggerBlock = sql.slice(sql.indexOf(SECTION_7), sql.indexOf(SECTION_8));
    expect(triggerBlock.length).toBeGreaterThan(200); // never assert against an empty slice
    expect(triggerBlock).toContain('cross_border_relationships');
    expect(triggerBlock).toContain('country_change_previews');
    // No financial table may appear in that block.
    for (const financial of ['income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'insurance_policies', 'user_goals']) {
      expect(triggerBlock).not.toContain(financial);
    }
  });

  // The distinction this test turns on: SQL inside a `$$ ... $$` function
  // body is a DEFINITION of what will happen later, per user, when that
  // function is called. SQL at the top level EXECUTES the moment the
  // migration is applied. Only the latter can touch existing rows, and only
  // the latter is what "this migration modifies no existing data" means.
  //
  // confirm_country_of_residence() legitimately contains
  // `update user_profiles set ...` — that is its entire purpose — so the
  // check strips every function body first and asserts against what actually
  // runs at apply time.
  const topLevelSql = sql.replace(/\$\$[\s\S]*?\$\$/g, '/* function body elided */');

  it('executes no data-modifying statement against user data at apply time', () => {
    for (const forbidden of [
      /update\s+income_sources/i,
      /update\s+expense_items/i,
      /update\s+assets\b/i,
      /update\s+liabilities/i,
      /update\s+investments/i,
      /update\s+retirement_accounts/i,
      /update\s+insurance_policies/i,
      /update\s+user_goals/i,
      /update\s+exchange_rates/i,
      /update\s+report_/i,
      /set\s+preferred_currency/i,
      /update\s+user_profiles/i,
      /delete\s+from\s+user_profiles/i,
    ]) {
      expect(topLevelSql).not.toMatch(forbidden);
    }
  });

  it('elides only function bodies, so the check above is not vacuous', () => {
    // Negative control: the untouched SQL DOES contain the RPC's own update,
    // proving the elision is what removed it rather than it never existing.
    expect(sql).toMatch(/update\s+user_profiles\s+set/i);
    expect(topLevelSql).toContain('/* function body elided */');
    // ...and the apply-time statements that SHOULD be there still are.
    expect(topLevelSql).toMatch(/insert\s+into\s+country_capabilities/i);
    expect(topLevelSql).toMatch(/alter\s+table\s+user_profiles\s+add\s+column/i);
  });

  it('never backfills billing country', () => {
    expect(sql).not.toMatch(/set\s+billing_country/i);
    expect(sql).not.toMatch(/billing_country_confirmed_at\s*=/i);
  });

  // ---- G3-R5 closure -----------------------------------------------------
  it('makes confirmation a controlled workflow owned by an RPC', () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.confirm_country_of_residence/i);
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.enforce_controlled_confirmation_columns/i);
    expect(sql).toMatch(/trg_enforce_controlled_confirmation_columns/);
    expect(sql).toMatch(/COUNTRY_CONFIRMATION_REQUIRES_CONTROLLED_WORKFLOW/);
  });

  it('guards every confirmation-owned column, not just some of them', () => {
    const guard = sql.slice(sql.indexOf('enforce_controlled_confirmation_columns()'), sql.indexOf('-- 10. Grants'));
    expect(guard.length).toBeGreaterThan(200);
    for (const col of [
      'country_confirmed_at',
      'country_source',
      'generic_disclosure_version',
      'generic_disclosure_acknowledged_at',
      'generic_disclosure_country',
    ]) {
      expect(guard).toContain(`new.${col} is distinct from old.${col}`);
    }
  });

  it('writes the audit event inside the RPC, so it cannot be skipped or fail independently', () => {
    const rpc = sql.slice(sql.indexOf('function public.confirm_country_of_residence'), sql.indexOf('enforce_controlled_confirmation_columns'));
    expect(rpc.length).toBeGreaterThan(500);
    // One transaction: the profile UPDATE and the audit INSERT are both in
    // the RPC body, with no COMMIT between them.
    expect(rpc).toMatch(/update\s+user_profiles\s+set/i);
    expect(rpc).toMatch(/insert\s+into\s+audit_events/i);
    expect(rpc).not.toMatch(/\bcommit\b/i);
    expect(rpc).toContain("'country_confirmed'");
    expect(rpc).toContain('written_by');
  });

  it('the RPC never accepts a client-supplied experience level, source or timestamp', () => {
    const signature = sql.slice(
      sql.indexOf('function public.confirm_country_of_residence'),
      sql.indexOf('returns jsonb')
    );
    // Exactly two parameters.
    expect(signature).toContain('p_country_code');
    expect(signature).toContain('p_disclosure_version');
    for (const forbidden of ['p_experience_level', 'p_country_source', 'p_confirmed_at', 'p_capabilities']) {
      expect(signature).not.toContain(forbidden);
    }
    // And the source is a hardcoded literal, never a parameter.
    const rpc = sql.slice(sql.indexOf('function public.confirm_country_of_residence'), sql.indexOf('enforce_controlled_confirmation_columns'));
    expect(rpc).toMatch(/country_source\s*=\s*'USER_CONFIRMED'/);
  });

  it('permits exactly one direct transition — a pure de-confirmation to all-NULL', () => {
    const guard = sql.slice(sql.indexOf('enforce_controlled_confirmation_columns()'), sql.indexOf('-- 10. Grants'));
    expect(guard).toContain('new.country_confirmed_at is null');
    expect(guard).toContain('new.generic_disclosure_country is null');
  });

  it('grants the RPC to authenticated so the controlled path is actually reachable', () => {
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.confirm_country_of_residence\(char,\s*text\)\s+to\s+authenticated/i);
  });

  it('preserves the MCC-14 account-deletion cascade exemption in the new trigger function', () => {
    const fn = sql.slice(sql.indexOf('enforce_country_confirmed_registration()'), sql.indexOf(SECTION_7));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain('_mcc_auth_user_exists');
    expect(fn).toMatch(/auth\.role\(\)\s*=\s*'service_role'/);
    expect(fn).toContain("errcode = '42501'");
  });
});
