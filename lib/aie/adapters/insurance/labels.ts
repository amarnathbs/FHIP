/**
 * AIE-1.4 — Insurance adapter label taxonomy.
 *
 * BOUNDED GENERIC STRUCTURE (AIE14-ELIG-05: "Require exact issuer/layout or
 * bounded generic structure definition"). No real insurer's exact PDF
 * layout was sourced for this pass — discovery found zero existing
 * insurance-document parser anywhere in this codebase to wrap (unlike
 * AIE-1.2's CAMS/KFintech or AIE-1.3's bank-PDF classifiers). Rather than
 * fabricate an "insurer X layout" claim this pass has no fixture evidence
 * for, this adapter defines and certifies exactly ONE bounded generic
 * layout: plain `Label: Value` lines (case-insensitive label matching, one
 * fact per line) — the same honest, disclosed choice FDH-9's payslip parser
 * makes in substance (normalised-substring label matching, most-specific-
 * first ordering, unrecognised lines never guessed at).
 *
 * Matching is by NORMALISED SUBSTRING containment against a colon-split
 * label, most specific first — mirrors
 * `lib/financial-data-hub/payslip/labels.ts`'s own documented design rule
 * verbatim (see that file's header for the original rationale this adapter
 * reuses in substance, not by import — payslip's rules are PayrollComponent-
 * specific and do not apply to insurance fields).
 */

export type InsuranceLabelField =
  | 'insurer'
  | 'policyType'
  | 'productName'
  | 'policyNumber'
  | 'policyOwnerName'
  | 'insuredPersonName'
  | 'beneficiaryName'
  | 'coverAmount'
  | 'currency'
  | 'renewalDate'
  | 'premium'
  | 'premiumFrequency'
  | 'excess'
  | 'waitingPeriodDays'
  | 'benefitPeriod'
  | 'exclusions'
  | 'annualPremiumTotal';

export interface InsuranceLabelRule {
  /** Normalised substrings; ANY match selects this rule. */
  terms: string[];
  /** Substrings that VETO this rule even if `terms` matched (keeps e.g.
   * "employer" out of a plain "premium" bucket, mirroring FDH-9's `unless`
   * mechanism). */
  unless?: string[];
  field: InsuranceLabelField;
}

/** ORDER MATTERS — first match wins. Most specific rules come first. */
export const INSURANCE_LABEL_RULES: InsuranceLabelRule[] = [
  // ---- Identity / evidence-only (never written to canonical) ------------
  { terms: ['policy owner'], field: 'policyOwnerName' },
  // `unless` must veto every OTHER label this bare 'insured' catch-all
  // could otherwise swallow — most importantly "Sum Insured"/"Sum Assured"
  // (a MONEY field, not a person). Found and fixed during this pass's own
  // fixture testing (tests/unit/aieInsuranceAdapterParser.test.ts): without
  // this veto, "Sum Insured: 500000" was misrouted to `insuredPersonName`
  // instead of `coverAmount`, silently dropping the cover amount entirely.
  { terms: ['insured person', 'insured name', 'life insured', 'insured'], unless: ['self-insured', 'uninsured', 'sum insured', 'sum assured', 'benefit amount'], field: 'insuredPersonName' },
  { terms: ['beneficiary'], field: 'beneficiaryName' },
  { terms: ['policy number', 'policy no', 'policy no.'], field: 'policyNumber' },
  { terms: ['insurer', 'underwriter'], field: 'insurer' },
  { terms: ['policy type', 'cover type', 'product type'], field: 'policyType' },
  { terms: ['product name'], field: 'productName' },

  // ---- Canonical money/date fields ---------------------------------------
  { terms: ['sum insured', 'cover amount', 'sum assured', 'benefit amount'], field: 'coverAmount' },
  { terms: ['currency'], field: 'currency' },
  { terms: ['renewal date', 'expiry date', 'cover end date'], field: 'renewalDate' },
  { terms: ['total annual premium', 'annual premium total', 'printed total premium'], field: 'annualPremiumTotal' },
  { terms: ['premium frequency', 'payment frequency'], field: 'premiumFrequency' },
  { terms: ['premium'], unless: ['total annual premium', 'annual premium total'], field: 'premium' },
  { terms: ['excess'], field: 'excess' },
  { terms: ['waiting period'], field: 'waitingPeriodDays' },
  { terms: ['benefit period'], field: 'benefitPeriod' },
  { terms: ['exclusions', 'endorsements', 'limitations'], field: 'exclusions' },
];

export function normaliseInsuranceLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** First-match-wins, `unless` veto respected. Returns null for a genuinely
 * unrecognised label — the caller must never guess a bucket for it. */
export function matchInsuranceLabel(rawLabel: string): InsuranceLabelField | null {
  const normalised = normaliseInsuranceLabel(rawLabel);
  for (const rule of INSURANCE_LABEL_RULES) {
    if (rule.unless?.some((u) => normalised.includes(u))) continue;
    if (rule.terms.some((t) => normalised.includes(t))) return rule.field;
  }
  return null;
}
