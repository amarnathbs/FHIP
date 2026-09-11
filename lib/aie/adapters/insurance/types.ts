/**
 * AIE-1.4 — Insurance adapter field vocabulary.
 *
 * `CanonicalInsuranceFieldName` lists exactly the fields this pass writes to
 * the real `insurance_policies` table (matches `lib/validation/insurance.ts`'s
 * `insuranceSchema` one-for-one, minus `owner`/`master_item_key`/`notes`,
 * which are always user-/caller-supplied, never document-derived — see
 * `write.ts`'s header for why `owner` in particular must never be guessed
 * from document text).
 *
 * `EvidenceOnlyInsuranceFieldName` lists fields the parser extracts and
 * reports as AIE field candidates for user-facing evidence/audit ONLY —
 * none of them have a column in `insurance_policies` to write to (see
 * documentCatalogue.ts's header for the full schema-gap disclosure).
 */
export const CANONICAL_INSURANCE_FIELD_NAMES = [
  'policyName',
  'coverType',
  'coverAmount',
  'premium',
  'premiumFrequency',
  'currencyCode',
  'renewalDate',
  'waitingPeriodDays',
  'benefitPeriod',
  'provider',
] as const;
export type CanonicalInsuranceFieldName = (typeof CANONICAL_INSURANCE_FIELD_NAMES)[number];

export const EVIDENCE_ONLY_INSURANCE_FIELD_NAMES = [
  'documentSubClass',
  'policyNumberMasked',
  'policyOwnerName',
  'insuredPersonName',
  'beneficiaryName',
  'exclusionsText',
  'excessAmount',
  'printedAnnualPremiumTotal',
  'multiComponentPolicyDetected',
] as const;
export type EvidenceOnlyInsuranceFieldName = (typeof EVIDENCE_ONLY_INSURANCE_FIELD_NAMES)[number];

export const INSURANCE_COVER_TYPES = ['life', 'income_protection', 'health', 'home', 'vehicle', 'other'] as const;
export type InsuranceCoverType = (typeof INSURANCE_COVER_TYPES)[number];

export const INSURANCE_PREMIUM_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'] as const;
export type InsurancePremiumFrequency = (typeof INSURANCE_PREMIUM_FREQUENCIES)[number];

/** Currencies `insuranceSchema.currency_code` accepts today — see
 * lib/validation/insurance.ts. Anything else is a supported-currency
 * reconciliation failure, not a silent pass-through. */
export const INSURANCE_SUPPORTED_CURRENCIES = ['AUD', 'INR'] as const;

/** Periods per year for each frequency — used ONLY to cross-check a printed
 * annual-premium total against the per-period premium the document itself
 * states (AIE14-INS-09). No statutory/insurance-industry rate is invented
 * anywhere in this file, matching FDH-9's own "no statutory rate" rule. */
export const PERIODS_PER_YEAR: Record<InsurancePremiumFrequency, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  quarterly: 4,
  annually: 1,
  one_off: 1,
};
