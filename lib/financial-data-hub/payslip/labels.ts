/**
 * FDH-9 — payslip label taxonomy.
 *
 * Maps the free-text labels real employers print onto the closed
 * `PayrollComponentType` vocabulary.
 *
 * DESIGN RULE (spec section 18): "Do not assume every Indian employer uses the
 * same layout." The same applies to AU. So:
 *
 *   - Matching is by NORMALISED SUBSTRING, not exact equality, and the table is
 *     ordered MOST SPECIFIC FIRST. "employer superannuation" must beat
 *     "superannuation"; "employee provident fund" must beat "provident fund".
 *   - An unrecognised line is NOT dropped and NOT guessed at. It becomes
 *     `component_type = 'unknown'` with its raw label preserved, and it raises
 *     a review reason. A silently mis-bucketed allowance is far worse than an
 *     honest "we did not recognise this line".
 *   - NO STATUTORY RATE APPEARS ANYWHERE (spec section 17). There is no
 *     "super is 11.5%" or "EPF is 12%" logic in FDH-9. Every figure is read
 *     from the document.
 */

import type { PayrollComponentSide, PayrollComponentType, PayrollCountry } from './types';
import { normaliseLabel } from './normalise';

export interface LabelRule {
  /** Normalised substrings; ANY match selects this rule. */
  terms: string[];
  /** Substrings that VETO this rule even if `terms` matched. This is how
   * "employer super" is kept out of the employee-super rule. */
  unless?: string[];
  side: PayrollComponentSide;
  type: PayrollComponentType;
  /** Countries this rule applies to; omitted = both. */
  countries?: PayrollCountry[];
}

/**
 * ORDER MATTERS — first match wins. Most specific rules come first.
 */
export const PAYSLIP_LABEL_RULES: LabelRule[] = [
  // ---- Employer-side retirement (must precede employee-side) --------------
  {
    terms: ['employer superannuation', 'employer super', 'superannuation guarantee', 'super guarantee', 'sg contribution', 'employer contribution super'],
    side: 'employer_contribution', type: 'employer_retirement', countries: ['AU'],
  },
  {
    terms: ['employer pf', 'employer provident fund', 'employers pf', 'employer epf', 'company pf', 'employer contribution pf'],
    side: 'employer_contribution', type: 'employer_retirement', countries: ['IN'],
  },
  {
    terms: ['employer nps', 'employer contribution nps'],
    side: 'employer_contribution', type: 'employer_nps', countries: ['IN'],
  },

  // ---- Employee-side retirement -------------------------------------------
  {
    terms: ['employee superannuation', 'member voluntary super', 'voluntary super', 'personal super contribution', 'employee super'],
    unless: ['employer'],
    side: 'deduction', type: 'employee_retirement', countries: ['AU'],
  },
  {
    terms: ['salary sacrifice', 'salary sacrificed', 'sacrifice super'],
    side: 'deduction', type: 'salary_sacrifice', countries: ['AU'],
  },
  {
    terms: ['employee pf', 'employee provident fund', 'pf contribution', 'epf contribution', 'provident fund', 'epf'],
    unless: ['employer', 'company'],
    side: 'deduction', type: 'employee_retirement', countries: ['IN'],
  },
  {
    terms: ['employee nps', 'nps contribution', 'nps'],
    unless: ['employer'],
    side: 'deduction', type: 'employee_nps', countries: ['IN'],
  },

  // ---- Tax -----------------------------------------------------------------
  {
    terms: ['payg withholding', 'payg withheld', 'payg tax', 'payg', 'paye', 'tax withheld', 'income tax', 'withholding tax'],
    side: 'deduction', type: 'income_tax_withheld',
  },
  {
    terms: ['tds', 'tax deducted at source'],
    side: 'deduction', type: 'income_tax_withheld', countries: ['IN'],
  },
  {
    terms: ['professional tax', 'prof tax', 'p tax', 'ptax'],
    side: 'deduction', type: 'professional_tax', countries: ['IN'],
  },

  // ---- India-specific earnings (before generic 'allowance') ---------------
  {
    terms: ['house rent allowance', 'hra'],
    side: 'earning', type: 'hra', countries: ['IN'],
  },
  {
    terms: ['dearness allowance', 'da'],
    side: 'earning', type: 'dearness_allowance', countries: ['IN'],
  },
  {
    terms: ['special allowance'],
    side: 'earning', type: 'special_allowance', countries: ['IN'],
  },
  {
    terms: ['conveyance allowance', 'conveyance', 'transport allowance'],
    side: 'earning', type: 'conveyance', countries: ['IN'],
  },
  {
    terms: ['leave travel allowance', 'leave travel concession', 'lta'],
    side: 'earning', type: 'lta', countries: ['IN'],
  },
  {
    terms: ['basic salary', 'basic pay', 'basic'],
    side: 'earning', type: 'basic', countries: ['IN'],
  },

  // ---- Variable pay --------------------------------------------------------
  {
    terms: ['overtime', 'ot hours', 'ot pay', 'penalty rate', 'shift loading'],
    side: 'earning', type: 'overtime',
  },
  {
    terms: ['bonus', 'incentive', 'performance pay', 'ex gratia', 'exgratia'],
    side: 'earning', type: 'bonus',
  },
  {
    terms: ['commission'],
    side: 'earning', type: 'commission',
  },
  {
    terms: ['arrears', 'arrear'],
    side: 'earning', type: 'arrears',
  },

  // ---- Reimbursements (NEVER income — spec section 38) ---------------------
  {
    terms: ['reimbursement', 'reimburse', 'expense claim', 'expense reimb', 'out of pocket'],
    side: 'earning', type: 'reimbursement',
  },

  // ---- Base pay (AU) -------------------------------------------------------
  {
    terms: ['ordinary hours', 'ordinary time earnings', 'ordinary earnings', 'ordinary pay', 'base salary', 'base pay', 'salary', 'normal hours', 'regular pay'],
    unless: ['sacrifice', 'packaging'],
    side: 'earning', type: 'base', countries: ['AU'],
  },

  // ---- Generic allowance (after all specific allowances) -------------------
  {
    terms: ['allowance', 'allow'],
    side: 'earning', type: 'allowance',
  },

  // ---- Other deductions ----------------------------------------------------
  {
    terms: ['union fee', 'union dues', 'social club', 'novated lease', 'child support', 'garnishee', 'loan repayment', 'advance recovery', 'insurance premium', 'health insurance', 'mediclaim', 'canteen', 'deduction'],
    side: 'deduction', type: 'other_deduction',
  },
];

/**
 * Resolve a raw payslip label to a component side + type.
 *
 * Returns `undefined` when nothing matched — the caller preserves the line as
 * `unknown` rather than forcing it into a bucket.
 */
export function classifyPayslipLabel(
  rawLabel: string,
  country: PayrollCountry,
): { side: PayrollComponentSide; type: PayrollComponentType } | undefined {
  const label = normaliseLabel(rawLabel);
  if (!label) return undefined;

  for (const rule of PAYSLIP_LABEL_RULES) {
    if (rule.countries && !rule.countries.includes(country)) continue;
    if (rule.unless?.some((veto) => label.includes(veto))) continue;
    if (rule.terms.some((term) => matchesTerm(label, term))) {
      return { side: rule.side, type: rule.type };
    }
  }
  return undefined;
}

/**
 * Short acronyms (`da`, `hra`, `pf`, `ot`, `lta`, `tds`) must match as WHOLE
 * WORDS, or "da" would match "dearness", "standard" and "update". Longer terms
 * match as substrings, which is what makes the table tolerant of the endless
 * employer-specific phrasings.
 */
function matchesTerm(label: string, term: string): boolean {
  if (term.length <= 4) {
    return new RegExp(`(?:^|\\s)${term}(?:\\s|$)`).test(label);
  }
  return label.includes(term);
}

/**
 * Labels that identify a TOTAL line rather than a component line. These are
 * read into the header totals, never added to the component sum (adding a
 * "Total Earnings" line to the individual earnings would double the gross).
 */
export const TOTAL_LABELS = {
  gross: ['total earnings', 'gross earnings', 'gross pay', 'total gross', 'gross salary', 'total income', 'gross'],
  totalDeductions: ['total deductions', 'total deduction', 'less deductions'],
  net: ['net pay', 'net salary', 'net amount', 'take home', 'amount payable', 'net payable', 'net'],
} as const;

/** True when a normalised label is a total line of the given kind. */
export function isTotalLabel(rawLabel: string, kind: keyof typeof TOTAL_LABELS): boolean {
  const label = normaliseLabel(rawLabel);
  if (!label) return false;
  return TOTAL_LABELS[kind].some((t) => label === t || label.startsWith(`${t} `) || label.endsWith(` ${t}`) || label.includes(` ${t} `));
}

/** Year-to-date column markers. */
export const YTD_MARKERS = ['ytd', 'year to date', 'yr to date', 'cumulative', 'ficial year to date'];

export function looksYearToDate(rawLabel: string): boolean {
  const label = normaliseLabel(rawLabel);
  return YTD_MARKERS.some((m) => label.includes(m));
}
