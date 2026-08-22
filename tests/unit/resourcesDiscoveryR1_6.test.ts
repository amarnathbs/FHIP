// R1.6 — Search, Related Content, CTAs & FHIP Contextual Integration.
// Pure-function unit tests (no DB) — spec §117.

import { describe, it, expect } from 'vitest';
import { normalizeSearchQuery, normalizeContentTypeFilter, normalizeJurisdictionFilter, MAX_SEARCH_QUERY_LENGTH } from '@/lib/resources/search/validation';
import { isJurisdictionCompatibleForFallback, scoreFallbackCandidate, RELATED_CONTENT_LIMIT } from '@/lib/resources/discovery/related';
import { isRegisteredContextKey, getContextDefinition, isWellFormedInternalRoute, FHIP_CONTEXTS, FHIP_MODULE_ROUTES } from '@/lib/resources/context/registry';
import { isSafeInternalPath, isSafeExternalUrl, isSafeYoutubeUrl, validateCtaDestination, validateCta } from '@/lib/resources/cta/validation';

// ---------------------------------------------------------------------------
// Search query normalisation (spec §20)
// ---------------------------------------------------------------------------
describe('R1.6 normalizeSearchQuery', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeSearchQuery('  emergency fund  ')).toBe('emergency fund');
  });
  it('collapses internal multi-whitespace to a single space', () => {
    expect(normalizeSearchQuery('emergency    fund')).toBe('emergency fund');
  });
  it('caps length at MAX_SEARCH_QUERY_LENGTH (200)', () => {
    const long = 'a'.repeat(500);
    expect(normalizeSearchQuery(long).length).toBe(MAX_SEARCH_QUERY_LENGTH);
  });
  it('empty/whitespace-only query normalises to empty string', () => {
    expect(normalizeSearchQuery('')).toBe('');
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery(null)).toBe('');
    expect(normalizeSearchQuery(undefined)).toBe('');
  });
  it('preserves punctuation, apostrophes and Unicode unchanged (spec §20)', () => {
    expect(normalizeSearchQuery("what's my net-worth? 净资产")).toBe("what's my net-worth? 净资产");
  });
  it('SQL-injection-shaped text passes through as ordinary text, never throws', () => {
    expect(() => normalizeSearchQuery("' OR 1=1 --")).not.toThrow();
    expect(normalizeSearchQuery("' OR 1=1 --")).toBe("' OR 1=1 --");
  });
  it('script-tag text passes through as plain text, never throws (React will escape it on render)', () => {
    expect(normalizeSearchQuery('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

describe('R1.6 filter normalisation', () => {
  it('normalizeContentTypeFilter accepts a known type', () => {
    expect(normalizeContentTypeFilter('video')).toBe('video');
  });
  it('normalizeContentTypeFilter falls back to "all" for an unknown/empty value', () => {
    expect(normalizeContentTypeFilter('bogus')).toBe('all');
    expect(normalizeContentTypeFilter(null)).toBe('all');
    expect(normalizeContentTypeFilter('money_update_template')).toBe('all'); // never a selectable filter value
  });
  it('normalizeJurisdictionFilter accepts a known jurisdiction', () => {
    expect(normalizeJurisdictionFilter('india')).toBe('india');
  });
  it('normalizeJurisdictionFilter falls back to "all" for an unknown value', () => {
    expect(normalizeJurisdictionFilter('atlantis')).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// Related content — jurisdiction compatibility + fallback scoring (spec §35/§36)
// ---------------------------------------------------------------------------
describe('R1.6 isJurisdictionCompatibleForFallback', () => {
  it('Global candidate is always compatible', () => {
    expect(isJurisdictionCompatibleForFallback('australia', 'global')).toBe(true);
    expect(isJurisdictionCompatibleForFallback('india', 'global')).toBe(true);
  });
  it('exact jurisdiction match is compatible', () => {
    expect(isJurisdictionCompatibleForFallback('australia', 'australia')).toBe(true);
  });
  it('Australia source rejects an India-specific candidate (spec §36/§90)', () => {
    expect(isJurisdictionCompatibleForFallback('australia', 'india')).toBe(false);
  });
  it('India source rejects an Australia-specific candidate', () => {
    expect(isJurisdictionCompatibleForFallback('india', 'australia')).toBe(false);
  });
  it('cross-border source or candidate bridges Australia and India', () => {
    expect(isJurisdictionCompatibleForFallback('australia_india_cross_border', 'india')).toBe(true);
    expect(isJurisdictionCompatibleForFallback('australia', 'australia_india_cross_border')).toBe(true);
  });
  it('Global source only pairs with Global fallback candidates', () => {
    expect(isJurisdictionCompatibleForFallback('global', 'global')).toBe(true);
    expect(isJurisdictionCompatibleForFallback('global', 'australia')).toBe(false);
  });
});

describe('R1.6 scoreFallbackCandidate (documented weights, spec §35)', () => {
  it('same category scores +5', () => {
    const score = scoreFallbackCandidate({ sameCategory: true, sharesTag: false, jurisdiction: 'global', sourceJurisdiction: 'global', contentType: 'money_update', sourceContentType: 'article' });
    // +5 category, +0 jurisdiction (global==global counted separately below), money_update -3
    expect(score).toBeGreaterThanOrEqual(5 - 3);
  });
  it('shared tag scores +3 flat regardless of tag count', () => {
    const a = scoreFallbackCandidate({ sameCategory: false, sharesTag: true, jurisdiction: 'india', sourceJurisdiction: 'australia', contentType: 'article', sourceContentType: 'guide' });
    // sharesTag(+3) + complementary type(+1, article!=guide, both evergreen) ; jurisdiction none of exact/global -> +0
    expect(a).toBe(3 + 1);
  });
  it('exact jurisdiction match outscores a Global-only match', () => {
    const exact = scoreFallbackCandidate({ sameCategory: false, sharesTag: false, jurisdiction: 'india', sourceJurisdiction: 'india', contentType: 'video', sourceContentType: 'video' });
    const global = scoreFallbackCandidate({ sameCategory: false, sharesTag: false, jurisdiction: 'global', sourceJurisdiction: 'india', contentType: 'video', sourceContentType: 'video' });
    expect(exact).toBeGreaterThan(global);
  });
  it('Money Update fallback candidates are penalised -3 (spec §37 — should not dominate evergreen suggestions)', () => {
    const moneyUpdate = scoreFallbackCandidate({ sameCategory: true, sharesTag: false, jurisdiction: 'global', sourceJurisdiction: 'global', contentType: 'money_update', sourceContentType: 'article' });
    const article = scoreFallbackCandidate({ sameCategory: true, sharesTag: false, jurisdiction: 'global', sourceJurisdiction: 'global', contentType: 'article', sourceContentType: 'guide' });
    expect(moneyUpdate).toBeLessThan(article);
  });
  it('complementary evergreen type scores +1, same type as source scores +0 for that component', () => {
    const complementary = scoreFallbackCandidate({ sameCategory: false, sharesTag: false, jurisdiction: 'global', sourceJurisdiction: 'global', contentType: 'guide', sourceContentType: 'article' });
    const sameType = scoreFallbackCandidate({ sameCategory: false, sharesTag: false, jurisdiction: 'global', sourceJurisdiction: 'global', contentType: 'article', sourceContentType: 'article' });
    expect(complementary).toBeGreaterThan(sameType);
  });
});

describe('R1.6 related content limit', () => {
  it('RELATED_CONTENT_LIMIT matches spec §31\'s stated maximum of 4', () => {
    expect(RELATED_CONTENT_LIMIT).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Context registry (spec §55-58, §96, §101)
// ---------------------------------------------------------------------------
describe('R1.6 context registry', () => {
  it('a known registered key is accepted', () => {
    expect(isRegisteredContextKey('dashboard.savings_rate')).toBe(true);
  });
  it('an unknown context key is rejected (spec §96)', () => {
    expect(isRegisteredContextKey('r1.6.invalid.context')).toBe(false);
  });
  it('getContextDefinition returns null for an unregistered key', () => {
    expect(getContextDefinition('does.not.exist')).toBeNull();
  });
  it('getContextDefinition returns the full definition for a registered key', () => {
    const def = getContextDefinition('scores.financial_health_score');
    expect(def).not.toBeNull();
    expect(def!.route).toBe('/score');
    expect(def!.module).toBe('Scores');
  });
  it('every registered context route is a well-formed internal route (spec §101 — no broken/external route)', () => {
    for (const c of FHIP_CONTEXTS) {
      expect(isWellFormedInternalRoute(c.route), `${c.key} -> ${c.route}`).toBe(true);
    }
  });
  it('every registered context route is itself in the verified FHIP module route allowlist', () => {
    for (const c of FHIP_CONTEXTS) {
      expect(FHIP_MODULE_ROUTES, `${c.key} -> ${c.route} not in FHIP_MODULE_ROUTES`).toContain(c.route);
    }
  });
  it('isWellFormedInternalRoute rejects protocol-relative and external-looking values', () => {
    expect(isWellFormedInternalRoute('//evil.example')).toBe(false);
    expect(isWellFormedInternalRoute('https://evil.example')).toBe(false);
    expect(isWellFormedInternalRoute('javascript:alert(1)')).toBe(false);
  });
  it('isWellFormedInternalRoute accepts a plain internal path', () => {
    expect(isWellFormedInternalRoute('/forecast/net-worth')).toBe(true);
  });
  it('no duplicate context keys exist in the registry', () => {
    const keys = FHIP_CONTEXTS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// CTA destination safety (spec §44-46, §93, §105)
// ---------------------------------------------------------------------------
describe('R1.6 CTA destination safety', () => {
  it('rejects javascript: for every destination type (spec §93 — DENIED)', () => {
    for (const type of ['internal_resource', 'fhip_module', 'registration', 'external', 'youtube'] as const) {
      expect(validateCtaDestination(type, "javascript:alert('R1.6')").valid, type).toBe(false);
    }
  });
  it('rejects data: URIs', () => {
    expect(validateCtaDestination('external', 'data:text/html,<script>alert(1)</script>').valid).toBe(false);
  });
  it('rejects a protocol-relative URL as an internal_resource destination', () => {
    expect(isSafeInternalPath('//evil.example/steal')).toBe(false);
  });
  it('internal_resource requires a /resources/... path', () => {
    expect(validateCtaDestination('internal_resource', '/resources/emergency-fund-guide').valid).toBe(true);
    expect(validateCtaDestination('internal_resource', '/dashboard').valid).toBe(false);
  });
  it('fhip_module requires a route on the verified allowlist', () => {
    expect(validateCtaDestination('fhip_module', '/dashboard').valid).toBe(true);
    expect(validateCtaDestination('fhip_module', '/not-a-real-route').valid).toBe(false);
  });
  it('registration only accepts /signup or /login', () => {
    expect(validateCtaDestination('registration', '/signup').valid).toBe(true);
    expect(validateCtaDestination('registration', '/login').valid).toBe(true);
    expect(validateCtaDestination('registration', '/admin').valid).toBe(false);
  });
  it('external requires https:', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
  });
  it('youtube requires an https youtube.com/youtu.be host', () => {
    expect(isSafeYoutubeUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isSafeYoutubeUrl('https://youtu.be/abc123')).toBe(true);
    expect(isSafeYoutubeUrl('https://evil.example/youtube.com')).toBe(false);
  });
  it('empty destination is rejected regardless of type', () => {
    expect(validateCtaDestination('external', '').valid).toBe(false);
    expect(validateCtaDestination('external', '   ').valid).toBe(false);
  });
});

describe('R1.6 validateCta (full form)', () => {
  it('rejects a blank label (spec §52)', () => {
    const result = validateCta({ name: 'x', label: '', destination_type: 'external', destination_url: 'https://example.com' });
    expect(result.valid).toBe(false);
    expect(result.errors.label).toBeTruthy();
  });
  it('rejects a blank name', () => {
    const result = validateCta({ name: '', label: 'Check Your Financial Health', destination_type: 'registration', destination_url: '/signup' });
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeTruthy();
  });
  it('accepts a fully valid CTA', () => {
    const result = validateCta({ name: 'Signup CTA', label: 'Check Your Financial Health', destination_type: 'registration', destination_url: '/signup' });
    expect(result.valid).toBe(true);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });
  it('rejects an unsafe destination even with a valid label/name', () => {
    const result = validateCta({ name: 'Bad CTA', label: 'Click here', destination_type: 'external', destination_url: "javascript:alert(1)" });
    expect(result.valid).toBe(false);
    expect(result.errors.destination_url).toBeTruthy();
  });
});
