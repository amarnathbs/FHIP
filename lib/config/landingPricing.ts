// G2 — Landing-Page Localisation: the ONE controlled marketing-price
// configuration source (spec section 10: "AU/IN marketing prices must come
// from ONE controlled configuration source, not duplicated component
// strings"). components/marketing/LandingPage.tsx imports these values
// rather than hardcoding currency/amount strings a second time.
//
// These are MARKETING DISPLAY values only — never billing entitlement, a
// price ID, or an amount passed to any checkout/payment call (none exists
// in this codebase — see lib/services/billingAuthority.ts's own header).
// Approved by the Product Owner (G2 spec section 1's pricing table);
// AU figures also match the pre-existing static price already live in
// components/marketing/LandingPage.tsx before this task (A$9.99/mo,
// A$99/yr) — no repository documentation or PO decision record found that
// conflicts with either figure (verified during G2 baseline discovery).
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
 * price at all? GENERIC and UNAVAILABLE regions never do — the landing page
 * must prompt for country selection or show a neutral "pricing varies"
 * message rather than default to AU or IN (spec section 9/10).
 */
export function getLandingMarketingPrice(
  pricingRegion: 'AU' | 'IN' | 'GENERIC' | 'UNAVAILABLE'
): LandingMarketingPrice | null {
  if (pricingRegion === 'AU' || pricingRegion === 'IN') return LANDING_MARKETING_PRICES[pricingRegion];
  return null;
}
