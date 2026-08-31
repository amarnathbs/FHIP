/**
 * FDH-12 — classifying a retirement statement line into an activity type
 * (spec section 21).
 *
 * First-match-wins over an ORDERED rule list, most specific first. This is the
 * same shape as FDH-9's `payslip/labels.ts` `PAYSLIP_LABEL_RULES`, and for the
 * same reason: retirement statement wording is idiosyncratic, and an ordered
 * list of explicit phrases is auditable in a way that a scoring heuristic is
 * not.
 *
 * ============================================================================
 * FAILING SAFE (spec sections 85, 143)
 * ============================================================================
 *
 * A line that matches no rule becomes `UNKNOWN`, not a guess. `UNKNOWN` has a
 * `null` balance direction (see `RETIREMENT_ACTIVITY_DIRECTION`), so it takes
 * no part in the reconciliation identity — which means an unclassified line
 * makes the statement report VARIANCE or INSUFFICIENT_DATA rather than a
 * confidently wrong RECONCILED. That is the intended outcome: a silent
 * mis-classification is worse than a visible failure to classify.
 *
 * ============================================================================
 * THE `unless` VETO
 * ============================================================================
 *
 * Rules carry an `unless` list of disqualifying terms, copied from FDH-9's
 * certified design. It is what stops "employer contribution" from also
 * matching the broader "contribution" rule, and — more importantly — what
 * stops "rollover to another fund" from matching ROLLOVER_IN merely because it
 * contains the word "rollover".
 */

import type { RetirementActivityType } from './types';

export interface RetirementLabelRule {
  terms: readonly string[];
  unless?: readonly string[];
  type: RetirementActivityType;
  /** Restrict the rule to one jurisdiction where the wording is
   * jurisdiction-specific (India EPF/NPS terminology). */
  jurisdictions?: readonly ('AU' | 'IN')[];
}

/** ORDER MATTERS. Most specific first. */
export const RETIREMENT_LABEL_RULES: readonly RetirementLabelRule[] = [
  // --- Contributions: employer ------------------------------------------
  {
    terms: [
      'employer superannuation guarantee', 'superannuation guarantee', 'super guarantee',
      'sg contribution', 'employer contribution', 'employer super', 'employer contributions',
      'sg employer', 'compulsory employer',
    ],
    unless: ['personal', 'member', 'spouse', 'government', 'co-contribution'],
    type: 'EMPLOYER_CONTRIBUTION',
  },
  {
    terms: ['employer share', 'employer pf', 'employer provident fund', 'employer epf', 'employer nps'],
    type: 'EMPLOYER_CONTRIBUTION',
    jurisdictions: ['IN'],
  },

  // --- Contributions: salary sacrifice ----------------------------------
  // BEFORE the personal-contribution rule: salary sacrifice is a concessional
  // employer-routed contribution, not a personal after-tax one, and treating
  // it as personal would mis-state which side of the payroll boundary the
  // money crossed (spec section 31).
  {
    terms: ['salary sacrifice', 'salary sacrificed', 'sacrifice contribution', 'voluntary pre-tax', 'pre-tax contribution'],
    type: 'SALARY_SACRIFICE',
  },

  // --- Contributions: government ----------------------------------------
  // BEFORE personal: "government co-contribution" contains "contribution".
  // Spec section 32 — never classified as ordinary salary.
  {
    terms: [
      'government co-contribution', 'co-contribution', 'government contribution',
      'low income super tax offset', 'listo', 'low income superannuation',
    ],
    type: 'GOVERNMENT_CONTRIBUTION',
  },

  // --- Contributions: personal ------------------------------------------
  {
    terms: [
      'personal contribution', 'member contribution', 'voluntary contribution',
      'after-tax contribution', 'after tax contribution', 'non-concessional contribution',
      'personal concessional', 'spouse contribution', 'employee share', 'employee pf', 'employee contribution',
    ],
    unless: ['employer'],
    type: 'PERSONAL_CONTRIBUTION',
  },

  // --- Rollovers ---------------------------------------------------------
  // Directionality is read explicitly. A line saying only "rollover" with no
  // direction word matches NEITHER rule and falls through to UNKNOWN, which is
  // correct: guessing the direction of a $100,000 movement is exactly the
  // failure spec sections 33-35 are about.
  {
    terms: [
      'rollover in', 'rollover received', 'transfer in', 'transfer received',
      'rollin', 'roll-in', 'inward rollover', 'rollover from',
    ],
    unless: ['out', 'to another', 'paid to'],
    type: 'ROLLOVER_IN',
  },
  {
    terms: [
      'rollover out', 'rollover paid', 'transfer out', 'transfer to another fund',
      'rollout', 'roll-out', 'outward rollover', 'rollover to',
    ],
    type: 'ROLLOVER_OUT',
  },

  // --- Insurance (BEFORE fees: an insurance premium is not an admin fee) --
  {
    terms: [
      'insurance premium', 'death cover', 'tpd premium', 'total and permanent disability',
      'income protection premium', 'life insurance', 'death and tpd', 'insurance fee', 'insurance cost',
    ],
    type: 'INSURANCE_PREMIUM',
  },

  // --- Tax (BEFORE fees: "contributions tax" is not a fee) ---------------
  // Spec sections 44-45: preserved as evidence exactly as printed. Nothing
  // downstream infers a tax RATE from these amounts.
  {
    terms: [
      'contributions tax', 'contribution tax', 'no-tfn tax', 'no tfn tax',
      'earnings tax', 'tax on earnings', 'withholding tax', 'pay as you go', 'payg',
      'superannuation tax', 'tax deducted', 'excess contributions tax', 'tds',
    ],
    type: 'TAX',
  },

  // --- Fees --------------------------------------------------------------
  {
    terms: [
      'administration fee', 'admin fee', 'management fee', 'investment fee',
      'member fee', 'account fee', 'indirect cost', 'adviser fee', 'advice fee',
      'exit fee', 'switching fee', 'activity fee', 'expense recovery', 'trustee fee', 'fee',
    ],
    unless: ['insurance'],
    type: 'FEE',
  },

  // --- Earnings ----------------------------------------------------------
  {
    terms: [
      'investment earnings', 'investment return', 'net earnings', 'earnings',
      'crediting rate', 'unit price movement', 'investment income', 'market movement',
    ],
    type: 'INVESTMENT_EARNINGS',
  },
  { terms: ['interest credited', 'interest earned', 'interest'], type: 'INTEREST' },
  { terms: ['distribution', 'dividend'], type: 'DISTRIBUTION' },

  // --- Payments out ------------------------------------------------------
  // BEFORE withdrawal: a pension payment is a specific kind of drawing, and
  // spec section 37 requires it be mapped distinctly where the statement says
  // so rather than flattened into a generic withdrawal.
  {
    terms: [
      'pension payment', 'pension paid', 'income stream payment',
      'account based pension payment', 'annuity payment', 'regular pension',
    ],
    type: 'PENSION_PAYMENT',
  },
  {
    terms: [
      'withdrawal', 'lump sum payment', 'benefit payment', 'lump sum withdrawal',
      'partial withdrawal', 'cash out', 'benefit paid', 'final payment',
    ],
    type: 'WITHDRAWAL',
  },

  // --- Adjustments -------------------------------------------------------
  { terms: ['adjustment', 'correction', 'reversal', 'rebate', 'refund'], type: 'ADJUSTMENT' },
];

/** Phrases that mark a line as a printed SUBTOTAL rather than an individual
 * economic event (spec sections 116-118). */
const SUMMARY_TOTAL_MARKERS = [
  'total', 'subtotal', 'sub-total', 'sum of', 'aggregate', 'summary',
] as const;

/** Phrases that mark a line as a YEAR-TO-DATE figure (spec sections 114-115).
 * Same vocabulary FDH-9 certified in `payslip/labels.ts`. */
const YEAR_TO_DATE_MARKERS = [
  'ytd', 'year to date', 'yr to date', 'year-to-date', 'cumulative',
  'financial year to date', 'fytd', 'this financial year', 'since 1 july',
] as const;

function fold(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Classify one statement line.
 *
 * Returns `UNKNOWN` when nothing matches. It never returns a "closest guess",
 * and it never returns a type on the strength of the amount alone.
 */
export function classifyRetirementActivity(
  label: string,
  jurisdiction: 'AU' | 'IN' = 'AU',
): RetirementActivityType {
  const folded = fold(label);
  if (!folded) return 'UNKNOWN';

  for (const rule of RETIREMENT_LABEL_RULES) {
    if (rule.jurisdictions && !rule.jurisdictions.includes(jurisdiction)) continue;
    if (rule.unless?.some((veto) => folded.includes(veto))) continue;
    if (rule.terms.some((term) => folded.includes(term))) return rule.type;
  }
  return 'UNKNOWN';
}

/** True when this line is a printed subtotal (spec sections 116-118). */
export function looksSummaryTotal(label: string): boolean {
  const folded = fold(label);
  return SUMMARY_TOTAL_MARKERS.some((m) => folded.includes(m));
}

/** True when this line is a year-to-date figure (spec sections 114-115). */
export function looksYearToDate(label: string): boolean {
  const folded = fold(label);
  return YEAR_TO_DATE_MARKERS.some((m) => folded.includes(m));
}
