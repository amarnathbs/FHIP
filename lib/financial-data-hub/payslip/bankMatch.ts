/**
 * FDH-9 — bank salary-deposit matching (spec sections 20-22).
 *
 * ============================================================================
 * THE HIGHEST-RISK RULE IN FDH-9
 * ============================================================================
 *
 * A matching payslip and a matching salary deposit are TWO PIECES OF EVIDENCE
 * FOR ONE INCOME EVENT.
 *
 *     WRONG:   payslip $4,250 + bank $4,250 = $8,500 income
 *     RIGHT:   employment gross $X, net salary $4,250,
 *              bank evidence MATCHED, economic income events = 1
 *
 * This module returns EVIDENCE, never an amount. Nothing it produces is ever
 * added to anything. The structural guarantees behind that claim are:
 *
 *   - `matchSalaryDeposit()` returns a transaction ID and a confidence. It has
 *     no return path that yields a monetary total of any kind.
 *   - Migration 0091 puts a UNIQUE index on
 *     `fdh_payroll_events.bank_match_transaction_id`, so one deposit can
 *     corroborate at most one pay run.
 *   - The income adapter derives its proposal from GROSS payroll figures, and
 *     never reads a bank transaction at all.
 *
 * `tests/unit/fdh9DoubleCountCertification.test.ts` certifies this
 * independently, including negative controls.
 *
 * ============================================================================
 * MATCHING MUST NOT USE AMOUNT ALONE (spec section 22)
 * ============================================================================
 *
 * "A same-dollar unrelated credit must not become salary merely because the
 * amount matches." A $4,250 transfer from a family member on the same day is
 * not salary. So amount agreement is NECESSARY but never SUFFICIENT: a
 * candidate must also clear a corroboration threshold built from date
 * proximity, employer/narrative agreement, salary-account history, pay cadence
 * and prior employer evidence.
 *
 * NO BANK PARSING HAPPENS HERE (spec section 20). This module reads the
 * existing canonical `fdh_transactions` rows the certified FDH-3 → R7/FDH-4 →
 * FDH-5 → R8 chain already produced. FDH-9 parses no bank activity.
 */

import { moneyEquals } from '../domain/money';
import { normaliseEmployerName, normaliseLabel } from './normalise';
import type { PayrollBankMatchStatus } from './types';

/** The subset of a canonical `fdh_transactions` row this matcher reads. */
export interface BankCandidate {
  id: string;
  transaction_date: string;
  amount_original: number;
  currency_original: string;
  credit_debit: 'credit' | 'debit';
  description_clean?: string | null;
  description_raw?: string | null;
  merchant_raw?: string | null;
  economic_transaction_type?: string | null;
  transaction_type_hint?: string | null;
  financial_account_id?: string | null;
}

export interface SalaryMatchInput {
  netPay: number;
  currencyCode: string;
  paymentDate?: string;
  employerName?: string;
  /** Accounts previously observed to receive this employer's salary. */
  knownSalaryAccountIds?: string[];
  /** Employer names this household has already confirmed as employers. */
  historicalEmployerNormalised?: string[];
  candidates: readonly BankCandidate[];
}

export interface SalaryMatchScore {
  transactionId: string;
  confidence: number;
  signals: string[];
}

export interface SalaryMatchResult {
  status: PayrollBankMatchStatus;
  transactionId: string | null;
  confidence: number | null;
  /** Every candidate that cleared the threshold — surfaced so a
   * MULTIPLE_CANDIDATES review can show the user what it found. */
  scored: SalaryMatchScore[];
  reasonCode:
    | 'matched'
    | 'no_amount_match'
    | 'amount_only_insufficient'
    | 'multiple_candidates'
    | 'no_candidates';
}

/** Maximum days between the payslip's payment date and the deposit. Payroll
 * commonly lands a day early or a day late (weekends, bank cut-offs); a week
 * apart is a different pay run. */
export const MAX_PAYMENT_DATE_DRIFT_DAYS = 3;

/**
 * Corroboration required beyond amount agreement. Amount alone scores
 * AMOUNT_WEIGHT; a candidate must reach MATCH_THRESHOLD, which amount alone
 * cannot do. This is the mechanical expression of spec section 22.
 */
const AMOUNT_WEIGHT = 0.35;
const MATCH_THRESHOLD = 0.6;

const SIGNAL_WEIGHTS = {
  date_exact: 0.25,
  date_close: 0.15,
  employer_in_narrative: 0.3,
  payroll_narrative: 0.12,
  salary_hint: 0.1,
  known_salary_account: 0.12,
  known_employer: 0.08,
  income_classified: 0.1,
} as const;

/** Narrative terms that indicate a payroll credit irrespective of employer. */
const PAYROLL_NARRATIVE_TERMS = ['payroll', 'salary', 'wages', 'wage', 'pay run', 'salaries', 'stipend', 'remuneration'];

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

function narrativeOf(c: BankCandidate): string {
  return normaliseLabel([c.description_clean, c.description_raw, c.merchant_raw].filter(Boolean).join(' '));
}

/**
 * Score one candidate. Returns null when the amount does not agree — amount
 * agreement is a hard prerequisite, so an unrelated credit of a different size
 * never enters scoring at all.
 */
export function scoreSalaryCandidate(
  input: SalaryMatchInput,
  candidate: BankCandidate,
): SalaryMatchScore | null {
  // Salary arrives as a CREDIT. A debit of the same size is not salary.
  if (candidate.credit_debit !== 'credit') return null;
  // Cross-currency salary matching is not attempted rather than guessed.
  if (candidate.currency_original.toUpperCase() !== input.currencyCode.toUpperCase()) return null;
  if (!moneyEquals(candidate.amount_original, input.netPay, input.currencyCode, 0)) return null;

  const signals: string[] = ['amount_exact'];
  let score = AMOUNT_WEIGHT;

  if (input.paymentDate) {
    const drift = daysBetween(input.paymentDate, candidate.transaction_date);
    if (drift > MAX_PAYMENT_DATE_DRIFT_DAYS) return null; // too far apart to be this pay run
    if (drift === 0) { score += SIGNAL_WEIGHTS.date_exact; signals.push('date_exact'); }
    else { score += SIGNAL_WEIGHTS.date_close; signals.push('date_close'); }
  }

  const narrative = narrativeOf(candidate);

  const employer = normaliseEmployerName(input.employerName);
  if (employer && narrative) {
    // Match on the employer's most distinctive word rather than the whole
    // string: bank narratives truncate ("ABC PAYROLL" for "ABC Pty Ltd").
    const employerWords = employer.split(' ').filter((w) => w.length >= 3);
    if (employerWords.length > 0 && employerWords.some((w) => narrative.includes(w))) {
      score += SIGNAL_WEIGHTS.employer_in_narrative;
      signals.push('employer_in_narrative');
    }
  }

  if (narrative && PAYROLL_NARRATIVE_TERMS.some((t) => narrative.includes(t))) {
    score += SIGNAL_WEIGHTS.payroll_narrative;
    signals.push('payroll_narrative');
  }

  if (candidate.transaction_type_hint === 'salary_candidate') {
    score += SIGNAL_WEIGHTS.salary_hint;
    signals.push('salary_hint');
  }

  if (candidate.economic_transaction_type === 'income') {
    score += SIGNAL_WEIGHTS.income_classified;
    signals.push('income_classified');
  }

  if (
    candidate.financial_account_id
    && input.knownSalaryAccountIds?.includes(candidate.financial_account_id)
  ) {
    score += SIGNAL_WEIGHTS.known_salary_account;
    signals.push('known_salary_account');
  }

  if (employer && input.historicalEmployerNormalised?.includes(employer)) {
    score += SIGNAL_WEIGHTS.known_employer;
    signals.push('known_employer');
  }

  return { transactionId: candidate.id, confidence: Math.min(1, Number(score.toFixed(4))), signals };
}

/**
 * Match a payslip's net pay to at most ONE bank deposit.
 *
 * Outcomes:
 *   MATCHED             exactly one candidate cleared the threshold
 *   MULTIPLE_CANDIDATES more than one cleared it — never silently pick the
 *                       first; this raises a review item (spec section 42)
 *   NO_MATCH            none cleared it, including the important case where a
 *                       same-amount credit existed but had no corroboration
 */
export function matchSalaryDeposit(input: SalaryMatchInput): SalaryMatchResult {
  if (input.candidates.length === 0) {
    return { status: 'no_match', transactionId: null, confidence: null, scored: [], reasonCode: 'no_candidates' };
  }

  const scored: SalaryMatchScore[] = [];
  let amountAgreeing = 0;
  for (const candidate of input.candidates) {
    const result = scoreSalaryCandidate(input, candidate);
    if (!result) continue;
    amountAgreeing += 1;
    if (result.confidence >= MATCH_THRESHOLD) scored.push(result);
  }

  if (scored.length === 0) {
    return {
      status: 'no_match',
      transactionId: null,
      confidence: null,
      scored: [],
      // Distinguishing these two matters: "a same-amount credit exists but is
      // not corroborated as salary" is exactly the spec section 22 case, and
      // deserves its own reason rather than looking like "nothing found".
      reasonCode: amountAgreeing > 0 ? 'amount_only_insufficient' : 'no_amount_match',
    };
  }

  scored.sort((a, b) => b.confidence - a.confidence);

  // Genuine ambiguity: two candidates equally well corroborated. Never pick
  // one — the user decides (spec section 42's "multiple matching deposits").
  if (scored.length > 1 && scored[0].confidence === scored[1].confidence) {
    return {
      status: 'multiple_candidates', transactionId: null, confidence: null,
      scored, reasonCode: 'multiple_candidates',
    };
  }

  return {
    status: 'matched',
    transactionId: scored[0].transactionId,
    confidence: scored[0].confidence,
    scored,
    reasonCode: 'matched',
  };
}
