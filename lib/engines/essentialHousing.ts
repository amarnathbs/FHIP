/**
 * ESSENTIAL HOUSING COST -- the owner-occupied home-loan repayment counts as an ESSENTIAL expense when the household
 * has recorded no rent. (PO rule, 17-10-2026: "Essential expenses about $2,805 - self-occupied / owner-occupied home
 * loan instalment amount is also essential, if there is no rent mentioned by the user.")
 *
 * ONE canonical place, pure (no I/O, no imports beyond the money formatter), client-safe. computeDashboard()
 * (lib/engines/dashboard.ts) calls resolveEssentialHomeLoan() once and folds the result into
 * `essentialMonthlyExpenses` / `coreSurvivalMonthlyExpenses`; every other consumer (Emergency Fund, Resilience,
 * Financial DNA, Twin, the Monthly Report, AI context, Forecast, What-if) already reads those two fields, so none of
 * them has its own copy of this rule.
 *
 * WHAT THE RULE DOES, AND DOES NOT DO
 *  - It MOVES a repayment that is already counted (as debt service) INTO the essential bucket for the figures that
 *    ask "what must I keep paying to live": essential monthly total, emergency-fund months, Resilience essential /
 *    core-survival months, the DNA and Twin essential-expense ratios, operating cash flow.
 *  - It does NOT change total outflow, monthly surplus, savings rate, debt-service ratio or debt-to-income. The
 *    repayment stays in `debtMonthlyRepayments` (the PO decisions: surplus includes debt repayment, DSR uses net
 *    income, DTI stays gross) and stays OUT of `totalMonthlyExpenses`/`lifestyleMonthlyExpenses`, so the same dollars
 *    are never counted twice. The dashboard engine carries the amount as `essentialHomeLoan.monthly` so every place
 *    that adds essential + debt (Twin fixed-commitment ratio, What-if, disposable income) can take it out once.
 *
 * RECOGNISING THE OWNER-OCCUPIED LOAN -- isOwnerOccupiedLoan() is the ONE selector. Evidence, strongest first:
 *   1. an explicit property-use answer on the loan's property ('self_occupied' = yes; investment / holiday / vacant /
 *      other = NO, even if the loan carries the home_loan catalogue key). Not collected yet: the field exists so the
 *      input-time property-use work can supply it without touching this rule;
 *   2. an active property_liability_links row of link_type 'owner_occupied_mortgage' (the loan finances the
 *      principal residence) = yes; an active link to a property of another purpose (investment / commercial / SMSF
 *      / other) and no owner-occupied link = no;
 *   3. fallback: the standard 'Home Loan' catalogue item (master_item_key = 'home_loan') = yes.
 * Everything else (investment_loan, construction_loan, commercial_loan, smsf_property_loan, personal / car / credit
 * card / education loans, custom rows with no key and no link) is NOT part of this rule.
 *
 * EDGE CASES (each has a test in tests/unit/essentialHomeLoanRule.test.ts)
 *  - Rent recorded (a counted 'rent' expense row, or imported actual spending categorised Housing > Rent) with an
 *    amount above zero: rent is the housing cost; the loan is NOT added. Remove the rent and the loan comes back.
 *  - Rent AND a home loan (rents one place, owns another): rent present, so the loan is not added.
 *  - Several owner-occupied loans (a split loan: the Home Loan plus a custom row linked to the residence): every one
 *    that is recognised is counted, each once. An investment/construction loan beside them is never counted.
 *  - Joint ownership: the household's repayment is counted once, as recorded (no share is applied).
 *  - Zero or missing repayment: nothing to count; the status says 'repayment_not_recorded'.
 *  - Inactive loan: not counted. Entity-held loan (SMSF / trust / company owner, or an SMSF property loan): not the
 *    household's housing cost, not counted.
 *  - The amount is the SAME monthly debt-service figure the surplus uses for that loan (a statement-derived actual
 *    when the loan has approved statement history, otherwise the recorded `monthly_repayment`, which is stored as a
 *    monthly amount), so the essential figure always reconciles with what Liabilities and the surplus show.
 */
import { formatMoney } from './money';

/** Where the owner-occupied decision for a loan came from (provenance, shown in tests and the note). */
export type OwnerOccupiedBasis = 'explicit_property_use' | 'principal_residence_link' | 'home_loan_catalogue_item';

/** The explicit answer a future input step records about the property a loan finances. */
export type PropertyUse = 'self_occupied' | 'investment' | 'holiday' | 'vacant' | 'other';

export type PropertyLinkPurpose = 'owner_occupied' | 'other';

export interface HousingLoanInput {
  id?: string | null;
  name?: string | null;
  masterItemKey?: string | null;
  debtType?: string | null;
  owner?: string | null;
  /** false = the loan is closed / inactive. Absent = active (the loaders only read active rows). */
  isActive?: boolean | null;
  /** The loan is the fund's own property loan (SMSF) or otherwise entity-held: never a household housing cost. */
  entityHeld?: boolean | null;
  /** Explicit property-use answer for the property this loan finances (future input step). */
  propertyUse?: PropertyUse | null;
  /** Purposes of the loan's ACTIVE property links, from property_liability_links.link_type. Empty/absent = no link. */
  linkPurposes?: readonly PropertyLinkPurpose[] | null;
  /** The monthly repayment counted for this loan, in the reporting currency; null = unconvertible. */
  monthly: number | null;
}

export interface OwnerOccupiedVerdict {
  ownerOccupied: boolean;
  basis: OwnerOccupiedBasis | null;
}

const ENTITY_OWNER_TAGS = new Set(['smsf', 'family_trust', 'company']);

/** The standard catalogue spelling of the household's own home loan (supabase/seed_master_items.sql). */
export const OWNER_OCCUPIED_HOME_LOAN_ITEM_KEY = 'home_loan';

/** The expense catalogue item for rent (supabase/seed_master_items.sql: ('expense', 'rent', 'Rent')). */
export const RENT_EXPENSE_ITEM_KEY = 'rent';

/**
 * THE selector: is this loan the household's owner-occupied (principal residence) loan? Pure. A later input-time
 * property-use answer or property link is preferred automatically; the catalogue key is the fallback.
 */
export function isOwnerOccupiedLoan(loan: HousingLoanInput): OwnerOccupiedVerdict {
  if (loan.propertyUse) {
    return loan.propertyUse === 'self_occupied'
      ? { ownerOccupied: true, basis: 'explicit_property_use' }
      : { ownerOccupied: false, basis: null };
  }
  const purposes = loan.linkPurposes ?? [];
  if (purposes.length > 0) {
    return purposes.includes('owner_occupied')
      ? { ownerOccupied: true, basis: 'principal_residence_link' }
      : { ownerOccupied: false, basis: null };
  }
  if (loan.masterItemKey === OWNER_OCCUPIED_HOME_LOAN_ITEM_KEY) return { ownerOccupied: true, basis: 'home_loan_catalogue_item' };
  return { ownerOccupied: false, basis: null };
}

export type EssentialHomeLoanStatus =
  /** The repayment is counted as essential. */
  | 'counted'
  /** The user recorded rent: rent is the housing cost, the loan is not added. */
  | 'rent_recorded'
  /** An owner-occupied loan exists but has no repayment recorded: nothing to count. */
  | 'repayment_not_recorded'
  /** No owner-occupied home loan on file (or it is inactive / entity-held). */
  | 'no_home_loan';

export interface EssentialHomeLoanLine {
  id: string | null;
  name: string;
  monthly: number;
  basis: OwnerOccupiedBasis;
}

export interface EssentialHomeLoanResolution {
  status: EssentialHomeLoanStatus;
  /** Monthly amount moved into the essential bucket (0 unless status = 'counted'). Reporting currency. */
  monthly: number;
  lines: EssentialHomeLoanLine[];
  /** The monthly rent recorded (0 when none). */
  rentMonthly: number;
  /** Owner-occupied loans recognised (whatever their repayment), so a note can say "you rent, so the loan is not added". */
  recognisedLoanCount: number;
  /** Owner-occupied loans that were recognised but carry no repayment. */
  loansWithoutRepayment: number;
}

export const NO_ESSENTIAL_HOME_LOAN: EssentialHomeLoanResolution = Object.freeze({
  status: 'no_home_loan' as const,
  monthly: 0,
  lines: [] as EssentialHomeLoanLine[],
  rentMonthly: 0,
  recognisedLoanCount: 0,
  loansWithoutRepayment: 0,
}) as EssentialHomeLoanResolution;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function countsAsHouseholdLoan(loan: HousingLoanInput): boolean {
  if (loan.isActive === false) return false;
  if (loan.entityHeld) return false;
  if (loan.owner && ENTITY_OWNER_TAGS.has(loan.owner)) return false;
  return true;
}

export function resolveEssentialHomeLoan(input: {
  loans: readonly HousingLoanInput[];
  /** Monthly rent the household recorded (planned rent expense + imported actual rent), reporting currency. */
  rentMonthly: number;
}): EssentialHomeLoanResolution {
  const rentMonthly = Number.isFinite(input.rentMonthly) && input.rentMonthly > 0 ? round2(input.rentMonthly) : 0;
  const recognised = input.loans
    .filter(countsAsHouseholdLoan)
    .map((loan) => ({ loan, verdict: isOwnerOccupiedLoan(loan) }))
    .filter((x) => x.verdict.ownerOccupied);
  const withRepayment = recognised.filter((x) => x.loan.monthly !== null && Number.isFinite(x.loan.monthly) && (x.loan.monthly as number) > 0);
  const loansWithoutRepayment = recognised.length - withRepayment.length;
  if (rentMonthly > 0) {
    return { status: 'rent_recorded', monthly: 0, lines: [], rentMonthly, recognisedLoanCount: recognised.length, loansWithoutRepayment };
  }
  if (recognised.length === 0) return { ...NO_ESSENTIAL_HOME_LOAN, lines: [] };
  if (withRepayment.length === 0) {
    return { status: 'repayment_not_recorded', monthly: 0, lines: [], rentMonthly: 0, recognisedLoanCount: recognised.length, loansWithoutRepayment };
  }
  const lines: EssentialHomeLoanLine[] = withRepayment.map((x) => ({
    id: x.loan.id ?? null,
    name: x.loan.name ?? 'Home loan',
    monthly: round2(x.loan.monthly as number),
    basis: x.verdict.basis as OwnerOccupiedBasis,
  }));
  return { status: 'counted', monthly: round2(lines.reduce((s, l) => s + l.monthly, 0)), lines, rentMonthly: 0, recognisedLoanCount: recognised.length, loansWithoutRepayment };
}

/**
 * The provenance sentence shown wherever essentials are explained (Dashboard Emergency Fund, Expenses and
 * Liabilities pages, the Monthly Report). Null when the rule did not apply and there is nothing to say.
 */
export function essentialHomeLoanNote(resolution: EssentialHomeLoanResolution | null | undefined, currency: 'AUD' | 'INR'): string | null {
  if (!resolution) return null;
  switch (resolution.status) {
    case 'counted':
      return `Essential expenses include your home loan repayment of ${formatMoney(resolution.monthly, currency)} a month (no rent recorded).`;
    case 'repayment_not_recorded':
      return 'Your home loan repayment is not recorded, so it is not included in essential expenses. Add it on the Liabilities page.';
    case 'rent_recorded':
      return resolution.recognisedLoanCount > 0
        ? 'You recorded rent, so rent is your essential housing cost and a home loan repayment is not added.'
        : null;
    default:
      return null;
  }
}

/** The lines of the essential total shown on the Expenses page: label for the read-only home-loan line. */
export function essentialHomeLoanLineLabel(): string {
  return 'Home loan repayment (counted as essential, no rent recorded)';
}
