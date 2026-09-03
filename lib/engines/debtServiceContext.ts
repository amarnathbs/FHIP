// ---------------------------------------------------------------------------
// LR-FI-2 §R2 — CANONICAL HOUSEHOLD DEBT-SERVICE CLASSIFICATION.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Two registers can describe the SAME monthly cash event: a Liability's
// `monthly_repayment`, and an `expense_items` row the user wrote for the same
// repayment. Counting both double-counts the household's outflow in Monthly
// Surplus and the Debt Service Ratio.
//
// dashboard.ts has carried a de-duplication guard for this since the App
// Review pass, but it covered only two debt families (mortgage, auto). The
// Product Owner asked for that guard to be extended to every liability class
// that needs it — personal loan and credit card at minimum — and, first, for
// a trace of WHY it was family-specific. That trace is recorded here, because
// the answer determines what "extending" can and cannot mean.
//
// WHY THE GUARD WAS FAMILY-SPECIFIC (the actual root cause)
// ---------------------------------------------------------
// It was not an oversight in the classification. `supabase/seed_master_items.sql`
// seeds exactly TWO expense-category items that denote a debt REPAYMENT:
//
//     ('expense', 'mortgage',             'Mortgage',            10)
//     ('expense', 'car_loan_repayments',  'Car Loan Repayments', 460)
//
// There is no `personal_loan_repayments`, no `credit_card_repayment`, no
// education/business/tax repayment item. The old guard therefore already
// covered 100% of the catalogue's repayment items — it was complete with
// respect to the signals that exist, and looked family-specific only because
// the CATALOGUE is. Adding `personal_loan` or `credit_card` as keys of the
// expense->liability map would map expense master items that no user can ever
// hold, which is precisely the "adding category strings blindly" the Product
// Owner warned against.
//
// This module therefore does the thing that IS structurally useful: it makes
// the classification family-complete and family-correct on the LIABILITY side
// (so the guard matches the right debt and can never let, say, a car loan
// suppress a mortgage expense), it names the expense items that must NEVER be
// suppressed because they are genuine consumption, and it puts all of it in
// one place instead of three ad-hoc Sets spread across two engines.
//
// CONFORMANCE WITH THE ALREADY-CERTIFIED FDH-10 ECONOMICS
// -------------------------------------------------------
// The Financial Data Hub's own credit-card economics module (FDH-10) is the
// Product-Owner-scrutinised control for the same economic question, and its
// rule is: PURCHASE -> expense, PAYMENT -> transfer (never expense), INTEREST
// -> debt_interest, FEE -> fee, PRINCIPAL -> debt_principal. The classes below
// are deliberately aligned with it and a test asserts they stay aligned.
//
// It is MIRRORED rather than imported: `tests/unit/fdh1Isolation.test.ts`
// enforces a bidirectional boundary — the Hub may not import `lib/engines/**`,
// and nothing outside the Hub may import it (except the FDH-3 upload
// surface). That test scans `lib/`, `app/` and `components/` for the Hub's
// directory name as a plain substring, so even naming that path in a COMMENT
// here trips it — which is why this note describes the module in prose. An
// import would break a certified isolation test; conformance is proven by
// source-level assertion in tests/unit/lrFi2DebtServiceExactlyOnce.ts instead.
// ---------------------------------------------------------------------------

// PRODUCT OWNER RULING — the boundary of this module's job
// --------------------------------------------------------
// A free-text Custom Expense row ("+ Add Custom Item") carries
// master_item_key=null and expense_category='other', so it holds NO structured
// evidence of being debt service. Three standing rulings govern that:
//
//   PO-FI2-09  Do NOT add personal-loan or credit-card repayment items to the
//              Expense catalogue. Debt repayments belong to Liabilities /
//              debt service; adding them as ordinary Expenses would close a
//              test gap by making the product model worse.
//   PO-FI2-10  A custom entry remains a user-declared expense unless FHIP has
//              EXPLICIT STRUCTURED evidence it is debt service. Inferring it
//              from the description via substring or fuzzy matching is
//              forbidden — "Personal loan advice fee" is a legitimate expense
//              that name-matching would silently delete.
//   PO-FI2-11  The future Unified Input UX supplies the structured route
//              (Debt / Loan Payment -> Select Liability), after which this
//              module gains a real signal to act on.
//
// So this file classifies STRUCTURED signals only — `master_item_key` and
// `expense_category`. It never reads an expense's name, and a test asserts it
// never will. The remaining custom-row case is a DEFERRED UX/SEMANTIC INPUT
// GAP for LR-2/LR-3, not a financial-integrity defect.

/**
 * Debt families, fine-grained enough that a repayment expense row can only
 * ever be matched against the RIGHT liability. Matching by family (rather
 * than "does the household hold any liability at all") is what stops a car
 * loan on file from silently deleting a genuine mortgage expense row.
 */
export type DebtFamily =
  | 'property'
  | 'vehicle'
  | 'personal'
  | 'education'
  | 'revolving'
  | 'business'
  | 'investment'
  | 'tax'
  | 'other';

/**
 * Debt-service economics, mirroring FDH-10's classification.
 *
 *  - `instalment`: a term/amortising debt. Its scheduled repayment is a real,
 *    distinct household cash event. Nothing else in the household registers
 *    represents that same money, so it belongs in outflow exactly once — and
 *    a duplicate expense row for it must be suppressed.
 *
 *  - `revolving`: a facility whose balance is BUILT from purchases the user
 *    records as ordinary expense rows (groceries, fuel, restaurants). Its
 *    repayment settles those already-recorded purchases, which is why FDH-10
 *    classifies a card PAYMENT as 'transfer' and never 'expense'.
 */
export type DebtServiceClass = 'instalment' | 'revolving';

/** Liability master-item key -> family. Keys match supabase/seed_master_items.sql. */
const LIABILITY_ITEM_TO_FAMILY: Record<string, DebtFamily> = {
  home_loan: 'property',
  investment_loan: 'property',
  construction_loan: 'property',
  commercial_loan: 'property',
  smsf_property_loan: 'property',
  mortgage_offset_facility: 'property',
  car_loan: 'vehicle',
  motorcycle_loan: 'vehicle',
  boat_loan: 'vehicle',
  personal_loan: 'personal',
  medical_loan: 'personal',
  family_loan: 'personal',
  private_loan: 'personal',
  education_loan: 'education',
  hecs_help: 'education',
  credit_card: 'revolving',
  store_card: 'revolving',
  buy_now_pay_later: 'revolving',
  line_of_credit: 'revolving',
  business_loan: 'business',
  margin_loan: 'investment',
  tax_debt: 'tax',
  ato_payment_plan: 'tax',
  guarantees: 'other',
  other_liabilities: 'other',
};

/**
 * `debt_type`'s own Zod enum (lib/validation/liability.ts) is the fallback for
 * rows created through the API rather than the catalogue-driven grid. The grid
 * never collects debt_type — it stays at its schema default — which is why
 * master_item_key is checked first everywhere in this file, the same
 * precedence dashboard.ts already uses for asset_class/investment_type.
 */
const DEBT_TYPE_TO_FAMILY: Record<string, DebtFamily> = {
  mortgage: 'property',
  auto_loan: 'vehicle',
  car_loan: 'vehicle',
  personal_loan: 'personal',
  student_loan: 'education',
  credit_card: 'revolving',
};

export function debtFamilyFor(debtType: string, masterItemKey?: string | null): DebtFamily {
  if (masterItemKey) return LIABILITY_ITEM_TO_FAMILY[masterItemKey] ?? DEBT_TYPE_TO_FAMILY[debtType] ?? 'other';
  return DEBT_TYPE_TO_FAMILY[debtType] ?? 'other';
}

export function debtServiceClassFor(debtType: string, masterItemKey?: string | null): DebtServiceClass {
  return debtFamilyFor(debtType, masterItemKey) === 'revolving' ? 'revolving' : 'instalment';
}

/**
 * Expense master items that represent a liability's scheduled REPAYMENT, and
 * the debt family whose `monthly_repayment` already captures that same money.
 *
 * This is the complete set of repayment-denoting items in the catalogue —
 * see the root-cause note at the top of this file. It is keyed by family
 * rather than by a hand-written list of liability items so that adding a new
 * liability item to LIABILITY_ITEM_TO_FAMILY above automatically extends the
 * guard, instead of requiring a second edit that a future change could miss.
 */
export const DEBT_REPAYMENT_EXPENSE_ITEM_TO_FAMILY: Record<string, DebtFamily> = {
  mortgage: 'property',
  car_loan_repayments: 'vehicle',
};

/**
 * Expense items that are the COST of holding debt (interest, fees) rather than
 * a repayment of it.
 *
 * These must NEVER be suppressed. Under FDH-10's certified economics interest
 * and fees are genuine current-period consumption (`expenseTotal = interest +
 * fee`), and the Product Owner's own control table requires "Credit-card
 * interest -> Expense once", "Credit-card fee -> Expense once" and
 * "Personal-loan interest/fee -> Expense once".
 *
 * They are enumerated explicitly, and asserted disjoint from the repayment map
 * above, so that a future attempt to "extend the guard to credit cards" cannot
 * reach for `credit_card_fees` — the nearest-looking catalogue item — and
 * silently delete a real expense.
 */
export const DEBT_COST_EXPENSE_ITEMS: ReadonlySet<string> = new Set([
  'loan_interest',
  'credit_card_fees',
  'bank_fees',
]);

/** The `expense_category` value denoting a debt repayment (lib/validation/expense.ts). */
export const DEBT_REPAYMENT_EXPENSE_CATEGORY = 'debt_repayment';

export interface DebtServiceExpenseRow {
  master_item_key?: string | null;
  expense_category?: string | null;
}

export interface ServicedDebtFamilies {
  /** Families for which the household holds a liability with a nonzero repayment. */
  families: ReadonlySet<DebtFamily>;
  /** True when ANY household liability carries a nonzero repayment. */
  any: boolean;
}

/**
 * Which debt families the household is actually servicing. Built only from
 * liabilities that carry a NONZERO `monthly_repayment`, so a repayment expense
 * row with no corresponding liability repayment on file is never silently
 * dropped from cash flow — there is nothing double-counting it.
 */
export function servicedDebtFamilies(
  liabilities: readonly { debt_type: string; master_item_key?: string | null; monthly_repayment?: number | null }[]
): ServicedDebtFamilies {
  const families = new Set<DebtFamily>();
  for (const l of liabilities) {
    if ((l.monthly_repayment ?? 0) <= 0) continue;
    families.add(debtFamilyFor(l.debt_type, l.master_item_key));
  }
  return { families, any: families.size > 0 };
}

/**
 * True when this expense row represents money a Liability's `monthly_repayment`
 * already counts, so counting it here as well would double-count one cash event.
 *
 * Precedence, and why:
 *   1. A debt-COST item (interest/fee) is never a duplicate — checked FIRST so
 *      it can never be reached by any later branch.
 *   2. A known repayment item is a duplicate only when the household actually
 *      services a liability of the MATCHING family.
 *   3. Any other catalogued item is ordinary consumption.
 *   4. Rows with no master item (custom rows, or API rows) fall back to the
 *      explicit `expense_category='debt_repayment'` declaration, still gated on
 *      a real liability repayment existing somewhere.
 */
export function isDuplicateDebtServiceExpense(row: DebtServiceExpenseRow, serviced: ServicedDebtFamilies): boolean {
  if (row.master_item_key) {
    if (DEBT_COST_EXPENSE_ITEMS.has(row.master_item_key)) return false;
    const family = DEBT_REPAYMENT_EXPENSE_ITEM_TO_FAMILY[row.master_item_key];
    if (!family) return false;
    return serviced.families.has(family);
  }
  return row.expense_category === DEBT_REPAYMENT_EXPENSE_CATEGORY && serviced.any;
}
