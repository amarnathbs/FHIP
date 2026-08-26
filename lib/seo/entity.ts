// FHIP entity / domain-identity constants and structured-data builders.
//
// Built for the Google Search Entity, Domain Identity & AI Overview
// Remediation task (docs/google-entity-remediation/). Single source of
// truth for the facts this task is allowed to assert about FHIP as a
// product/organization entity — every public page's metadata and JSON-LD
// should import from here rather than re-declaring these strings, so the
// brand/entity signal stays consistent by construction instead of by
// convention.
//
// Hard rule this file exists to enforce: do not invent corporate facts
// (ABN, ACN, registered address, licences, accreditation, customer counts,
// reviews, awards, social profiles, etc.). Every value below is either
// pulled from real repository configuration (the base URL) or is the
// literal brand/name text the Product Owner specified directly. Nothing
// here is fabricated. Where a fact cannot be established, it is simply
// omitted (see buildFhipEntityJsonLd's Organization node, which has no
// `sameAs` social-profile entries because none genuinely exist yet).

import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';

/** The short brand name. Always use this, never a generic paraphrase, as the primary identifier. */
export const FHIP_BRAND_NAME = 'FHIP';

/** The expanded/full product name FHIP is short for. */
export const FHIP_EXPANDED_NAME = 'Financial Health Intelligence Platform';

/** Preferred short public presentation (browser tab, share cards, nav lockup). */
export const FHIP_PRODUCT_PRESENTATION = 'FHIP | Financial Health';

/**
 * Product-Owner-designated public brand entry point (spec §4/§9). Live-verified
 * (docs/google-entity-remediation/01-domain-inventory.md) to 301-redirect,
 * preserving path and query, to the application host below. It has no
 * independent content of its own — the redirect happens at the Cloudflare
 * layer, outside this repository — but it is the domain FHIP's public
 * marketing identity is meant to be anchored to.
 */
export const FHIP_BRAND_URL = 'https://myfhip.com';

/**
 * The related root domain that is part of FHIP's infrastructure/history
 * (spec §4) but currently has **no DNS record at all** — confirmed live,
 * see 01-domain-inventory.md. Intentionally NOT used as a `url` value
 * anywhere in the structured data below: asserting a URL that does not
 * resolve would be a false technical claim, not a legitimate entity
 * relationship. Exists here only so callers building human-readable
 * "official domains" copy (About/Security pages) can reference it by name
 * without hardcoding the string in multiple places.
 */
export const FHIP_ROOT_DOMAIN_HOSTNAME = 'financialhealthplatform.com';

/**
 * The application URL. Reuses the exact same base-URL resolution already
 * used by the Resources public metadata module (`APP_BASE_URL` env var,
 * falling back to localhost in development) rather than hardcoding a
 * second, potentially-diverging constant.
 */
export function getFhipApplicationUrl(): string {
  return getPublicSiteBaseUrl();
}

/** The two domains this task can factually call "official FHIP domains". */
export function getFhipOfficialDomains(): { brand: string; application: string } {
  return { brand: FHIP_BRAND_URL, application: getFhipApplicationUrl() };
}

// --- Structured data (Phase 5-8) --------------------------------------------
//
// Entity graph: Organization <-publisher- WebSite <-isPartOf- WebApplication.
// All three nodes are anchored (their @id) on the application host, because
// that is the domain that actually serves this markup and can be
// dereferenced/crawled — myfhip.com never serves a page of its own (it is a
// pure redirect), so anchoring @id there would point at a URL search
// engines can never fetch this JSON-LD from. The *content* of the nodes is
// what carries the cross-domain relationship:
//   - Organization.url and WebSite.url are set to the PO-designated brand
//     URL (myfhip.com) — the entity's stated primary public address.
//   - Organization.sameAs includes the application URL — a legitimate use
//     of sameAs (per Google's own Organization guidance: "other web
//     references that unambiguously indicate the item's identity"), since
//     app.financialhealthplatform.com is genuinely FHIP's own,
//     FHIP-controlled URL, not an unrelated third party.
//   - WebApplication.isPartOf ties the application back to the WebSite
//     node, and WebApplication.publisher ties it to the same Organization.
// No `sameAs` entry is used to imply myfhip.com and the application are
// interchangeable duplicates of unrelated content — they are correctly
// modelled as distinct nodes (a website identity and a software
// application) sharing one publisher, which is the semantically accurate
// relationship per spec §8's evaluation criteria.
export function buildFhipEntityJsonLd(): object[] {
  const appUrl = getFhipApplicationUrl();
  const orgId = `${appUrl}/#organization`;
  const websiteId = `${appUrl}/#website`;
  const webAppId = `${appUrl}/#webapp`;

  const organization = {
    '@type': 'Organization',
    '@id': orgId,
    name: FHIP_BRAND_NAME,
    alternateName: FHIP_EXPANDED_NAME,
    url: FHIP_BRAND_URL,
    logo: {
      '@type': 'ImageObject',
      url: `${appUrl}/images/fhip-logo-mark.png`,
    },
    // Genuinely FHIP's own URL, not a fabricated third-party profile — see
    // module comment above.
    sameAs: [appUrl],
  };

  const website = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: FHIP_BRAND_URL,
    name: FHIP_BRAND_NAME,
    alternateName: [FHIP_EXPANDED_NAME, FHIP_PRODUCT_PRESENTATION],
    publisher: { '@id': orgId },
  };

  const webApplication = {
    '@type': 'WebApplication',
    '@id': webAppId,
    name: FHIP_BRAND_NAME,
    alternateName: FHIP_EXPANDED_NAME,
    url: appUrl,
    // Real functional category — a personal financial information,
    // analysis and intelligence tool. Not a finance/banking regulated
    // application category, and no adviser/lender/institution claim.
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    isPartOf: { '@id': websiteId },
    publisher: { '@id': orgId },
  };

  return [organization, website, webApplication];
}

// --- robots.txt (Phase 19) --------------------------------------------------
//
// Allowlist approach rather than an enumerated disallow-list: everything is
// disallowed by default, and only the specific, genuinely-public marketing
// paths are allowed back in. Google resolves robots.txt rules by longest
// (most specific) path match, not by declaration order, so `disallow: '/'`
// alongside a more specific `allow: '/resources'` correctly allows
// /resources/* while still blocking everything else. This is deliberately
// safer than hand-listing every private route (dashboard, forecast,
// investment-intelligence, admin, api, auth, onboarding, print, ...): a
// newly-added private feature is blocked by default instead of silently
// falling through an incomplete disallow list.
export const ROBOTS_PUBLIC_PATHS = ['/about', '/security', '/contact', '/privacy', '/terms', '/resources'] as const;

// --- sitemap.ts (Phase 20) --------------------------------------------------
//
// Genuinely public, indexable, non-authenticated marketing pages. Kept as a
// pure data list (no I/O) so it can be unit-tested directly and imported by
// app/sitemap.ts without duplicating the list of paths.
export const PUBLIC_MARKETING_SITEMAP_PATHS: { path: string; changeFrequency: 'daily' | 'weekly' | 'monthly'; priority: number }[] = [
  { path: '', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/contact', changeFrequency: 'monthly', priority: 0.3 },
  { path: '/privacy', changeFrequency: 'monthly', priority: 0.2 },
  { path: '/terms', changeFrequency: 'monthly', priority: 0.2 },
];
