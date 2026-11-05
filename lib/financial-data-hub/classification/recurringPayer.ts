/**
 * Repeating payer -> salary or loan repayment (PO 05-11-2026).
 *
 * WHY. In the PO's two real NAB statements the employer's pay ("Australian Unity", 26 credits) and a solar loan ("Solvic", 11 debits) carry no word that
 * says "salary" or "loan". What gives them away is that they arrive or leave on a regular schedule, for a near-constant amount. The PO asked for exactly
 * that rule and accepted that a wrong guess is simply edited ("if this is not correct the user will edit").
 *
 * PURE. No database, no network. The caller (transactionClassificationService) hands in the lines the rules could NOT classify and writes the
 * returned proposals as MEDIUM-confidence PROPOSALS (never HIGH, never approved, never counted until the person approves the total).
 *
 * HOW IT DECIDES (all conditions must hold for a payer):
 *  - the lines are grouped by currency + direction + payee text (digit-bearing tokens such as reference numbers ignored, so "00112932 Australian
 *    Unity 124094" and "00118841 Australian Unity 125010" are one payer);
 *  - at least 4 lines;
 *  - the gaps between consecutive dates match ONE cadence (weekly, fortnightly or monthly, the shared RECURRING_FREQUENCY_BUCKETS). A missed period
 *    (a gap of 2 or 3 cadences, e.g. between two statements) is allowed, but at least 3 gaps must match the cadence exactly and at least 75 percent of
 *    all gaps must be the cadence or a whole multiple of it;
 *  - the amounts are near-constant: CREDITS within 25 percent of the median for at least 70 percent of lines (pay varies with overtime and tax);
 *    DEBITS within 2 percent of the median for at least 80 percent of lines (a repayment is a fixed instalment).
 *
 * WHAT IT PROPOSES.
 *  - CREDIT -> Income, type Salary & Wages (Rental Income / Pension Income / Government Benefit when the payer text says so).
 *  - DEBIT  -> Loan Principal Repayment, ONLY when the payer text carries loan wording (LOAN, FINANCE, LEASE, INSTALMENT, HIRE PURCHASE, SOLAR VICTORIA,
 *    SOLVIC). A fixed repeating debit with NO such wording is NOT guessed: rent, a gym, insurance and a subscription are all fixed and regular, and
 *    filing rent as a loan repayment would take the biggest spending line out of the spending total.
 *
 * WHAT IT NEVER TOUCHES. Card and EFTPOS purchases (a shop is not a lender or an employer), person-to-person rails (Osko / PayID: a tenant paying rent
 * is not salary), narratives that name a refund, interest, a dividend, a tax payment or the tax office, and any payer that fails a condition above.
 */

import { RECURRING_FREQUENCY_BUCKETS } from './thresholds';
import { isCardPurchaseShape, isPersonToPersonRail } from './paymentShape';
import { containsPhrase, toMatchText } from './textMatch';
import { derivePayeeKey } from '../domain/categoryReview';

export interface RecurringPayerLine {
  id: string;
  description: string | null;
  creditDebit: 'credit' | 'debit';
  /** Unsigned, as stored. */
  amount: number;
  currency: string;
  /** ISO date, yyyy-mm-dd. */
  date: string;
}

export type RecurringPayerCadence = 'weekly' | 'fortnightly' | 'monthly';

export interface RecurringPayerProposal {
  id: string;
  /** The category key to file the line under, and the optional type under it. */
  categoryKey: 'income' | 'loan_principal';
  subcategoryKey: string | null;
  cadence: RecurringPayerCadence;
  occurrences: number;
  payeeKey: string;
  /** Plain-words reason shown to the person. */
  why: string;
}

export const RECURRING_PAYER_MIN_LINES = 4;
const CADENCES = RECURRING_FREQUENCY_BUCKETS.filter((b) => b.frequency === 'weekly' || b.frequency === 'fortnightly' || b.frequency === 'monthly');

/** Never proposed as salary or a loan, whatever the schedule. */
const SKIP_WORDS = ['REFUND', 'REVERSAL', 'REVERSED', 'CHARGEBACK', 'INTEREST', 'DIVIDEND', 'DISTRIBUTION', 'TAX', 'ATO', 'TRANSFER', 'FEE', 'CASHBACK'] as const;
const LOAN_WORDS = ['LOAN', 'LOANS', 'FINANCE', 'FINANCING', 'LEASE', 'INSTALMENT', 'INSTALMENTS', 'INSTALLMENT', 'INSTALLMENTS', 'HIRE PURCHASE', 'SOLAR VICTORIA', 'SOLVIC'] as const;
const INCOME_TYPE_WORDS: ReadonlyArray<{ words: readonly string[]; subcategory: string }> = [
  { words: ['RENT', 'RENTAL', 'REAL ESTATE', 'PROPERTY MANAGEMENT'], subcategory: 'rental_income' },
  { words: ['PENSION', 'ANNUITY'], subcategory: 'pension_income' },
  { words: ['CENTRELINK', 'SERVICES AUSTRALIA', 'SERVICES AUS', 'FAMILY TAX'], subcategory: 'government_benefit' },
];

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const has = (hay: string, words: readonly string[]): boolean => words.some((w) => containsPhrase(hay, w));

/** The cadence the gaps follow, or null. See the header for the exact conditions. */
export function detectCadence(sortedDates: readonly string[]): RecurringPayerCadence | null {
  if (sortedDates.length < RECURRING_PAYER_MIN_LINES) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i += 1) gaps.push(daysBetween(sortedDates[i - 1], sortedDates[i]));
  for (const c of CADENCES) {
    let exact = 0;
    let regular = 0;
    for (const g of gaps) {
      if (Math.abs(g - c.nominalDays) <= c.toleranceDays) {
        exact += 1;
        regular += 1;
        continue;
      }
      // A missed period (two statements with a gap between them, a skipped pay) is a whole multiple of the cadence.
      for (const k of [2, 3]) {
        if (Math.abs(g - c.nominalDays * k) <= c.toleranceDays * k) {
          regular += 1;
          break;
        }
      }
    }
    if (exact >= 3 && regular / gaps.length >= 0.75) return c.frequency as RecurringPayerCadence;
  }
  return null;
}

const shareWithin = (amounts: readonly number[], centre: number, fraction: number): number =>
  centre <= 0 ? 0 : amounts.filter((a) => Math.abs(a - centre) <= centre * fraction).length / amounts.length;

export function proposeRecurringPayers(lines: readonly RecurringPayerLine[]): RecurringPayerProposal[] {
  const groups = new Map<string, Array<RecurringPayerLine & { hay: string; payee: string }>>();
  for (const l of lines) {
    const hay = toMatchText(l.description);
    if (hay.length === 0 || isCardPurchaseShape(hay) || isPersonToPersonRail(hay) || has(hay, SKIP_WORDS)) continue;
    const payee = derivePayeeKey(hay);
    if (!payee) continue;
    const key = `${l.currency}|${l.creditDebit}|${payee}`;
    const list = groups.get(key) ?? groups.set(key, []).get(key)!;
    list.push({ ...l, hay, payee });
  }

  const out: RecurringPayerProposal[] = [];
  for (const group of groups.values()) {
    if (group.length < RECURRING_PAYER_MIN_LINES) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
    const cadence = detectCadence(sorted.map((l) => l.date));
    if (!cadence) continue;
    const amounts = sorted.map((l) => l.amount);
    const mid = median(amounts);
    const direction = sorted[0].creditDebit;
    const payee = sorted[0].payee;
    const evidence = `${sorted.length} ${direction === 'credit' ? 'payments in' : 'payments out'}, ${cadence}`;

    if (direction === 'credit') {
      if (shareWithin(amounts, mid, 0.25) < 0.7) continue;
      const sub = INCOME_TYPE_WORDS.find((t) => has(sorted[0].hay, t.words))?.subcategory ?? 'salary_wages';
      for (const l of sorted) {
        out.push({
          id: l.id, categoryKey: 'income', subcategoryKey: sub, cadence, occurrences: sorted.length, payeeKey: payee,
          why: `money arrives from the same payer on a regular schedule (${evidence}), so it looks like regular income. Change it if it is something else.`,
        });
      }
    } else {
      if (!has(sorted[0].hay, LOAN_WORDS)) continue;
      if (shareWithin(amounts, mid, 0.02) < 0.8) continue;
      for (const l of sorted) {
        out.push({
          id: l.id, categoryKey: 'loan_principal', subcategoryKey: 'other_loan_principal', cadence, occurrences: sorted.length, payeeKey: payee,
          why: `the same amount leaves on a regular schedule (${evidence}) to a payee whose name says loan or finance, so it looks like a loan repayment. Change it if it is something else.`,
        });
      }
    }
  }
  return out;
}
