// G1 Country Foundation (spec section 17) — the billing-region authority
// boundary. This module exists ahead of any real checkout implementation:
// repo-wide search (this task's own G0-D3 finding) confirms NO payment
// provider integration exists anywhere in this codebase today (no Stripe/
// Razorpay/PayPal, no checkout/subscription API route, no price-ID field —
// see docs/jurisdiction-applicability/G1_Country_Foundation_G0_Delta.md
// finding G0-D3-1). The landing page (components/marketing/LandingPage.tsx)
// shows one static AUD price to every visitor unconditionally; there is no
// India price shown anywhere, and no code path reads a "landing default" to
// pick a price. This module is therefore forward-looking scaffolding for
// G5's future checkout, not a patch to a live defect — but it is written and
// tested NOW so that whenever a real price catalogue/checkout route is
// built, it has one pre-certified authority function to call rather than
// inventing ad hoc country-to-price logic.
//
// Every rule below is a pure function of (billingCountry, billingConfirmed,
// requestedPriceRegion) — it never consults currency, detected/anonymous
// country, or a client-supplied "region" string as if it were confirmed
// billing authority (spec section 17's explicit list of things that are NOT
// billing country).
import { isFullExperienceCountry, type CountryCode } from '@/lib/services/jurisdiction';

export interface PriceCatalogueEntry {
  priceId: string;
  region: CountryCode | 'GENERIC';
}

export type PriceValidationResult =
  | { allowed: true; priceId: string; region: CountryCode | 'GENERIC' }
  | { allowed: false; reason: PriceDenialReason };

export type PriceDenialReason =
  | 'BILLING_COUNTRY_NOT_CONFIRMED'
  | 'PRICE_ID_UNKNOWN'
  | 'PRICE_REGION_MISMATCH'
  | 'REGION_NOT_APPROVED_FOR_BILLING';

/**
 * Server-side price-region validation (spec section 17). Never trusts a
 * client-submitted region — only the price ID is taken from the client; the
 * region a price ID belongs to comes from the server-held catalogue, and the
 * billing country comes only from the caller's own CONFIRMED
 * billing_country (never currency, never detected/anonymous country, never
 * residence used silently). Missing billing confirmation fails closed
 * (spec: "Missing billing region must fail closed").
 *
 * This directly proves the spec's central question: "can a generic
 * international user receive India pricing merely because the landing page
 * defaults to India?" — with billingCountry unconfirmed (the fail-closed
 * default for every user, spec section 12: "Do not backfill confirmed
 * billing country"), EVERY price request is denied, India or otherwise;
 * with billingCountry confirmed as some GENERIC country, an India-region
 * price ID is denied by REGION_NOT_APPROVED_FOR_BILLING regardless of what
 * currency the user reports in or what the landing page ever showed them.
 */
export function validatePriceForBilling(params: {
  billingCountry: CountryCode | null;
  billingConfirmed: boolean;
  requestedPriceId: string;
  catalogue: readonly PriceCatalogueEntry[];
}): PriceValidationResult {
  const { billingCountry, billingConfirmed, requestedPriceId, catalogue } = params;

  // G3 NO-REGRESSION NARROWING. This check used to read
  // `!isKnownCountry(billingCountry)`, and isKnownCountry() covered exactly
  // AU and IN. G3 widened that vocabulary to six countries, which would have
  // silently CHANGED this pure function's behaviour: a confirmed GB billing
  // country would have started falling through to the catalogue lookup and
  // could have been allowed a GENERIC-region price, where before G3 it was
  // always denied.
  //
  // That would have been a weakening of an already-certified negative
  // control, achieved by accident, in a phase whose scope explicitly forbids
  // "locally certified pricing or checkout" for generic countries and forbids
  // confirming a billing country at all. So the check is pinned to the
  // FULL-experience countries, which preserves this function's pre-G3
  // behaviour byte-for-byte for every possible input.
  //
  // Generic-country billing therefore remains unreachable by three
  // independent means: this check, the fact that
  // /api/user/billing-country/confirm still uses the non-generic guard, and
  // APPROVED_BILLING being false for every country in the registry.
  if (!billingConfirmed || !billingCountry || !isFullExperienceCountry(billingCountry)) {
    return { allowed: false, reason: 'BILLING_COUNTRY_NOT_CONFIRMED' };
  }

  const entry = catalogue.find((c) => c.priceId === requestedPriceId);
  if (!entry) {
    return { allowed: false, reason: 'PRICE_ID_UNKNOWN' };
  }

  // A GENERIC-region price (no country-specific pricing at all) is
  // acceptable for any confirmed billing country; a country-specific price
  // (e.g. an India price) is only valid when the confirmed billing country
  // matches exactly — never approximated from currency, residence, or a
  // "close enough" region.
  if (entry.region !== 'GENERIC' && entry.region !== billingCountry) {
    return { allowed: false, reason: 'PRICE_REGION_MISMATCH' };
  }

  return { allowed: true, priceId: entry.priceId, region: entry.region };
}

/**
 * Spec section 17's explicit named failure mode, proven as its own function
 * so it can be asserted directly rather than only indirectly through
 * validatePriceForBilling(): a GENERIC (non-AU/IN) confirmed billing country
 * requesting an India-region price is always denied, regardless of currency
 * or any anonymous/detected/landing-default signal (none of which this
 * function even accepts as a parameter — they are structurally incapable of
 * influencing the outcome).
 */
export function genericUserCanReceiveIndiaPricing(params: {
  billingCountry: CountryCode | null;
  billingConfirmed: boolean;
  indiaPriceId: string;
  catalogue: readonly PriceCatalogueEntry[];
}): boolean {
  const result = validatePriceForBilling({
    billingCountry: params.billingCountry,
    billingConfirmed: params.billingConfirmed,
    requestedPriceId: params.indiaPriceId,
    catalogue: params.catalogue,
  });
  return result.allowed;
}
