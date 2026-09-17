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

/**
 * M12B (M12B-F4 / M12B-F5) — the two candidates below exist so that a fact the
 * document PRINTED but this adapter could not read is reported rather than
 * silently dropped.
 *
 * WHY THEY WERE NEEDED, from two cases that both wrote an incomplete policy to
 * the canonical table after an explicit accept:
 *
 *   INS-B12 printed `Trauma Cover: 150,000.00`. `Trauma Cover` matches no rule
 *   in `labels.ts`, so the line was ignored — correctly, because AIE14-INS-10
 *   forbids guessing a bucket for an unrecognised label. But
 *   `multiComponentPolicyDetected` counts occurrences of RECOGNISED coverAmount
 *   and premium labels, so it had nothing to count, every required field was
 *   present, every rule passed, and 150,000.00 of printed cover disappeared
 *   without a word.
 *
 *   INS-B14 printed `Renewal Date: 31/08/2027`. The parser admits a renewal
 *   date only when it already matches `^\d{4}-\d{2}-\d{2}$`, and `renewalDate`
 *   is not a required field, so the date was dropped, nothing noticed, and the
 *   canonical row was written with `renewal_date: null`.
 *
 * THIS IS THE SAME DEFECT SHAPE AS M12A-F1 ON FDH-BANK, and it is fixed the
 * same way, deliberately: the parser already KNEW in both cases, and the
 * knowledge never reached the one place that decides whether a run may be
 * accepted, because `ReconciliationRule` receives candidates only.
 *
 * NEITHER CANDIDATE EVER GUESSES A VALUE. The evidence records WHICH label and
 * WHY it could not be read — never what it might have meant. Inventing a
 * bucket, a date or an amount is exactly what AIE14-INS-10 forbids, and
 * reporting the gap is not the same act as filling it.
 */
export const INSURANCE_UNREADABLE_PRINTED_FACT_COUNT_FIELD = 'unreadablePrintedFactCount';
export const INSURANCE_UNREADABLE_PRINTED_FACT_EVIDENCE_FIELD = 'unreadablePrintedFactEvidence';

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
  INSURANCE_UNREADABLE_PRINTED_FACT_COUNT_FIELD,
  INSURANCE_UNREADABLE_PRINTED_FACT_EVIDENCE_FIELD,
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
