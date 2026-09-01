// G2 — Landing-Page Localisation: the ONE controlled marketing-price
// configuration source (spec section 10: "AU/IN marketing prices must come
// from ONE controlled configuration source, not duplicated component
// strings"). components/marketing/LandingPage.tsx imports these values
// rather than hardcoding currency/amount strings a second time.
//
// These are MARKETING DISPLAY values only — never billing entitlement, a
// price ID, or an amount passed to any checkout/payment call (none exists
// in this codebase — see lib/services/billingAuthority.ts's own header).
// Approved by the Product Owner (G2 spec section 1's pricing table, and
// re-confirmed unchanged in the 2026-09-02 AU/IN/Global clarification); AU
// figures also match the pre-existing static price already live in
// components/marketing/LandingPage.tsx before this task (A$9.99/mo,
// A$99/yr) — no repository documentation or PO decision record found that
// conflicts with either figure.
//
// 'GLOBAL' deliberately has NO price entry here (PO clarification, spec
// section 2): "If no approved Global price exists, use neutral wording" —
// see GLOBAL_PRICING_COPY below. No USD/GBP/SGD/AED price or exchange rate
// is invented anywhere in this module.
export interface LandingMarketingPrice {
  currencyCode: 'AUD' | 'INR';
  symbol: string;
  monthly: string;
  annual: string;
  annualEquivalentMonthly: string;
}

export const LANDING_MARKETING_PRICES: Record<'AU' | 'IN', LandingMarketingPrice> = {
  AU: {
    currencyCode: 'AUD',
    symbol: 'A$',
    monthly: '9.99',
    annual: '99',
    annualEquivalentMonthly: '8.25',
  },
  IN: {
    currencyCode: 'INR',
    symbol: '₹',
    monthly: '99',
    annual: '990',
    annualEquivalentMonthly: '82.50',
  },
};

/**
 * Does a resolved pricing region have an approved, displayable marketing
 * price at all? GLOBAL and UNAVAILABLE never do — the landing page must
 * show neutral wording (GLOBAL_PRICING_COPY) or prompt for country
 * selection rather than default to AU or IN (spec section 9/10, PO
 * clarification section 2).
 */
export function getLandingMarketingPrice(
  pricingRegion: 'AU' | 'IN' | 'GLOBAL' | 'UNAVAILABLE'
): LandingMarketingPrice | null {
  if (pricingRegion === 'AU' || pricingRegion === 'IN') return LANDING_MARKETING_PRICES[pricingRegion];
  return null;
}

/**
 * PO-mandated exact neutral wording for the Global pricing bucket (spec
 * section 2): "If no approved Global price exists, use neutral wording:
 * 'Select or confirm your billing country before payment options are
 * shown.'" Does not imply a Global payment path is operational — none
 * exists (no checkout backend exists in this codebase for ANY region).
 */
export const GLOBAL_PRICING_COPY = 'Select or confirm your billing country before payment options are shown.';

/**
 * PO-mandated exact explanatory copy for the Global experience bucket (spec
 * section 2): "Global provides jurisdiction-neutral financial-health
 * functionality."
 */
export const GLOBAL_EXPERIENCE_COPY = 'Global provides jurisdiction-neutral financial-health functionality.';
