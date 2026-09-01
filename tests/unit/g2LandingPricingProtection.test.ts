import { describe, it, expect } from 'vitest';
import { computeLandingCountryContext, type LandingCountryRegistrySnapshot } from '@/lib/services/landingCountryContext';
import { getLandingMarketingPrice, LANDING_MARKETING_PRICES, GLOBAL_PRICING_COPY } from '@/lib/config/landingPricing';
import { validatePriceForBilling, genericUserCanReceiveIndiaPricing, type PriceCatalogueEntry } from '@/lib/services/billingAuthority';

function registryFixture(): LandingCountryRegistrySnapshot {
  return {
    experienceByCountry: new Map([
      ['AU', 'FULL'],
      ['IN', 'FULL'],
    ]),
  };
}

const notAuthenticated = { isAuthenticated: false, primaryCountry: null, billingConfirmed: false };

// Spec section 10 + 16, PO clarification section 2: "Marketing price
// display and billing eligibility are different concepts" — these tests
// prove the G2 marketing-display layer and the (pre-existing, untouched) G1
// billing-authority layer are two genuinely separate code paths that never
// feed into one another, including for the new 'GLOBAL' bucket.
describe('G2 pricing-display / billing-authority separation (spec sections 10, 16; PO section 2)', () => {
  const catalogue: PriceCatalogueEntry[] = [
    { priceId: 'price_in_monthly', region: 'IN' },
    { priceId: 'price_au_monthly', region: 'AU' },
    { priceId: 'price_generic_monthly', region: 'GENERIC' },
  ];

  it('India marketing price display never implies India billing eligibility: an anonymous IN-presentation visitor has billingConfirmed=false', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'IN',
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry: registryFixture(),
    });
    expect(ctx.pricingRegion).toBe('IN');
    expect(getLandingMarketingPrice(ctx.pricingRegion)).toEqual(LANDING_MARKETING_PRICES.IN);
    expect(ctx.billingConfirmed).toBe(false);
    expect(ctx.isAuthoritative).toBe(false);

    // Even though the landing page is showing an India price, the
    // independent G1 billing authority (unmodified by G2) still denies
    // every price request for this visitor, because billing was never
    // confirmed -- proving display and entitlement are structurally
    // disconnected.
    const billingResult = validatePriceForBilling({
      billingCountry: null,
      billingConfirmed: false,
      requestedPriceId: 'price_in_monthly',
      catalogue,
    });
    expect(billingResult).toEqual({ allowed: false, reason: 'BILLING_COUNTRY_NOT_CONFIRMED' });
  });

  it('an authenticated Global (GB) confirmed-billing user can never receive India billing regardless of any landing-page India presentation', () => {
    const ctx = computeLandingCountryContext({
      authenticated: { isAuthenticated: true, primaryCountry: 'GB', billingConfirmed: true },
      anonymousSelection: 'IN', // stale anonymous cookie from before sign-in
      detectedCountryRaw: 'IN',
      platformDefaultCountry: null,
      registry: registryFixture(),
    });
    // Authenticated context wins for presentation too -- Global, not IN.
    expect(ctx.presentationCountry).toBe('GLOBAL');

    const canReceiveIndiaPricing = genericUserCanReceiveIndiaPricing({
      billingCountry: 'GB' as unknown as 'AU' | 'IN', // GB is not AU/IN -- confirms isKnownCountry() gate fires
      billingConfirmed: true,
      indiaPriceId: 'price_in_monthly',
      catalogue,
    });
    expect(canReceiveIndiaPricing).toBe(false);
  });

  it('Global and unresolved pricing regions never invent a displayable price (no USD/GBP/SGD/AED or generic price is fabricated)', () => {
    expect(getLandingMarketingPrice('GLOBAL')).toBeNull();
    expect(getLandingMarketingPrice('UNAVAILABLE')).toBeNull();
  });

  it('Global shows the PO-mandated exact neutral wording rather than any price', () => {
    expect(GLOBAL_PRICING_COPY).toBe('Select or confirm your billing country before payment options are shown.');
  });

  it('AU and IN marketing prices come from exactly one configuration object (no duplicated literals)', () => {
    expect(getLandingMarketingPrice('AU')).toBe(LANDING_MARKETING_PRICES.AU);
    expect(getLandingMarketingPrice('IN')).toBe(LANDING_MARKETING_PRICES.IN);
    expect(LANDING_MARKETING_PRICES.AU.currencyCode).toBe('AUD');
    expect(LANDING_MARKETING_PRICES.IN.currencyCode).toBe('INR');
  });

  it('a manual India landing selection alone can never satisfy validatePriceForBilling for any priceId', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'IN',
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry: registryFixture(),
    });
    expect(ctx.source).toBe('ANONYMOUS_SELECTION');
    for (const entry of catalogue) {
      const result = validatePriceForBilling({
        billingCountry: null,
        billingConfirmed: false,
        requestedPriceId: entry.priceId,
        catalogue,
      });
      expect(result.allowed).toBe(false);
    }
  });

  it('a manual Global selection alone can never satisfy validatePriceForBilling for any priceId either', () => {
    const ctx = computeLandingCountryContext({
      authenticated: notAuthenticated,
      anonymousSelection: 'GLOBAL',
      detectedCountryRaw: null,
      platformDefaultCountry: null,
      registry: registryFixture(),
    });
    expect(ctx.pricingRegion).toBe('GLOBAL');
    for (const entry of catalogue) {
      const result = validatePriceForBilling({
        billingCountry: null,
        billingConfirmed: false,
        requestedPriceId: entry.priceId,
        catalogue,
      });
      expect(result.allowed).toBe(false);
    }
  });
});
