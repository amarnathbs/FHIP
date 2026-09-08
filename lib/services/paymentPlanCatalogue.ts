// LR-10 WP-03 — Plan catalogue. Separates DISPLAY/presentation localisation
// (lib/config/landingPricing.ts's already-approved marketing figures, reused
// here verbatim rather than duplicated) from the AUTHORITATIVE provider price
// identifier a real checkout call actually uses.
//
// NO GLOBAL/GENERIC PLAN EXISTS HERE, DELIBERATELY. landingPricing.ts's own
// header is explicit: "If no approved Global price exists, use neutral
// wording" — no PO-approved Global price point exists anywhere in this
// codebase or its docs (confirmed by this phase's own discovery). Inventing
// one (in any currency) would be exactly the kind of unsupported pricing
// claim this programme's own "explicitly out of scope" list forbids. A
// confirmed GENERIC billing country (GB/US/SG/AE) can therefore complete
// WP-02's billing-region gate (an honest "not yet available for your region"
// state), but cannot reach a real checkout this phase — see
// PaymentAvailability below.
import { LANDING_MARKETING_PRICES } from '@/lib/config/landingPricing';
import type { PriceCatalogueEntry } from '@/lib/services/billingAuthority';
import type { CountryCode } from '@/lib/services/jurisdiction';

export type PaymentProvider = 'stripe' | 'razorpay';
export type BillingInterval = 'monthly' | 'annual';

export interface PlanCatalogueEntry extends PriceCatalogueEntry {
  provider: PaymentProvider;
  interval: BillingInterval;
  currencyCode: 'AUD' | 'INR';
  /** Display-only, reused verbatim from landingPricing.ts — never sent to a provider API. */
  displayAmount: string;
  /**
   * The provider's own Price/Plan object id. Read from an env var, not
   * hard-coded — these objects must be created once in each provider's own
   * dashboard/API before a real checkout can succeed; this repository has no
   * mechanism to create them itself (would require live provider credentials
   * this phase does not have). `null` means "not yet configured" — every
   * caller must treat that as PROVIDER_NOT_CONFIGURED, never fall back to a
   * fabricated id.
   */
  providerPriceId: string | null;
}

// AU -> Stripe (also serves any future Global-approved plan, once a real
// price exists — see the header note above for why none does yet).
// IN -> Razorpay, per the Product Owner's explicit two-provider decision.
export const PLAN_CATALOGUE: Record<string, PlanCatalogueEntry> = {
  premium_monthly_au: {
    priceId: 'premium_monthly_au',
    region: 'AU',
    provider: 'stripe',
    interval: 'monthly',
    currencyCode: LANDING_MARKETING_PRICES.AU.currencyCode,
    displayAmount: LANDING_MARKETING_PRICES.AU.monthly,
    providerPriceId: process.env.STRIPE_PRICE_ID_PREMIUM_MONTHLY_AU ?? null,
  },
  premium_annual_au: {
    priceId: 'premium_annual_au',
    region: 'AU',
    provider: 'stripe',
    interval: 'annual',
    currencyCode: LANDING_MARKETING_PRICES.AU.currencyCode,
    displayAmount: LANDING_MARKETING_PRICES.AU.annual,
    providerPriceId: process.env.STRIPE_PRICE_ID_PREMIUM_ANNUAL_AU ?? null,
  },
  premium_monthly_in: {
    priceId: 'premium_monthly_in',
    region: 'IN',
    provider: 'razorpay',
    interval: 'monthly',
    currencyCode: LANDING_MARKETING_PRICES.IN.currencyCode,
    displayAmount: LANDING_MARKETING_PRICES.IN.monthly,
    providerPriceId: process.env.RAZORPAY_PLAN_ID_PREMIUM_MONTHLY_IN ?? null,
  },
  premium_annual_in: {
    priceId: 'premium_annual_in',
    region: 'IN',
    provider: 'razorpay',
    interval: 'annual',
    currencyCode: LANDING_MARKETING_PRICES.IN.currencyCode,
    displayAmount: LANDING_MARKETING_PRICES.IN.annual,
    providerPriceId: process.env.RAZORPAY_PLAN_ID_PREMIUM_ANNUAL_IN ?? null,
  },
};

export const PLAN_CATALOGUE_ENTRIES: readonly PriceCatalogueEntry[] = Object.values(PLAN_CATALOGUE).map((p) => ({
  priceId: p.priceId,
  region: p.region,
}));

export function getPlanCatalogueEntry(priceId: string): PlanCatalogueEntry | null {
  return PLAN_CATALOGUE[priceId] ?? null;
}

/** Reverse lookup for webhook handlers, which only know the PROVIDER's own price/plan id, never FHIP's internal one. */
export function findPlanByProviderPriceId(provider: PaymentProvider, providerPriceId: string): PlanCatalogueEntry | null {
  return Object.values(PLAN_CATALOGUE).find((p) => p.provider === provider && p.providerPriceId === providerPriceId) ?? null;
}

/** Every plan available for a given confirmed billing country — empty for a GENERIC country (no approved price exists). */
export function plansForBillingCountry(billingCountry: CountryCode): PlanCatalogueEntry[] {
  return Object.values(PLAN_CATALOGUE).filter((p) => p.region === billingCountry);
}
