// Phase 29 — SEO / entity assertion tests for the Google Search Entity,
// Domain Identity & AI Overview Remediation task
// (docs/google-entity-remediation/). Behaviour-level tests against the
// pure, I/O-free builders in lib/seo/entity.ts — deliberately not testing
// the Next.js route files (app/robots.ts, app/sitemap.ts) directly, since
// those require mocking next/headers/cookies() and the Supabase server
// client for no additional confidence; the route files are thin wrappers
// over these same exported constants/functions.

import { describe, expect, it } from 'vitest';
import {
  FHIP_BRAND_NAME,
  FHIP_BRAND_URL,
  FHIP_EXPANDED_NAME,
  FHIP_PRODUCT_PRESENTATION,
  FHIP_ROOT_DOMAIN_HOSTNAME,
  ROBOTS_PUBLIC_PATHS,
  PUBLIC_MARKETING_SITEMAP_PATHS,
  buildFhipEntityJsonLd,
  getFhipApplicationUrl,
  getFhipOfficialDomains,
} from '@/lib/seo/entity';

describe('FHIP brand identity constants', () => {
  it('defines the brand name, expanded name, and product presentation exactly as specified', () => {
    expect(FHIP_BRAND_NAME).toBe('FHIP');
    expect(FHIP_EXPANDED_NAME).toBe('Financial Health Intelligence Platform');
    expect(FHIP_PRODUCT_PRESENTATION).toBe('FHIP | Financial Health');
  });

  it('the product presentation always starts with the bare brand name (brand-first, not generic-first)', () => {
    expect(FHIP_PRODUCT_PRESENTATION.startsWith(FHIP_BRAND_NAME)).toBe(true);
  });

  it('does not invent a URL for the non-resolving root domain', () => {
    // financialhealthplatform.com has no DNS record at all (live-verified,
    // see docs/google-entity-remediation/01-domain-inventory.md) — this
    // constant must stay a bare hostname for human-readable copy, never
    // promoted to a URL used in structured data or metadata.
    expect(FHIP_ROOT_DOMAIN_HOSTNAME).toBe('financialhealthplatform.com');
    expect(FHIP_ROOT_DOMAIN_HOSTNAME.startsWith('http')).toBe(false);
  });
});

describe('getFhipOfficialDomains', () => {
  it('returns exactly the two live-verified official domains, no more', () => {
    const domains = getFhipOfficialDomains();
    expect(domains.brand).toBe(FHIP_BRAND_URL);
    expect(domains.application).toBe(getFhipApplicationUrl());
    expect(Object.keys(domains).sort()).toEqual(['application', 'brand']);
  });

  it('never includes the non-resolving root domain as a URL', () => {
    const domains = getFhipOfficialDomains();
    expect(Object.values(domains).some((url) => url.includes(FHIP_ROOT_DOMAIN_HOSTNAME) && !url.includes('app.'))).toBe(
      false,
    );
  });
});

describe('buildFhipEntityJsonLd', () => {
  const nodes = buildFhipEntityJsonLd() as Record<string, unknown>[];

  it('emits exactly three nodes: Organization, WebSite, WebApplication', () => {
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n['@type'])).toEqual(['Organization', 'WebSite', 'WebApplication']);
  });

  it('every node has a stable, unique, non-empty @id', () => {
    const ids = nodes.map((n) => n['@id']);
    expect(ids.every((id) => typeof id === 'string' && (id as string).length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate IDs
  });

  it('every @id is anchored on the real application host, not the redirecting brand domain', () => {
    const appUrl = getFhipApplicationUrl();
    for (const node of nodes) {
      expect((node['@id'] as string).startsWith(appUrl)).toBe(true);
    }
  });

  it('Organization and WebSite declare the brand URL (myfhip.com) as their url, per PO intent (spec §4/§9)', () => {
    const org = nodes.find((n) => n['@type'] === 'Organization')!;
    const site = nodes.find((n) => n['@type'] === 'WebSite')!;
    expect(org.url).toBe(FHIP_BRAND_URL);
    expect(site.url).toBe(FHIP_BRAND_URL);
  });

  it('WebApplication declares the real application URL as its url (not forced to the marketing domain)', () => {
    const webApp = nodes.find((n) => n['@type'] === 'WebApplication')!;
    expect(webApp.url).toBe(getFhipApplicationUrl());
  });

  it('WebSite is published by Organization, and WebApplication is part of WebSite and published by Organization', () => {
    const org = nodes.find((n) => n['@type'] === 'Organization')!;
    const site = nodes.find((n) => n['@type'] === 'WebSite')!;
    const webApp = nodes.find((n) => n['@type'] === 'WebApplication')!;

    expect((site.publisher as { '@id': string })['@id']).toBe(org['@id']);
    expect((webApp.publisher as { '@id': string })['@id']).toBe(org['@id']);
    expect((webApp.isPartOf as { '@id': string })['@id']).toBe(site['@id']);
  });

  it('Organization.sameAs only ever contains FHIP-controlled URLs, never a fabricated or unrelated third-party profile', () => {
    const org = nodes.find((n) => n['@type'] === 'Organization')!;
    const sameAs = org.sameAs as string[];
    expect(Array.isArray(sameAs)).toBe(true);
    for (const url of sameAs) {
      const isOwnBrandUrl = url === FHIP_BRAND_URL;
      const isOwnAppUrl = url === getFhipApplicationUrl();
      expect(isOwnBrandUrl || isOwnAppUrl).toBe(true);
    }
    // Never contains a bare, non-resolving domain as an asserted URL.
    expect(sameAs.some((url) => url === `https://${FHIP_ROOT_DOMAIN_HOSTNAME}`)).toBe(false);
  });

  it('alternateName fields consistently surface the expanded name and/or the product presentation, never a bare generic phrase alone', () => {
    for (const node of nodes) {
      if (!node.alternateName) continue;
      const values = Array.isArray(node.alternateName) ? node.alternateName : [node.alternateName];
      for (const v of values as string[]) {
        expect(v === FHIP_EXPANDED_NAME || v === FHIP_PRODUCT_PRESENTATION).toBe(true);
      }
    }
  });

  it('does not assert any fabricated corporate fact (ABN/ACN/registered address/licence/regulator/award/review-count keywords)', () => {
    const serialised = JSON.stringify(nodes).toLowerCase();
    const forbiddenTokens = [
      'abn',
      'acn',
      'license',
      'licence',
      'accredited',
      'registered office',
      'award',
      'reviews',
      'financial adviser',
      'bank',
      'insurer',
    ];
    for (const token of forbiddenTokens) {
      expect(serialised.includes(token)).toBe(false);
    }
  });

  it('JSON-serialises without throwing and without circular references', () => {
    expect(() => JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes })).not.toThrow();
  });
});

describe('ROBOTS_PUBLIC_PATHS', () => {
  it('is a fixed allowlist of genuinely public marketing paths, containing no private/app/api route', () => {
    const forbiddenSubstrings = ['/api', '/dashboard', '/admin', '/forecast', '/investment', '/onboarding', '/login', '/signup'];
    for (const path of ROBOTS_PUBLIC_PATHS) {
      expect(path.startsWith('/')).toBe(true);
      for (const bad of forbiddenSubstrings) {
        expect(path.includes(bad)).toBe(false);
      }
    }
  });

  it('includes every dedicated public page this task adds or audits', () => {
    for (const expected of ['/about', '/security', '/contact', '/privacy', '/terms', '/resources']) {
      expect(ROBOTS_PUBLIC_PATHS).toContain(expected);
    }
  });
});

describe('PUBLIC_MARKETING_SITEMAP_PATHS', () => {
  it('includes the homepage and every public marketing page with a valid changeFrequency/priority', () => {
    const paths = PUBLIC_MARKETING_SITEMAP_PATHS.map((e) => e.path);
    expect(paths).toEqual(['', '/about', '/security', '/contact', '/privacy', '/terms']);

    for (const entry of PUBLIC_MARKETING_SITEMAP_PATHS) {
      expect(['daily', 'weekly', 'monthly']).toContain(entry.changeFrequency);
      expect(entry.priority).toBeGreaterThan(0);
      expect(entry.priority).toBeLessThanOrEqual(1);
    }
  });

  it('never includes an authenticated/private route', () => {
    const forbidden = ['/dashboard', '/admin', '/api', '/forecast', '/login', '/signup', '/onboarding'];
    for (const entry of PUBLIC_MARKETING_SITEMAP_PATHS) {
      for (const bad of forbidden) {
        expect(entry.path.includes(bad)).toBe(false);
      }
    }
  });
});
