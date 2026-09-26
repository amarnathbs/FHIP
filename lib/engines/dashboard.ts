import { toMonthly, type Frequency } from './money';
import { convertToReportingCurrency, type SupportedCurrency } from './fx';
import { computeBusinessEntityOwnershipValue, type BusinessEntityWithLineItems } from './businessEntityValuation';
import { householdOperatingCashFlowRows, isHouseholdOperatingCashFlow } from './householdContext';
import { debtServiceClassFor, isDuplicateDebtServiceExpense, servicedDebtFamilies } from './debtServiceContext';

// ---------------------------------------------------------------------------
// Input row shapes (the subset of each register's columns the dashboard uses)
// ---------------------------------------------------------------------------

// LR-FI-1: `owner` is optional on every row shape below so this engine keeps
// compiling (and behaving identically) for any caller that has not yet added
// the column to its SELECT — an absent owner is treated as household context.
// It is declared only on the four registers that carry operating cash flow;
// assets/investments/retirement are wealth-only and are never filtered here.
export interface IncomeRow {
  source_name?: string | null;
  amount: number;
  net_amount: number | null;
  frequency: Frequency;
  master_item_key: string | null;
  employer_name?: string | null;
  owner?: string | null;
  // LR-3 (migration 0131): explicit, user-declared opt-out — true once the
  // user has said this row's real income is now tracked via an approved
  // bank/payslip import instead. Optional so every existing caller (tests,
  // any select that predates the column) keeps compiling and behaving
  // identically — undefined is treated the same as false.
  superseded_by_bank_import?: boolean | null;
  // WP-03 (DC-12 / GAP-03): converted to the reporting currency; an absent
  // code is the reporting currency (legacy fixtures), an unsupported one is
  // excluded and surfaced in dataStatus.unconverted.
  currency_code?: string | null;
}
export interface ExpenseRow {
  expense_name: string;
  amount: number;
  frequency: Frequency;
  is_essential: boolean;
  master_item_key?: string | null;
  expense_category?: string | null;
  owner?: string | null;
  // LR-3 (migration 0131): see IncomeRow's matching field.
  superseded_by_bank_import?: boolean | null;
  currency_code?: string | null; // see IncomeRow
}

// ---------------------------------------------------------------------------
// WP-03 (Approved Upload -> Canonical programme): the CANONICAL cash-flow
// input. The server loader (lib/services/dashboardData.ts) builds ONE
// CanonicalFinancialSnapshot per request (lib/read-models) and maps its
// income / expense / liability read models into this plain shape, so this
// engine stays pure and client-importable (it never imports a read model at
// runtime -- only this DTO crosses the boundary).
//
// When `canonical` is present, EVERY cash-flow figure comes from it and the
// raw income / expense rows are ignored:
//   - income: planned income_sources + approved bank credits, the payslip's
//     own matched bank credit counted ONCE (GAP-01), unknown net never
//     replaced by gross (GAP-09), currency converted once (GAP-03);
//   - expenses: the COMBINED basis -- per canonical group, the actual monthly
//     average over complete covered months when the group has any, otherwise
//     the plan; never planned + actual for the same group (PO D-02, DC-02);
//     no calendar-month window (DC-01);
//   - debt service: counted ONCE per liability (PO D-08 / D-09): actual loan
//     principal + interest + fee REPLACES the contractual repayment, and a
//     revolving card's minimum payment is not added on top of the purchases.
// The pre-programme `bankExpenseTransactions` / `bankIncomeTransactions`
// inputs (current calendar month, blindly added to the plan) are removed.
// ---------------------------------------------------------------------------

export interface CanonicalUnavailable {
  status: 'unavailable';
  reason: string;
  source: string;
}

export interface CanonicalIncomeLine {
  name: string;
  /** Reporting currency, per month (gross). */
  monthly: number;
  employerName: string | null;
  masterItemKey: string | null;
  source: 'planned' | 'actual' | 'variable_pay';
}

export interface CanonicalIncomeFigures {
  status: 'ok';
  grossMonthly: number;
  /** The KNOWN net only -- a component whose net is unknown adds nothing here (GAP-09). */
  netKnownMonthly: number;
  netUnknownComponents: number;
  /** D-07: bank credits (net only) are inside the gross as a floor. */
  grossIncludesNetFloor: boolean;
  /** Approved bank income credits counted (not represented by a payslip row). */
  importedMonthly: number;
  lines: CanonicalIncomeLine[];
  /** hasIncome: any household income on file, planned or actual. */
  present: boolean;
  possibleDuplicateCount: number;
  representedCount: number;
  unconverted: { count: number; byCurrency: Record<string, number> };
}

export interface CanonicalExpenseLine {
  name: string;
  monthly: number;
  source: 'planned' | 'actual';
}

export interface CanonicalExpenseFigures {
  status: 'ok';
  monthly: number;
  essentialMonthly: number;
  lifestyleMonthly: number;
  coreSurvivalMonthly: number;
  /** The slice of `monthly` taken from imported actuals (groups on the actual basis). */
  importedMonthly: number;
  lines: CanonicalExpenseLine[];
  /** hasExpenses: any household expense on file, planned or actual. */
  present: boolean;
  unconverted: { count: number; byCurrency: Record<string, number> };
  unknownPendingCount: number;
  excludedDuplicates: number;
  partialLineCount: number;
  unlinkedRefundCount: number;
}

export interface CanonicalDebtServiceFigures {
  status: 'ok';
  householdMonthly: number;
  /** D-09 display line: interest + fees inside card/loan repayments (already inside householdMonthly). */
  costOfDebtMonthly: number;
  principalMonthly: number;
}

export interface CanonicalCashFlowInput {
  income: CanonicalIncomeFigures | CanonicalUnavailable;
  expenses: CanonicalExpenseFigures | CanonicalUnavailable;
  debtService: CanonicalDebtServiceFigures | CanonicalUnavailable;
  /** The read window the actual figures were averaged over. */
  window: { from: string; to: string; months: string[]; coveredMonths: string[] } | null;
  /** Other snapshot sections that could not be read (investments, retirement, assets, ledger). */
  otherUnavailable: { section: string; reason: string; source: string }[];
  /** D-05 / D-04 evidence buckets, shown but never inside Net Worth. */
  importedNotInNetWorth: { label: string; count: number; total: number } | null;
  bankBalanceEvidence: { label: string; count: number; total: number } | null;
}

/**
 * How the figures were produced, and everything that was left OUT of them
 * (DC-14: an error or an unconvertible amount is never shown as a real zero).
 */
export interface DashboardDataStatus {
  basis: 'canonical_read_models' | 'registers_only';
  /** Sections that could not be read; their figures are excluded, and their has* flags false. */
  unavailable: { section: string; reason: string; source: string }[];
  /** Amounts in a currency the app cannot convert (e.g. USD): excluded from totals, never added raw. */
  unconverted: { count: number; byCurrency: Record<string, number> };
  /** GAP-09: counted income components whose NET is unknown (never replaced by gross). */
  netIncomeUnknownComponents: number;
  /** Surplus basis: 'net' (all known), 'net_partial' (unknown nets left out), 'gross_fallback' (no net known). */
  netIncomeBasis: 'net' | 'net_partial' | 'gross_fallback' | 'none';
  grossIncomeIncludesNetFloor: boolean;
  /** D-09 display line ("Cost of debt"): already inside debtMonthlyRepayments, never added again. */
  costOfDebtMonthly: number;
  window: CanonicalCashFlowInput['window'];
  importedNotInNetWorth: CanonicalCashFlowInput['importedNotInNetWorth'];
  bankBalanceEvidence: CanonicalCashFlowInput['bankBalanceEvidence'];
  /** Retirement contributions with no frequency: shown, never assumed monthly (GAP-RET-02). */
  retirementContributionFrequencyUnknown: number;
  /** D-07 review prompts: imported income credits that look like a planned source. */
  possibleDuplicateIncomeCount: number;
  /** Imported lines not yet approved / still 'unknown' (never counted, never guessed). */
  unknownPendingCount: number;
  /** Result of this load's financial_snapshots write (set by the loader). */
  snapshotWrite?: 'written' | 'failed' | 'skipped_read_only';
}
// LR-FI-1: assets/investments/retirement_accounts carry the same `owner`
// column as the other four registers (migration 0004), so it is declared here
// too — but this engine DELIBERATELY never filters on it for these three.
// They are pure wealth registers: an SMSF-owned asset, investment or
// retirement balance must keep contributing to totalAssets/totalInvestments/
// totalRetirement and therefore to Net Worth (spec §5, §28). Declaring the
// field makes that decision explicit and lets tests assert it directly,
// rather than leaving "why isn't this filtered?" to inference.
export interface AssetRow {
  current_value: number;
  asset_class: string;
  master_item_key?: string | null;
  country_code?: string | null;
  currency_code?: string | null;
  owner?: string | null;
}
export interface LiabilityRow {
  balance: number;
  interest_rate: number | null;
  monthly_repayment: number;
  debt_type: string;
  master_item_key?: string | null;
  interest_rate_type?: 'fixed' | 'variable' | null;
  fixed_rate_expiry?: string | null;
  credit_limit?: number | null;
  country_code?: string | null;
  currency_code?: string | null;
  owner?: string | null;
}
export interface InvestmentRow {
  current_value: number;
  cost_base: number | null;
  investment_type: string;
  master_item_key?: string | null;
  country_code: string | null;
  annual_contribution: number | null;
  institution?: string | null;
  currency_code?: string | null;
  owner?: string | null; // see AssetRow — declared, deliberately never filtered
}
export interface RetirementRow {
  current_balance: number;
  employer_contribution: number | null;
  personal_contribution: number | null;
  contribution_frequency: Frequency | null;
  country_code?: string | null;
  currency_code?: string | null;
  owner?: string | null; // see AssetRow — declared, deliberately never filtered
}
export interface InsuranceRow {
  policy_name: string;
  cover_amount: number;
  premium: number;
  premium_frequency: Frequency;
  cover_type: string;
  renewal_date: string | null;
  waiting_period_days?: number | null;
  owner?: string | null;
  currency_code?: string | null; // WP-03: cover and premium converted (DC-12)
}
export interface GoalRow {
  goal_name: string;
  target_amount: number;
  current_amount: number;
  currency_code: string;
  target_date: string | null;
  priority: string;
  status: string;
}
export interface SnapshotRow {
  snapshot_month: string;
  net_worth: number;
  monthly_income: number;
  monthly_expenses: number;
  monthly_surplus: number;
  savings_rate: number | null;
  total_assets: number;
  total_liabilities: number;
  // G6 Contract 3 (docs/country-programme/g6-data-contracts.md) — FX-rate
  // lineage, optional/nullable so every pre-G6 historical row (and every
  // existing caller/test fixture that doesn't select these two new
  // columns) keeps compiling and behaving byte-for-byte identically.
  // Passed through verbatim (this engine does no snapshot-trend
  // calculation with them today) — a future currency-drift-aware trend UI
  // can read them; NULL means "rate unknown," never a fabricated/assumed
  // value.
  fx_rate_aud_inr?: number | null;
  fx_rate_date?: string | null;
}

export interface DashboardInput {
  income: IncomeRow[];
  expenses: ExpenseRow[];
  assets: AssetRow[];
  liabilities: LiabilityRow[];
  investments: InvestmentRow[];
  retirement: RetirementRow[];
  insurance: InsuranceRow[];
  goals: GoalRow[];
  snapshots: SnapshotRow[]; // most recent last
  // WP-03: the canonical cash-flow figures (see CanonicalCashFlowInput). The
  // Dashboard loader always passes it; a caller that does not (the Twin until
  // WP-05, unit fixtures) gets the registers-only computation, which has NO
  // imported actuals -- the old LR-3 current-month bank arrays are gone.
  canonical?: CanonicalCashFlowInput;
  // LR-11 (Company / Family Trust Entity Architecture) — this household's
  // active business entities, each with the raw line items
  // computeBusinessEntityOwnershipValue() needs to net. Optional and
  // defaulted to [] below so every existing caller/test fixture (everyone
  // before LR-11) keeps compiling and behaves byte-for-byte identically — a
  // household with no business entities sees zero change from this feature
  // existing, exactly like bankExpenseTransactions above.
  businessEntities?: BusinessEntityWithLineItems[];
}

// Income sources not derived from active work — used for passive-income and
// financial-independence ratios.
export const PASSIVE_INCOME_KEYS: ReadonlySet<string> = new Set([
  'rental_income',
  'airbnb_income',
  'interest_income',
  'dividend_income',
  'managed_fund_distribution',
  'capital_gains',
  'trust_distribution',
  'partnership_distribution',
  'royalty_income',
  'super_pension',
  'annuity_income',
  'government_pension',
  'age_pension',
  'disability_pension',
  'family_tax_benefit',
  'child_support_received',
  'overseas_income',
]);

// Approximates the Level 1 "Core Survival" expense tier (housing, utilities,
// groceries, essential health, minimum transport) from existing master-item
// tags, since expenses aren't separately tiered in the data model. Only
// counted when the row is also marked essential by the user.
export const CORE_SURVIVAL_EXPENSE_KEYS: ReadonlySet<string> = new Set([
  'mortgage',
  'rent',
  'council_rates',
  'water_rates',
  'electricity',
  'gas',
  'water',
  'groceries',
  'health_insurance',
  'medical',
  'pharmacy',
  'fuel',
  'public_transport',
]);

export type AllocationBucket =
  | 'cash'
  | 'property'
  | 'shares'
  | 'super'
  | 'business'
  | 'fixed_income'
  | 'crypto'
  | 'gold'
  | 'other';

// asset_class (lib/validation/asset.ts) is a 5-value enum ('cash'|'property'|
// 'vehicle'|'business'|'other') that the real grid UI (lib/grid/configs.ts)
// never actually collects — every row created through the live app leaves it
// at its Zod default ('other'), same root cause already fixed for the
// Forecasting Engine's investment-return mapping (see
// lib/engines/forecast/investmentCalculator.ts's MASTER_ITEM_TO_ASSET_CLASS
// comment: "master_item_key is the reliable asset-class signal — the grid
// always sets it; investment_type/asset_class/debt_type it does not
// collect at all"). Without this, liquidAssets was silently 0 for every
// real user (never just this test's synthetic data), which cascades into
// emergencyFundMonths, liquidAssetRatio and propertyConcentration always
// reading 0 too. Keyed from the same master_financial_items catalogue
// (supabase/seed_master_items.sql, 'asset' category, 39 items).
const MASTER_ASSET_ITEM_TO_BUCKET: Record<string, AllocationBucket> = {
  wallet_cash: 'cash',
  savings_account: 'cash',
  cheque_account: 'cash',
  offset_account: 'cash',
  term_deposits: 'cash',
  foreign_currency: 'cash',
  principal_residence: 'property',
  investment_property: 'property',
  holiday_home: 'property',
  vacant_land: 'property',
  commercial_property: 'property',
  farm: 'property',
  business_ownership: 'business',
  partnership_interest: 'business',
  gold: 'gold',
  silver: 'gold',
  cryptocurrency: 'crypto',
  shares: 'shares',
  etfs: 'shares',
  managed_funds: 'shares',
  bonds: 'fixed_income',
};

export function bucketAssetClass(assetClass: string, masterItemKey?: string | null): AllocationBucket {
  const fromCatalog = masterItemKey ? MASTER_ASSET_ITEM_TO_BUCKET[masterItemKey] : undefined;
  if (fromCatalog) return fromCatalog;
  if (assetClass === 'cash') return 'cash';
  if (assetClass === 'property') return 'property';
  if (assetClass === 'business') return 'business';
  return 'other';
}

// Same root cause and fix pattern as MASTER_ASSET_ITEM_TO_BUCKET above.
// investment_type (lib/validation/investment.ts) is likewise never
// collected by the grid. Keyed from master_financial_items' 'investment'
// category (32 items) — the type-string checks below (kept as a secondary
// fallback for rows set directly via the API rather than the grid) already
// assumed catalog-style plural keys like 'etfs'/'managed_funds', not the
// singular Zod enum values ('etf'/'managed_fund'), which was itself a sign
// this mapping was written for master_item_key and just never wired to it.
const MASTER_INVESTMENT_ITEM_TO_BUCKET: Record<string, AllocationBucket> = {
  cash_investments: 'cash',
  high_interest_savings: 'cash',
  term_deposits: 'cash',
  property: 'property',
  commercial_property: 'property',
  reits: 'property',
  bonds: 'fixed_income',
  government_bonds: 'fixed_income',
  corporate_bonds: 'fixed_income',
  gold: 'gold',
  silver: 'gold',
  cryptocurrency: 'crypto',
  business_investment: 'business',
  partnership_investment: 'business',
  shares: 'shares',
  etfs: 'shares',
  managed_funds: 'shares',
  index_funds: 'shares',
  australian_shares: 'shares',
  international_shares: 'shares',
};

export function bucketInvestmentType(type: string, masterItemKey?: string | null): AllocationBucket {
  const fromCatalog = masterItemKey ? MASTER_INVESTMENT_ITEM_TO_BUCKET[masterItemKey] : undefined;
  if (fromCatalog) return fromCatalog;
  if (['cash_investments', 'high_interest_savings', 'term_deposits'].includes(type)) return 'cash';
  if (['property', 'commercial_property', 'reits'].includes(type)) return 'property';
  if (['bonds', 'government_bonds', 'corporate_bonds'].includes(type)) return 'fixed_income';
  if (type === 'gold' || type === 'silver') return 'gold';
  if (type === 'cryptocurrency') return 'crypto';
  if (['business_investment', 'partnership_investment'].includes(type)) return 'business';
  if (
    ['shares', 'etfs', 'managed_funds', 'index_funds', 'australian_shares', 'international_shares'].includes(type)
  )
    return 'shares';
  return 'other';
}

// debt_type (lib/validation/liability.ts) has the same never-collected-by-
// the-grid problem — GOOD_DEBT_TYPES below already contained catalog-style
// keys ('investment_loan', 'hecs_help') that don't even exist in debt_type's
// own 6-value Zod enum, a strong sign this was always meant to check
// master_item_key. 'mortgage' (the Zod enum spelling) is kept alongside
// 'home_loan' (the catalog spelling) so a row set either way still counts.
const GOOD_DEBT_MASTER_ITEMS = new Set(['home_loan', 'investment_loan', 'construction_loan', 'education_loan', 'hecs_help', 'business_loan']);
export function isGoodDebt(debtType: string, masterItemKey?: string | null): boolean {
  if (masterItemKey) return GOOD_DEBT_MASTER_ITEMS.has(masterItemKey) || debtType === 'mortgage';
  return debtType === 'mortgage' || GOOD_DEBT_MASTER_ITEMS.has(debtType);
}
export function isCreditCardDebt(debtType: string, masterItemKey?: string | null): boolean {
  return masterItemKey === 'credit_card' || masterItemKey === 'store_card' || debtType === 'credit_card';
}


// App Review spec §12-13's double-counting guard — a debt-repayment expense
// row and the matching Liability's monthly_repayment represent the same cash
// outflow — now lives in lib/engines/debtServiceContext.ts (LR-FI-2 §R2),
// which is the single canonical debt-service classification for the whole
// household layer. The two ad-hoc Sets that used to sit here covered only the
// mortgage and auto families; the canonical module covers all nine, so a
// commercial/construction/offset-facility loan can no longer fail to match a
// genuine "Mortgage" expense row. See that file's header for the root-cause
// trace of why this guard was ever family-specific.

// Standard loan amortisation: months to pay off a balance at a monthly rate
// with a fixed monthly payment. Returns null if the payment never covers the
// accruing interest (balance would grow forever).
export function estimateMonthsToPayoff(
  balance: number,
  annualRatePct: number | null,
  monthlyRepayment: number
): number | null {
  if (monthlyRepayment <= 0 || balance <= 0) return null;
  const r = (annualRatePct ?? 0) / 100 / 12;
  if (r <= 0) return Math.ceil(balance / monthlyRepayment);
  if (monthlyRepayment <= r * balance) return null;
  const months = -Math.log(1 - (r * balance) / monthlyRepayment) / Math.log(1 + r);
  return Math.ceil(months);
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export type RatioStatus = 'good' | 'caution' | 'risk' | 'neutral';

export interface RatioResult {
  key: string;
  label: string;
  value: number | null; // as a plain number (e.g. 0.23 for 23%, or a multiple like 2.5)
  format: 'percent' | 'multiple' | 'months';
  benchmarkLabel: string;
  status: RatioStatus;
}

export interface AllocationSlice {
  bucket: AllocationBucket;
  value: number;
}

export interface DashboardSummary {
  currency: 'AUD' | 'INR';

  // Cash flow
  grossMonthlyIncome: number;
  netMonthlyIncome: number;
  passiveMonthlyIncome: number;
  activeMonthlyIncome: number;
  essentialMonthlyExpenses: number;
  coreSurvivalMonthlyExpenses: number; // Level 1 subset of essential expenses (see CORE_SURVIVAL_EXPENSE_KEYS)
  lifestyleMonthlyExpenses: number;
  debtMonthlyRepayments: number;
  // LR-FI-2 §6c. The sum across ALL owners including SMSF, kept separate
  // from `debtMonthlyRepayments` (household-only) so a wealth projection
  // amortising the whole-balance-sheet `totalLiabilities` has a repayment on
  // the same all-owner basis — otherwise a household-only repayment
  // amortising a whole balance would never pay it down (LR-FI-2 §6c's own
  // reproduction test). The LR independent audit's P0-1 fix (2026-09-14)
  // briefly pointed this at the same owner-filtered array as
  // `debtMonthlyRepayments`; that was reverted by the LR-FI Financial-
  // Integrity Recovery (2026-09-17) alongside `totalLiabilities` itself —
  // see that field's own doc comment for why. Kept as its own named field
  // (rather than having every caller read `debtMonthlyRepayments` directly)
  // purely so `lib/services/forecastData.ts`'s and `lib/engines/whatIf.ts`'s
  // "same basis as totalLiabilities" wiring needs no changes here.
  totalLiabilityMonthlyRepayments: number;
  totalMonthlyExpenses: number; // essential + lifestyle, combined basis (excludes debt repayments, tracked separately)
  // The slice of totalMonthlyExpenses / grossMonthlyIncome taken from approved
  // imported actuals (WP-03: groups on the ACTUAL side of the combined basis,
  // and bank income credits not represented by a payslip row). A part of the
  // total, never added to it. 0 on the registers-only path.
  bankMonthlyExpenses: number;
  bankMonthlyIncome: number;
  monthlySurplus: number;
  savingsRate: number | null;
  operatingCashFlow: number; // net income after essential expenses only
  disposableIncome: number; // operating cash flow after debt repayments
  cashFlowRatio: number | null; // surplus / total expenses
  topExpenses: { name: string; monthlyAmount: number }[];
  topIncome: { name: string; monthlyAmount: number }[];
  incomeSourceCount: number;
  largestIncomeSharePct: number | null; // 0-1, largest single income row's share of gross income
  discretionaryRatio: number | null; // lifestyle expenses / income
  employerConcentration: number | null; // 0-1 HHI across distinct employers; null if no employer data recorded
  hasInvestments: boolean;
  hasRetirement: boolean;
  hasInsurance: boolean;

  // Net worth
  totalAssets: number; // property/cash/other assets only — excludes investments and retirement, which are tracked separately below
  totalAssetsCombined: number; // totalAssets + totalInvestments + totalRetirement — the figure to show as "total assets" anywhere net worth is also shown, so the two reconcile
  totalInvestments: number;
  totalRetirement: number;
  // LR-FI-1 §5/§28: ALL-owner, unfiltered — a liability's balance stays in
  // Net Worth regardless of owner, including owner=SMSF_OWNER and including a
  // liability LR-12R-linked to an SMSF fund's property (see
  // householdContext.ts's header and applySmsfPropertyLoanLinkOverride()'s
  // own doc comment: that override changes DTI/DSR only, never Net Worth).
  //
  // The LR independent audit's P0-1 fix (2026-09-14) pointed this at the
  // same owner-filtered array `debtMonthlyRepayments` uses, to stop an SMSF
  // fund's own linked property loan being subtracted twice: once already
  // netted inside the fund's own valuation (smsf_compute_detailed_net_value(),
  // migration 0084, reaching totalRetirement) and again here. Ground truth
  // proved live: an SMSF holding a $500,000 property against a $365,000
  // linked loan (nothing else) reported Net Worth −$230,000 instead of the
  // correct $135,000. That scenario is real, but the fix excluded EVERY
  // SMSF-context liability from this field, not only ones actually netted
  // elsewhere in the same computation — silently dropping a plain
  // owner=SMSF_OWNER (or LR-12R-linked) liability with no netted fund valuation
  // present out of Net Worth entirely (counted zero times, not once),
  // reproducing exactly with the opposite sign as the $365,000 LR-FI-1/
  // LR-FI-2/LR-12R regression the LR-FI Financial-Integrity Recovery
  // (2026-09-17) found and this reverts. computeDashboard() has no
  // per-loan/per-fund key to tell "already netted inside totalRetirement"
  // apart from "not netted anywhere" — correctly fixing the original
  // double-subtraction needs that correlation (or a gross, not netted, fund
  // valuation) and remains an open item for the PO, not silently re-broken
  // or silently left broken by this recovery.
  totalLiabilities: number;
  // LR-FI-2 §1. Liability balances in HOUSEHOLD context only (still
  // owner-filtered, unlike totalLiabilities above) — the balance-side
  // counterpart to debtMonthlyRepayments, and the basis for debtToIncome.
  // An SMSF liability (plain-tagged or LR-12R-linked) is excluded from the
  // user's PERSONAL debt ratios here even though its balance stays in
  // totalLiabilities/Net Worth above.
  householdLiabilityBalance: number;
  // LR-11 (Company / Family Trust Entity Architecture) — this user's own
  // ownership-% share of their active business entities' net asset value,
  // already included in totalAssetsCombined/netWorth above. Exposed
  // separately for transparency/traceability (AC-09: never mix incompatible
  // entity populations into one opaque number) — 0 for every household with
  // no business entities, identical to every pre-LR-11 result.
  businessEntityOwnershipValue: number;
  netWorth: number;
  netWorthAllocation: AllocationSlice[];
  liabilityByType: { debtType: string; balance: number }[];
  liquidAssetRatio: number | null; // liquid assets / total assets
  propertyConcentration: number | null; // property bucket / total assets
  assetsByCountry: { countryCode: string; value: number }[];
  liabilitiesByCountry: { countryCode: string; value: number }[];
  retirementByCountry: { countryCode: string; value: number }[];
  // G6 Contract 5 (docs/country-programme/g6-data-contracts.md) — a THIRD,
  // additive per-country view alongside assetsByCountry/liabilitiesByCountry/
  // retirementByCountry above (both of which are untouched and stay in each
  // row's OWN currency, by design — see reportingValue()'s own comment).
  // This one converts assets + retirement - liabilities per country through
  // the exact same reportingValue() function used for the blended netWorth
  // total, so a household can see net worth broken out by country in one
  // consistent reporting currency. Deliberately excludes investments (no
  // investmentsByCountry rollup exists anywhere in this engine today — adding
  // one would be new scope, not this contract's).
  netWorthByCountryConverted: { countryCode: string; value: number }[];
  countriesInUse: string[]; // distinct country_code values recorded anywhere, for cross-border section eligibility

  // Savings / emergency fund
  liquidAssets: number;
  emergencyFundMonths: number | null;

  // Debt
  averageInterestRate: number | null;
  debtToIncome: number | null;
  debtServiceRatio: number | null;
  liabilitiesWithPayoff: { debtType: string; balance: number; monthsToPayoff: number | null }[];
  goodDebt: number;
  badDebt: number;
  variableRateDebtBalance: number;
  variableRateDebtRatio: number | null; // balance-weighted; null if no liability has interest_rate_type recorded
  upcomingRateResetBalance12m: number; // fixed-rate balance expiring within 12 months
  creditUtilization: number | null; // credit-card balance / credit limit; null if no credit_limit recorded

  // Investments
  investmentCostBase: number;
  investmentUnrealisedGain: number;
  investmentDiversificationScore: number | null; // 0-100, higher = more diversified
  investmentByCountry: { countryCode: string; value: number }[];
  institutionConcentration: number | null; // 0-1 HHI across investment institutions; null if no institution data
  dividendMonthlyIncome: number;
  dividendYield: number | null; // annualised
  rentalMonthlyIncome: number; // rental_income + airbnb_income master items

  // Retirement
  retirementEmployerMonthlyContribution: number;
  retirementPersonalMonthlyContribution: number;
  investmentAnnualContribution: number;
  investmentContributionRate: number | null; // investment contributions / income
  retirementContributionRate: number | null; // employer + personal retirement contributions / income
  retirementEmployerContributionRate: number | null; // employer retirement contributions only / income — the genuinely additive portion, since it's never part of take-home pay (unlike personal retirement/investment contributions, which come out of the same income already reflected in savingsRate)

  // Insurance
  insuranceByType: { coverType: string; coverAmount: number; annualPremium: number }[];
  totalAnnualPremium: number;
  upcomingRenewals: { policyName: string; renewalDate: string }[];
  incomeProtectionWaitingPeriodDays: number | null; // longest waiting period across income-protection policies

  // Ratios (section 11)
  ratios: RatioResult[];

  // History
  snapshots: SnapshotRow[];

  // Goals (pass-through; computed progress happens in the UI layer)
  goals: GoalRow[];

  // Data completeness
  hasIncome: boolean;
  hasExpenses: boolean;
  hasAssets: boolean;
  hasLiabilities: boolean;

  // WP-03: how these figures were produced and what was left out of them.
  // Optional only so hand-built summaries in older fixtures keep compiling;
  // computeDashboard() always sets it.
  dataStatus?: DashboardDataStatus;
}

function ratio(
  key: string,
  label: string,
  value: number | null,
  format: RatioResult['format'],
  benchmarkLabel: string,
  status: RatioStatus
): RatioResult {
  return { key, label, value, format, benchmarkLabel, status };
}

// Matches crossBorderCalculator.ts's DEFAULT_FX_RATE_AUD_INR and the
// forecast_global_assumptions seed row — used only when no live rate is
// supplied, so single-currency households (the vast majority of callers)
// are entirely unaffected.
const DEFAULT_FX_RATE_AUD_INR = 56;

function toSupportedCurrency(code: string | null | undefined): SupportedCurrency | null {
  return code === 'AUD' || code === 'INR' ? code : null;
}

export function computeDashboard(input: DashboardInput, currency: 'AUD' | 'INR', fxRateAudInr: number = DEFAULT_FX_RATE_AUD_INR): DashboardSummary {
  // Converts a row's own-currency amount to the household's reporting
  // currency before it enters totalAssets/totalInvestments/totalRetirement/
  // totalLiabilities (and the allocation chart, which must stay consistent
  // with those totals). Rows with no currency_code, or one this app doesn't
  // recognise, are assumed to already be in the reporting currency — this
  // keeps every existing single-currency household byte-for-byte unchanged.
  // Per-country breakdowns (assetsByCountry etc., below) deliberately do NOT
  // go through this — the cross-border report section shows those "as
  // recorded, in each country's own currency" by design.
  //
  // WP-03 (DC-12): FAIL CLOSED on an unsupported currency. A row with NO
  // currency code (legacy fixtures -- every database row has one) is still the
  // reporting currency, so single-currency households are unchanged; but a
  // row in a currency this app cannot convert (e.g. USD) is no longer added
  // raw as if it were AUD/INR. It contributes 0 to every total and breakdown,
  // and is counted once in dataStatus.unconverted instead.
  function convertOrNull(rowCurrencyCode: string | null | undefined, amount: number): number | null {
    if (rowCurrencyCode === null || rowCurrencyCode === undefined || rowCurrencyCode === '') return amount;
    const rowCurrency = toSupportedCurrency(rowCurrencyCode);
    if (!rowCurrency) return null;
    return convertToReportingCurrency(amount, rowCurrency, currency, fxRateAudInr);
  }
  function reportingValue(rowCurrencyCode: string | null | undefined, amount: number): number {
    return convertOrNull(rowCurrencyCode, amount) ?? 0;
  }
  const unconverted = { count: 0, byCurrency: {} as Record<string, number> };
  function tallyUnconverted(rows: readonly { currency_code?: string | null }[], amountOf: (r: never) => number) {
    for (const r of rows) {
      if (convertOrNull(r.currency_code, 1) !== null) continue;
      const code = String(r.currency_code);
      unconverted.count += 1;
      unconverted.byCurrency[code] = (unconverted.byCurrency[code] ?? 0) + Number(amountOf(r as never));
    }
  }
  tallyUnconverted(input.assets, (r: AssetRow) => r.current_value);
  tallyUnconverted(input.investments, (r: InvestmentRow) => r.current_value);
  tallyUnconverted(input.retirement, (r: RetirementRow) => r.current_balance);
  tallyUnconverted(input.liabilities, (r: LiabilityRow) => r.balance);
  tallyUnconverted(input.insurance, (r: InsuranceRow) => r.cover_amount);
  // LR-FI-1 (P0 SMSF household financial isolation) — the single point where
  // this engine separates the PERSONAL household's operating cash flow from
  // an SMSF's own. Everything computed from these two arrays is household
  // cash flow; everything computed from input.assets/input.investments/
  // input.retirement, and from the *balances* on input.liabilities, is
  // household wealth and deliberately still reads the unfiltered registers,
  // so Net Worth is unchanged by this rule (spec §5, §28).
  //
  // Income: an SMSF's rental receipts, dividends, interest and distributions
  // belong to the fund, not to the member's disposable income (spec §10,
  // §14) — including them inflated gross/net income and therefore flattered
  // the Savings Rate, DSR and every score derived from them.
  // LR-3: a row the user has explicitly marked as "tracked via bank import
  // instead" is excluded from every calculation below exactly as if it did
  // not exist — its real economic value is counted instead via
  // bankMonthlyIncome/bankMonthlyExpenses further down. It is NOT removed
  // from `input.income`/`input.expenses` themselves (the grid still shows
  // it, unchanged, for the user's own reference) — only from the arrays this
  // engine computes from. Filtered before the SMSF household-context split
  // below so an SMSF-owned row that also happens to be superseded is
  // excluded for both reasons consistently, never double-handled.
  const nonSupersededIncome = input.income.filter((r) => !r.superseded_by_bank_import);
  const nonSupersededExpenses = input.expenses.filter((r) => !r.superseded_by_bank_import);
  const householdIncome = householdOperatingCashFlowRows(nonSupersededIncome);
  // Expenses: SMSF audit/accounting/administration/property costs are fund
  // operating costs, never household consumption (spec §4, §13).
  const householdExpenses = householdOperatingCashFlowRows(nonSupersededExpenses);
  // Liabilities: only monthly_repayment (and, via householdLiabilityBalance
  // below, the DTI-basis balance total) leaves Net Worth here — an SMSF
  // liability's balance itself stays in totalLiabilities/liabilityByType,
  // which deliberately read the UNFILTERED input.liabilities instead of this
  // array (spec §12, §29; LR-FI-1 §5/§28). The LR independent audit's P0-1
  // fix (2026-09-14) briefly pointed totalLiabilities/liabilityByType at
  // this same filtered array too; the LR-FI Financial-Integrity Recovery
  // (2026-09-17) reverted that — see totalLiabilities' own doc comment on
  // DashboardSummary for the full mechanism, the live scenario P0-1 was
  // fixing, and why that fix was too broad.
  const householdLiabilities = householdOperatingCashFlowRows(input.liabilities);

  // ---------------------------------------------------------------------------
  // CASH FLOW (WP-03). One set of figures, from EITHER the canonical read
  // models (the Dashboard loader always passes them) OR, for a caller that has
  // none, the registers alone. There is no third path: the LR-3 current-
  // calendar-month bank arrays that were added blindly on top of the plan are
  // gone (DC-01, DC-02, DC-03, EXP-G3).
  // ---------------------------------------------------------------------------
  type Unavailable = { section: string; reason: string; source: string };
  interface CashFlowFigures {
    incomeAvailable: boolean;
    expensesAvailable: boolean;
    debtAvailable: boolean;
    grossMonthlyIncome: number;
    netMonthlyIncome: number;
    netUnknownComponents: number;
    grossIncludesNetFloor: boolean;
    passiveMonthlyIncome: number;
    dividendMonthlyIncome: number;
    rentalMonthlyIncome: number;
    incomeLines: CanonicalIncomeLine[];
    essentialMonthlyExpenses: number;
    coreSurvivalMonthlyExpenses: number;
    lifestyleMonthlyExpenses: number;
    totalMonthlyExpenses: number;
    expenseLines: CanonicalExpenseLine[];
    debtMonthlyRepayments: number;
    costOfDebtMonthly: number;
    bankMonthlyIncome: number;
    bankMonthlyExpenses: number;
    hasIncome: boolean;
    hasExpenses: boolean;
    unavailable: Unavailable[];
    possibleDuplicateIncomeCount: number;
    unknownPendingCount: number;
  }
  const isPassive = (key: string | null | undefined) => Boolean(key && PASSIVE_INCOME_KEYS.has(key));
  const sumBy = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
  const addUnconvertedAmount = (code: string, amount: number) => {
    unconverted.count += 1;
    unconverted.byCurrency[code] = (unconverted.byCurrency[code] ?? 0) + amount;
  };

  // Registers-only: manual / Applied rows, no imported actuals.
  function registerCashFlow(): CashFlowFigures {
    const income = householdIncome.flatMap((r) => {
      const gross = convertOrNull(r.currency_code, toMonthly(Number(r.amount), r.frequency));
      if (gross === null) {
        addUnconvertedAmount(String(r.currency_code), Number(r.amount));
        return [];
      }
      // GAP-09: a missing net is UNKNOWN. It is never replaced by the gross.
      const net = r.net_amount === null || r.net_amount === undefined ? null : reportingValue(r.currency_code, toMonthly(Number(r.net_amount), r.frequency));
      return [{ r, gross, net }];
    });
    const incomeLines: CanonicalIncomeLine[] = income.map(({ r, gross }) => ({
      name: r.source_name ?? r.employer_name ?? 'Income source',
      monthly: gross,
      employerName: r.employer_name ?? null,
      masterItemKey: r.master_item_key,
      source: 'planned',
    }));
    // App Review spec §12-13 / LR-FI-2 §R2: a debt-repayment expense row whose
    // liability repayment is already counted is excluded (see
    // debtServiceContext.ts); built from HOUSEHOLD liabilities only (LR-FI-1).
    const servicedFamilies = servicedDebtFamilies(householdLiabilities);
    const expenses = householdExpenses
      .filter((r) => !isDuplicateDebtServiceExpense(r, servicedFamilies))
      .flatMap((r) => {
        const monthly = convertOrNull(r.currency_code, toMonthly(Number(r.amount), r.frequency));
        if (monthly === null) {
          addUnconvertedAmount(String(r.currency_code), Number(r.amount));
          return [];
        }
        return [{ r, monthly }];
      });
    const consumptionCounted = householdExpenses.some((r) => !isDuplicateDebtServiceExpense(r, servicedFamilies));
    const essential = sumBy(expenses.filter((e) => e.r.is_essential), (e) => e.monthly);
    const lifestyle = sumBy(expenses.filter((e) => !e.r.is_essential), (e) => e.monthly);
    return {
      incomeAvailable: true,
      expensesAvailable: true,
      debtAvailable: true,
      grossMonthlyIncome: sumBy(income, (i) => i.gross),
      netMonthlyIncome: sumBy(income, (i) => i.net ?? 0),
      netUnknownComponents: income.filter((i) => i.net === null).length,
      grossIncludesNetFloor: false,
      passiveMonthlyIncome: sumBy(income.filter((i) => isPassive(i.r.master_item_key)), (i) => i.gross),
      dividendMonthlyIncome: sumBy(income.filter((i) => i.r.master_item_key === 'dividend_income'), (i) => i.gross),
      rentalMonthlyIncome: sumBy(income.filter((i) => i.r.master_item_key === 'rental_income' || i.r.master_item_key === 'airbnb_income'), (i) => i.gross),
      incomeLines,
      essentialMonthlyExpenses: essential,
      coreSurvivalMonthlyExpenses: sumBy(
        expenses.filter((e) => e.r.is_essential && e.r.master_item_key && CORE_SURVIVAL_EXPENSE_KEYS.has(e.r.master_item_key)),
        (e) => e.monthly
      ),
      lifestyleMonthlyExpenses: lifestyle,
      totalMonthlyExpenses: essential + lifestyle,
      expenseLines: expenses.map((e) => ({ name: e.r.expense_name, monthly: e.monthly, source: 'planned' })),
      // PO D-08, applied equally to manual and imported households: when the
      // household's consumption is counted as expense, a revolving facility's
      // repayment is not debt service on top of the purchases its balance is
      // built from. With NO counted consumption the premise does not hold and
      // the repayment is the only record of that outflow, so it stays (same
      // rule as the read model's householdDebtServiceUnderD08). LR-FI-1
      // §12/§22: household liabilities only.
      debtMonthlyRepayments: sumBy(
        householdLiabilities.filter((l) => !consumptionCounted || debtServiceClassFor(l.debt_type, l.master_item_key) !== 'revolving'),
        (l) => reportingValue(l.currency_code, l.monthly_repayment ?? 0)
      ),
      costOfDebtMonthly: 0,
      bankMonthlyIncome: 0,
      bankMonthlyExpenses: 0,
      // LR-FI-1: household scope, matching the figures they gate.
      hasIncome: householdIncome.length > 0,
      hasExpenses: householdExpenses.length > 0,
      unavailable: [],
      possibleDuplicateIncomeCount: 0,
      unknownPendingCount: 0,
    };
  }

  // Canonical: the read models' figures, taken as they are.
  function canonicalCashFlow(c: CanonicalCashFlowInput): CashFlowFigures {
    const unavailable: Unavailable[] = [];
    const inc = c.income.status === 'ok' ? c.income : (unavailable.push({ section: 'income', reason: c.income.reason, source: c.income.source }), null);
    const exp = c.expenses.status === 'ok' ? c.expenses : (unavailable.push({ section: 'expenses', reason: c.expenses.reason, source: c.expenses.source }), null);
    const debt = c.debtService.status === 'ok' ? c.debtService : (unavailable.push({ section: 'liabilities', reason: c.debtService.reason, source: c.debtService.source }), null);
    unavailable.push(...c.otherUnavailable);
    const plannedIncome = inc ? inc.lines.filter((l) => l.source === 'planned') : [];
    return {
      incomeAvailable: inc !== null,
      expensesAvailable: exp !== null,
      debtAvailable: debt !== null,
      grossMonthlyIncome: inc?.grossMonthly ?? 0,
      netMonthlyIncome: inc?.netKnownMonthly ?? 0,
      netUnknownComponents: inc?.netUnknownComponents ?? 0,
      grossIncludesNetFloor: inc?.grossIncludesNetFloor ?? false,
      // Imported bank credits carry no master item to classify them by, so
      // they count as active income (the documented pre-programme default).
      passiveMonthlyIncome: sumBy(plannedIncome.filter((l) => isPassive(l.masterItemKey)), (l) => l.monthly),
      dividendMonthlyIncome: sumBy(plannedIncome.filter((l) => l.masterItemKey === 'dividend_income'), (l) => l.monthly),
      rentalMonthlyIncome: sumBy(plannedIncome.filter((l) => l.masterItemKey === 'rental_income' || l.masterItemKey === 'airbnb_income'), (l) => l.monthly),
      incomeLines: inc?.lines ?? [],
      essentialMonthlyExpenses: exp?.essentialMonthly ?? 0,
      coreSurvivalMonthlyExpenses: exp?.coreSurvivalMonthly ?? 0,
      lifestyleMonthlyExpenses: exp?.lifestyleMonthly ?? 0,
      totalMonthlyExpenses: exp?.monthly ?? 0,
      expenseLines: exp?.lines ?? [],
      debtMonthlyRepayments: debt?.householdMonthly ?? 0,
      costOfDebtMonthly: debt?.costOfDebtMonthly ?? 0,
      bankMonthlyIncome: inc?.importedMonthly ?? 0,
      bankMonthlyExpenses: exp?.importedMonthly ?? 0,
      // DC-05 / EXP-G6: planned OR actual. An unavailable section is not "has
      // data" -- every engine then reports it missing instead of scoring $0.
      hasIncome: inc?.present ?? false,
      hasExpenses: exp?.present ?? false,
      unavailable,
      possibleDuplicateIncomeCount: inc?.possibleDuplicateCount ?? 0,
      unknownPendingCount: exp?.unknownPendingCount ?? 0,
    };
  }

  const cf = input.canonical ? canonicalCashFlow(input.canonical) : registerCashFlow();
  if (input.canonical) {
    for (const part of [input.canonical.income, input.canonical.expenses]) {
      if (part.status !== 'ok') continue;
      for (const [code, amount] of Object.entries(part.unconverted.byCurrency)) {
        unconverted.byCurrency[code] = (unconverted.byCurrency[code] ?? 0) + amount;
      }
      unconverted.count += part.unconverted.count;
    }
  }
  const {
    grossMonthlyIncome,
    netMonthlyIncome,
    passiveMonthlyIncome,
    essentialMonthlyExpenses,
    coreSurvivalMonthlyExpenses,
    lifestyleMonthlyExpenses,
    totalMonthlyExpenses,
    debtMonthlyRepayments,
    bankMonthlyIncome,
    bankMonthlyExpenses,
  } = cf;
  const activeMonthlyIncome = grossMonthlyIncome - passiveMonthlyIncome;
  // LR-FI-2 §6c. All-owner CONTRACTUAL repayment total — the wealth-side
  // counterpart to debtMonthlyRepayments, paired with the ALSO all-owner
  // totalLiabilities below so forecastData.ts's/whatIf.ts's amortisation
  // wiring always amortises a whole balance with a whole repayment. It is not
  // cash flow, so the D-08/D-09 debt-service rules (which govern surplus) do
  // not apply to it.
  const totalLiabilityMonthlyRepayments = input.liabilities.reduce(
    (sum, r) => sum + reportingValue(r.currency_code, r.monthly_repayment ?? 0),
    0
  );

  // The household-level surplus basis is unchanged (net when any net is
  // known, gross otherwise). What changed (GAP-09) is that a component whose
  // net is unknown no longer contributes its GROSS as if it were net.
  const incomeForSurplus = netMonthlyIncome || grossMonthlyIncome;
  const netIncomeBasis: DashboardDataStatus['netIncomeBasis'] = !cf.incomeAvailable || incomeForSurplus === 0
    ? 'none'
    : netMonthlyIncome === 0
      ? 'gross_fallback'
      : cf.netUnknownComponents > 0
        ? 'net_partial'
        : 'net';
  // A surplus needs all three inputs. With any of them unreadable the figure
  // below is still returned (it is a number in the contract), but every RATIO
  // built on it is null, so nothing downstream scores it (DC-14).
  const cashFlowComplete = cf.incomeAvailable && cf.expensesAvailable && cf.debtAvailable;
  const monthlySurplus = incomeForSurplus - totalMonthlyExpenses - debtMonthlyRepayments;
  const savingsRate = cashFlowComplete && incomeForSurplus > 0 ? monthlySurplus / incomeForSurplus : null;
  const operatingCashFlow = incomeForSurplus - essentialMonthlyExpenses;
  const disposableIncome = operatingCashFlow - debtMonthlyRepayments;
  const totalOutflow = totalMonthlyExpenses + debtMonthlyRepayments;
  const cashFlowRatio = cashFlowComplete && totalOutflow > 0 ? monthlySurplus / totalOutflow : null;
  // LR-FI-1 / LR-FI-2 §R2: household rows only, and never a row the totals
  // exclude (a debt-service duplicate), so the list reconciles with the total.
  const topExpenses = cf.expenseLines
    .map((e) => ({ name: e.name, monthlyAmount: e.monthly }))
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
    .slice(0, 5);
  const topIncome = cf.incomeLines
    .map((r) => ({ name: r.name, monthlyAmount: r.monthly }))
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
    .slice(0, 5);
  // Variable pay is part of its payslip's income source, not a source of its own.
  const incomeSourceLines = cf.incomeLines.filter((r) => r.source !== 'variable_pay');
  const incomeSourceCount = input.canonical ? incomeSourceLines.length : householdIncome.length;
  const incomeMonthlyAmounts = incomeSourceLines.map((r) => r.monthly);
  const largestIncomeSharePct =
    grossMonthlyIncome > 0 && incomeMonthlyAmounts.length > 0
      ? Math.max(...incomeMonthlyAmounts) / grossMonthlyIncome
      : null;
  const discretionaryRatio = cf.incomeAvailable && cf.expensesAvailable && incomeForSurplus > 0 ? lifestyleMonthlyExpenses / incomeForSurplus : null;

  const employerMap = new Map<string, number>();
  for (const r of incomeSourceLines) {
    if (!r.employerName || isPassive(r.masterItemKey)) continue;
    employerMap.set(r.employerName, (employerMap.get(r.employerName) ?? 0) + r.monthly);
  }
  const activeIncomeTotal = Array.from(employerMap.values()).reduce((sum, v) => sum + v, 0);
  const employerConcentration =
    employerMap.size > 0 && activeIncomeTotal > 0
      ? Array.from(employerMap.values()).reduce((sum, v) => sum + (v / activeIncomeTotal) ** 2, 0)
      : null;

  // LR-11 (Company / Family Trust Entity Architecture, WP-05). Computed via
  // the dedicated isolated engine — see businessEntityValuation.ts's own
  // header for why the entity-specific arithmetic lives there rather than
  // here. Added into totalAssetsCombined AND netWorth below (both derived
  // from the same expanded formula) so totalAssetsCombined's own documented
  // contract ("the figure to show as total assets anywhere net worth is
  // also shown, so the two reconcile") keeps holding for a household with
  // business entities, not just one without any.
  const businessEntityOwnershipValue = computeBusinessEntityOwnershipValue(input.businessEntities ?? [], currency, fxRateAudInr);

  const totalAssets = input.assets.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0);
  const totalInvestments = input.investments.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0);
  const totalRetirement = input.retirement.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_balance), 0);
  // LR-FI-1 §5/§28 (restored — see the LR-FI Financial-Integrity Recovery,
  // 2026-09-17). All-owner, unfiltered: a liability's balance stays in Net
  // Worth regardless of the row's owner, including owner=SMSF_OWNER and
  // including a liability whose EFFECTIVE owner was forced to SMSF_OWNER by
  // applySmsfPropertyLoanLinkOverride() (LR-12R) — that override's own
  // certified contract (tests/unit/lr12rSmsfPropertyLoanLinkOverride.test.ts)
  // is that it changes DTI/DSR ONLY and leaves totalLiabilities whole.
  //
  // The P0-1 hotfix (2026-09-14, commit ea95507) pointed this field at
  // householdLiabilities (the SAME owner-filtered array debtMonthlyRepayments
  // uses) to stop an SMSF fund's own linked property loan being subtracted
  // twice — once inside the fund's already-netted valuation
  // (smsf_compute_detailed_net_value(), migration 0084, reaching
  // totalRetirement) and again here. That live scenario is real, but the
  // fix as shipped was too broad: it excluded EVERY SMSF-context liability
  // from totalLiabilities, not only ones whose balance is genuinely already
  // netted elsewhere in this same computation — silently deleting the
  // balance of a plain owner=SMSF_OWNER-tagged liability (or an LR-12R-linked
  // one) with no netted fund valuation anywhere in the input, i.e. a
  // liability that must count in Net Worth exactly once but was being
  // counted zero times. That is the $365,000 LR-FI-1/LR-FI-2/LR-12R
  // regression this restores. computeDashboard() has no per-loan/per-fund
  // key to tell "already netted inside totalRetirement" apart from "not
  // netted anywhere" — fixing the original double-subtraction correctly
  // needs that correlation (or a gross, not netted, fund valuation) and is
  // out of scope for this recovery; it is flagged back to the PO rather
  // than silently re-broken or silently left broken.
  const totalLiabilities = input.liabilities.reduce((sum, r) => sum + reportingValue(r.currency_code, r.balance), 0);
  // LR-FI-2 §1 — the household-context balance total, still deliberately
  // owner-filtered (unlike totalLiabilities above) — this is the DTI/DSR
  // basis, where an SMSF liability (plain-tagged or LR-12R-linked) must be
  // excluded from the user's PERSONAL debt ratios even though its balance
  // stays in totalLiabilities/Net Worth.
  const householdLiabilityBalance = householdLiabilities.reduce((sum, r) => sum + reportingValue(r.currency_code, r.balance), 0);
  const netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities + businessEntityOwnershipValue;

  const allocationMap = new Map<AllocationBucket, number>();
  const addAlloc = (bucket: AllocationBucket, value: number) =>
    allocationMap.set(bucket, (allocationMap.get(bucket) ?? 0) + value);
  for (const a of input.assets) addAlloc(bucketAssetClass(a.asset_class, a.master_item_key), reportingValue(a.currency_code, a.current_value));
  for (const i of input.investments) addAlloc(bucketInvestmentType(i.investment_type, i.master_item_key), reportingValue(i.currency_code, i.current_value));
  if (totalRetirement > 0) addAlloc('super', totalRetirement);
  const netWorthAllocation: AllocationSlice[] = Array.from(allocationMap.entries()).map(([bucket, value]) => ({
    bucket,
    value,
  }));

  // Sourced from the unfiltered input.liabilities — the same all-owner basis
  // as totalLiabilities above, so reportSections.ts's Net Worth section's
  // "the two reconcile" contract holds for every household, including one
  // with SMSF-context liabilities (LR-FI-1 §28).
  const liabilityTypeMap = new Map<string, number>();
  for (const l of input.liabilities) {
    const key = l.master_item_key ?? l.debt_type;
    // WP-03 (DC-12): reporting currency, like the totalLiabilities it breaks down.
    liabilityTypeMap.set(key, (liabilityTypeMap.get(key) ?? 0) + reportingValue(l.currency_code, l.balance));
  }
  const liabilityByType = Array.from(liabilityTypeMap.entries()).map(([debtType, balance]) => ({ debtType, balance }));

  // Cross-border rollups — reuses the country_code already recorded on each
  // register row rather than introducing a new classification.
  function byCountry<T>(rows: T[], valueField: keyof T, countryField: keyof T): { countryCode: string; value: number }[] {
    const map = new Map<string, number>();
    for (const r of rows) {
      const code = r[countryField] as unknown as string | null | undefined;
      if (!code) continue;
      map.set(code, (map.get(code) ?? 0) + Number(r[valueField]));
    }
    return Array.from(map.entries()).map(([countryCode, value]) => ({ countryCode, value }));
  }
  const assetsByCountry = byCountry(input.assets, 'current_value', 'country_code');
  const liabilitiesByCountry = byCountry(input.liabilities, 'balance', 'country_code');
  const retirementByCountry = byCountry(input.retirement, 'current_balance', 'country_code');

  // G6 Contract 5 — same per-country grouping as byCountry() above, but each
  // row passes through reportingValue() (currency conversion) before being
  // summed, so rows recorded in different currencies within the same country
  // bucket combine correctly. Unlike byCountry(), this needs the row's own
  // currency_code, so it groups from the raw input rows directly rather than
  // reusing byCountry()'s already-summed (and therefore currency-erased)
  // output.
  function byCountryConverted<T extends { currency_code?: string | null }>(
    rows: T[],
    valueField: keyof T,
    countryField: keyof T
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const r of rows) {
      const code = r[countryField] as unknown as string | null | undefined;
      if (!code) continue;
      map.set(code, (map.get(code) ?? 0) + reportingValue(r.currency_code, Number(r[valueField])));
    }
    return map;
  }
  const assetsByCountryConverted = byCountryConverted(input.assets, 'current_value', 'country_code');
  const liabilitiesByCountryConverted = byCountryConverted(input.liabilities, 'balance', 'country_code');
  const retirementByCountryConverted = byCountryConverted(input.retirement, 'current_balance', 'country_code');
  const netWorthByCountryCodes = new Set([
    ...assetsByCountryConverted.keys(),
    ...liabilitiesByCountryConverted.keys(),
    ...retirementByCountryConverted.keys(),
  ]);
  const netWorthByCountryConverted = Array.from(netWorthByCountryCodes).map((countryCode) => ({
    countryCode,
    value:
      (assetsByCountryConverted.get(countryCode) ?? 0) +
      (retirementByCountryConverted.get(countryCode) ?? 0) -
      (liabilitiesByCountryConverted.get(countryCode) ?? 0),
  }));

  const liquidAssets = allocationMap.get('cash') ?? 0;
  const emergencyFundMonths = essentialMonthlyExpenses > 0 ? liquidAssets / essentialMonthlyExpenses : null;
  const totalAssetBaseForRatios = totalAssets + totalInvestments + totalRetirement;
  const liquidAssetRatio = totalAssetBaseForRatios > 0 ? liquidAssets / totalAssetBaseForRatios : null;
  const propertyConcentration =
    totalAssetBaseForRatios > 0 ? (allocationMap.get('property') ?? 0) / totalAssetBaseForRatios : null;

  // WP-03 (DC-12): every balance-weighted debt figure below weighs by the
  // REPORTING-currency balance, so an INR loan is not weighted 56x an AUD one.
  const bal = (r: LiabilityRow) => reportingValue(r.currency_code, r.balance);
  const liabilitiesWithRate = input.liabilities.filter((r) => r.interest_rate !== null);
  const balanceWithRate = liabilitiesWithRate.reduce((sum, r) => sum + bal(r), 0);
  const totalInterestWeighted = liabilitiesWithRate.reduce((sum, r) => sum + r.interest_rate! * bal(r), 0);
  const averageInterestRate = balanceWithRate > 0 ? totalInterestWeighted / balanceWithRate : null;
  const annualGrossIncome = cf.incomeAvailable ? grossMonthlyIncome * 12 : 0;
  // LR-FI-2 §1 — Old calculation -> defect -> corrected rule -> expected new
  // result.
  //   Old: totalLiabilities / annualGrossIncome. LR-FI-1 made the DENOMINATOR
  //   household-only (grossMonthlyIncome excludes SMSF income) but left the
  //   NUMERATOR whole, so this ratio read
  //     (personal debt + SMSF debt) / (personal income only)
  //   — a figure spanning two economic entities on top and one underneath.
  //   Defect: no definition of debt-to-income holds that shape. It must be
  //   either both-entities/both-entities or personal/personal, and LR-FI-1
  //   already certified the denominator as personal-only. LR-FI-1 therefore
  //   made DTI actively WORSE for SMSF households rather than merely leaving
  //   it unimproved: the denominator shrank while the numerator did not, so
  //   an SMSF household now reported a HIGHER debt-to-income than before that
  //   P0 fix. The economics agree with the arithmetic — an SMSF borrowing
  //   arrangement is limited-recourse against the fund's asset, not personal
  //   household debt. The Product Owner's ruling anticipated the exception (a
  //   personally guaranteed obligation) and required it be EXPLICIT, never
  //   inferred from shared ownership, so no inference mechanism is added here.
  //   Corrected rule: divide the household-context balance by the
  //   household-context income — the same discriminator, applied to both
  //   sides of one expression.
  //   Expected new result: personal 400,000 + SMSF 365,000 over 192,000 gross
  //   went from 3.98x ("caution") to 2.08x ("good") — a real benchmark-band
  //   flip, not a rounding change. $0 change for any household with no SMSF
  //   rows, where householdLiabilityBalance === totalLiabilities.
  // The GROSS basis is deliberately retained: DTI-on-gross is its own
  // standing Product Owner decision and is not to be conflated with the
  // separate, also-deliberate net basis of debtServiceRatio below.
  // Net Worth, totalLiabilities, goodDebt/badDebt, liabilityByType,
  // averageInterestRate, variableRateDebtRatio, creditUtilization and
  // liabilitiesWithPayoff all deliberately keep reading the WHOLE register —
  // they are wealth and debt-composition figures governed by LR-FI-1 §28.
  const debtToIncome = annualGrossIncome > 0 ? householdLiabilityBalance / annualGrossIncome : null;
  // Net income, not gross — matches the report spec's own definition
  // ("percentage of net monthly income required to meet scheduled debt
  // repayments") and every other ratio in this file that already divides by
  // incomeForSurplus. Previously divided by gross income, which silently
  // disagreed with the report copy's stated definition.
  // WP-03: null (never 0) when income or debt service could not be read, so a
  // failed read can never score as "no debt burden" (DC-14).
  const debtServiceRatio = cf.incomeAvailable && cf.debtAvailable && incomeForSurplus > 0 ? debtMonthlyRepayments / incomeForSurplus : null;
  const liabilitiesWithPayoff = input.liabilities.map((l) => ({
    debtType: l.master_item_key ?? l.debt_type,
    balance: bal(l),
    // Payoff months are a ratio of the row's own balance and repayment, in its own currency.
    monthsToPayoff: estimateMonthsToPayoff(l.balance, l.interest_rate, l.monthly_repayment),
  }));
  let goodDebt = 0;
  let badDebt = 0;
  for (const l of input.liabilities) {
    if (isGoodDebt(l.debt_type, l.master_item_key)) goodDebt += bal(l);
    else badDebt += bal(l);
  }

  const liabilitiesWithRateType = input.liabilities.filter((l) => (l.interest_rate_type ?? null) !== null);
  const rateTypeBalance = liabilitiesWithRateType.reduce((sum, l) => sum + bal(l), 0);
  const variableRateDebtBalance = liabilitiesWithRateType
    .filter((l) => l.interest_rate_type === 'variable')
    .reduce((sum, l) => sum + bal(l), 0);
  const variableRateDebtRatio = rateTypeBalance > 0 ? variableRateDebtBalance / rateTypeBalance : null;
  const in12Months = new Date();
  in12Months.setMonth(in12Months.getMonth() + 12);
  const in12MonthsStr = in12Months.toISOString().slice(0, 10);
  const upcomingRateResetBalance12m = input.liabilities
    .filter((l) => l.fixed_rate_expiry && l.fixed_rate_expiry <= in12MonthsStr)
    .reduce((sum, l) => sum + bal(l), 0);
  const creditCardLiabilities = input.liabilities.filter(
    (l) => isCreditCardDebt(l.debt_type, l.master_item_key) && (l.credit_limit ?? null) !== null
  );
  const totalCreditLimit = creditCardLiabilities.reduce((sum, l) => sum + reportingValue(l.currency_code, l.credit_limit ?? 0), 0);
  const creditUtilization =
    totalCreditLimit > 0
      ? creditCardLiabilities.reduce((sum, l) => sum + bal(l), 0) / totalCreditLimit
      : null;

  // WP-03 (DC-12): same currency as totalInvestments, which it is subtracted from.
  const investmentCostBase = input.investments.reduce((sum, r) => sum + reportingValue(r.currency_code, r.cost_base ?? r.current_value), 0);
  const investmentUnrealisedGain = totalInvestments - investmentCostBase;

  let investmentDiversificationScore: number | null = null;
  if (input.investments.length > 0 && totalInvestments > 0) {
    const byType = new Map<string, number>();
    for (const i of input.investments) {
      const key = i.master_item_key ?? i.investment_type;
      byType.set(key, (byType.get(key) ?? 0) + reportingValue(i.currency_code, i.current_value));
    }
    const hhi = Array.from(byType.values()).reduce((sum, v) => sum + (v / totalInvestments) ** 2, 0);
    investmentDiversificationScore = Math.round((1 - hhi) * 100);
  }

  const countryMap = new Map<string, number>();
  for (const i of input.investments) {
    if (!i.country_code) continue;
    // Deliberately NOT converted (DD-009 / CUR-002, iiR3NetWorthCertification):
    // like assetsByCountry, a per-country view shows each holding as recorded,
    // in its own currency. netWorthByCountryConverted is the converted view.
    countryMap.set(i.country_code, (countryMap.get(i.country_code) ?? 0) + i.current_value);
  }
  const investmentByCountry = Array.from(countryMap.entries()).map(([countryCode, value]) => ({ countryCode, value }));
  const countriesInUse = Array.from(
    new Set([
      ...assetsByCountry.map((a) => a.countryCode),
      ...liabilitiesByCountry.map((l) => l.countryCode),
      ...retirementByCountry.map((r) => r.countryCode),
      ...investmentByCountry.map((i) => i.countryCode),
    ])
  );

  const institutionMap = new Map<string, number>();
  for (const i of input.investments) {
    if (!i.institution) continue;
    institutionMap.set(i.institution, (institutionMap.get(i.institution) ?? 0) + reportingValue(i.currency_code, i.current_value));
  }
  const institutionConcentration =
    institutionMap.size > 0 && totalInvestments > 0
      ? Array.from(institutionMap.values()).reduce((sum, v) => sum + (v / totalInvestments) ** 2, 0)
      : null;

  // LR-FI-1 §14: SMSF dividends and SMSF property rent are fund income, not
  // household income — they must not appear as personal passive income.
  // (Computed with the cash-flow figures above, from household rows only.)
  const { dividendMonthlyIncome, rentalMonthlyIncome } = cf;
  const dividendYield = totalInvestments > 0 ? (dividendMonthlyIncome * 12) / totalInvestments : null;

  // WP-03 (GAP-RET-02 consumer, DC-12). A contribution is a monthly RATE only
  // when its frequency is known: a NULL contribution_frequency is unknown and
  // is left out (and counted in dataStatus), never assumed to be monthly -- a
  // retirement statement's period total read as "monthly" inflated it ~12x.
  // Converted to the reporting currency like the balances.
  let retirementContributionFrequencyUnknown = 0;
  const contributionMonthly = (r: RetirementRow, amount: number | null) => {
    if (amount === null || amount === undefined || Number(amount) === 0) return 0;
    if (!r.contribution_frequency) {
      retirementContributionFrequencyUnknown += 1;
      return 0;
    }
    return reportingValue(r.currency_code, toMonthly(Number(amount), r.contribution_frequency));
  };
  const retirementEmployerMonthlyContribution = input.retirement.reduce((sum, r) => sum + contributionMonthly(r, r.employer_contribution), 0);
  const retirementPersonalMonthlyContribution = input.retirement.reduce((sum, r) => sum + contributionMonthly(r, r.personal_contribution), 0);
  const investmentAnnualContribution = input.investments.reduce((sum, r) => sum + reportingValue(r.currency_code, r.annual_contribution ?? 0), 0);
  const ratesAvailable = cf.incomeAvailable && incomeForSurplus > 0;
  const investmentContributionRate = ratesAvailable ? investmentAnnualContribution / 12 / incomeForSurplus : null;
  const retirementContributionRate = ratesAvailable
    ? (retirementEmployerMonthlyContribution + retirementPersonalMonthlyContribution) / incomeForSurplus
    : null;
  const retirementEmployerContributionRate = ratesAvailable ? retirementEmployerMonthlyContribution / incomeForSurplus : null;

  // LR-FI-1 §15: an SMSF-paid premium is a fund operating cost and must not
  // read as household spending — but the POLICY's cover_amount is protection,
  // not cash flow, and SMSF-held life/TPD cover genuinely protects the
  // household. So the row still contributes its cover (feeding
  // computeInsuranceAdequacy, the Health Score's and Resilience's Insurance &
  // Protection components) while contributing $0 of premium. This asymmetry
  // is the direct application of §4 (operating cash flow only) and §28 (no
  // balance-sheet/protection change), not an oversight.
  const insuranceTypeMap = new Map<string, { coverAmount: number; annualPremium: number }>();
  for (const i of input.insurance) {
    const entry = insuranceTypeMap.get(i.cover_type) ?? { coverAmount: 0, annualPremium: 0 };
    // WP-03 (DC-12): cover and premium in the reporting currency.
    entry.coverAmount += reportingValue(i.currency_code, i.cover_amount);
    if (isHouseholdOperatingCashFlow(i)) entry.annualPremium += reportingValue(i.currency_code, toMonthly(i.premium, i.premium_frequency) * 12);
    insuranceTypeMap.set(i.cover_type, entry);
  }
  const insuranceByType = Array.from(insuranceTypeMap.entries()).map(([coverType, v]) => ({
    coverType,
    coverAmount: v.coverAmount,
    annualPremium: v.annualPremium,
  }));
  const totalAnnualPremium = insuranceByType.reduce((sum, i) => sum + i.annualPremium, 0);
  const today = new Date().toISOString().slice(0, 10);
  const upcomingRenewals = input.insurance
    .filter((i): i is InsuranceRow & { renewal_date: string } => Boolean(i.renewal_date) && i.renewal_date! >= today)
    .sort((a, b) => a.renewal_date!.localeCompare(b.renewal_date!))
    .slice(0, 5)
    .map((i) => ({ policyName: i.policy_name, renewalDate: i.renewal_date! }));
  const incomeProtectionWaitingPeriods = input.insurance
    .filter((i) => i.cover_type === 'income_protection' && (i.waiting_period_days ?? null) !== null)
    .map((i) => i.waiting_period_days as number);
  const incomeProtectionWaitingPeriodDays =
    incomeProtectionWaitingPeriods.length > 0 ? Math.max(...incomeProtectionWaitingPeriods) : null;

  const netWorthRatio = totalAssetBaseForRatios > 0 ? netWorth / totalAssetBaseForRatios : null;
  const liquidityRatio = totalMonthlyExpenses > 0 ? liquidAssets / totalMonthlyExpenses : null;
  const investmentRatio =
    totalAssetBaseForRatios > 0 ? (totalInvestments + totalRetirement) / totalAssetBaseForRatios : null;
  const passiveIncomeRatio = grossMonthlyIncome > 0 ? passiveMonthlyIncome / grossMonthlyIncome : null;
  const financialIndependenceRatio = totalMonthlyExpenses > 0 ? passiveMonthlyIncome / totalMonthlyExpenses : null;

  const ratios: RatioResult[] = [
    ratio(
      'savings_rate',
      'Savings Rate',
      savingsRate,
      'percent',
      '>20%',
      savingsRate === null ? 'neutral' : savingsRate >= 0.2 ? 'good' : savingsRate >= 0.1 ? 'caution' : 'risk'
    ),
    ratio(
      'expense_ratio',
      'Expense Ratio',
      incomeForSurplus > 0 ? totalMonthlyExpenses / incomeForSurplus : null,
      'percent',
      '<80%',
      incomeForSurplus === 0
        ? 'neutral'
        : totalMonthlyExpenses / incomeForSurplus < 0.8
          ? 'good'
          : totalMonthlyExpenses / incomeForSurplus < 1
            ? 'caution'
            : 'risk'
    ),
    ratio(
      'debt_to_income',
      'Debt-to-Income',
      debtToIncome,
      'multiple',
      '<3x',
      debtToIncome === null ? 'neutral' : debtToIncome < 3 ? 'good' : debtToIncome < 5 ? 'caution' : 'risk'
    ),
    ratio(
      'debt_service_ratio',
      'Debt Service Ratio',
      debtServiceRatio,
      'percent',
      '<35%',
      debtServiceRatio === null ? 'neutral' : debtServiceRatio < 0.35 ? 'good' : debtServiceRatio < 0.5 ? 'caution' : 'risk'
    ),
    ratio(
      'net_worth_ratio',
      'Net Worth Ratio',
      netWorthRatio,
      'percent',
      '>60%',
      netWorthRatio === null ? 'neutral' : netWorthRatio >= 0.6 ? 'good' : netWorthRatio >= 0.3 ? 'caution' : 'risk'
    ),
    ratio(
      'liquidity_ratio',
      'Liquidity Ratio',
      liquidityRatio,
      'months',
      '>6 months',
      liquidityRatio === null ? 'neutral' : liquidityRatio >= 6 ? 'good' : liquidityRatio >= 3 ? 'caution' : 'risk'
    ),
    ratio('investment_ratio', 'Investment Ratio', investmentRatio, 'percent', 'Varies by age', 'neutral'),
    ratio(
      'emergency_fund_ratio',
      'Emergency Fund Ratio',
      emergencyFundMonths,
      'months',
      '6-12 months',
      emergencyFundMonths === null
        ? 'neutral'
        : emergencyFundMonths >= 6
          ? 'good'
          : emergencyFundMonths >= 3
            ? 'caution'
            : 'risk'
    ),
    ratio(
      'passive_income_ratio',
      'Passive Income Ratio',
      passiveIncomeRatio,
      'percent',
      '>20%',
      passiveIncomeRatio === null ? 'neutral' : passiveIncomeRatio >= 0.2 ? 'good' : passiveIncomeRatio >= 0.1 ? 'caution' : 'risk'
    ),
    ratio(
      'financial_independence_ratio',
      'Financial Independence Ratio',
      financialIndependenceRatio,
      'percent',
      '100%',
      financialIndependenceRatio === null
        ? 'neutral'
        : financialIndependenceRatio >= 1
          ? 'good'
          : financialIndependenceRatio >= 0.5
            ? 'caution'
            : 'risk'
    ),
  ];

  return {
    currency,
    grossMonthlyIncome,
    netMonthlyIncome,
    passiveMonthlyIncome,
    activeMonthlyIncome,
    essentialMonthlyExpenses,
    coreSurvivalMonthlyExpenses,
    lifestyleMonthlyExpenses,
    debtMonthlyRepayments,
    totalLiabilityMonthlyRepayments,
    totalMonthlyExpenses,
    bankMonthlyExpenses,
    bankMonthlyIncome,
    monthlySurplus,
    savingsRate,
    operatingCashFlow,
    disposableIncome,
    cashFlowRatio,
    topExpenses,
    topIncome,
    incomeSourceCount,
    largestIncomeSharePct,
    discretionaryRatio,
    employerConcentration,
    hasInvestments: input.investments.length > 0,
    hasRetirement: input.retirement.length > 0,
    hasInsurance: input.insurance.length > 0,
    totalAssets,
    // LR-11: includes businessEntityOwnershipValue (also exposed separately
    // below) so this field's own documented contract — "the figure to show
    // as total assets anywhere net worth is also shown, so the two
    // reconcile" — keeps holding: totalAssetsCombined - totalLiabilities ===
    // netWorth for every household, business entities or not.
    totalAssetsCombined: totalAssetBaseForRatios + businessEntityOwnershipValue,
    totalInvestments,
    totalRetirement,
    totalLiabilities,
    householdLiabilityBalance,
    businessEntityOwnershipValue,
    netWorth,
    netWorthAllocation,
    liabilityByType,
    liquidAssetRatio,
    propertyConcentration,
    assetsByCountry,
    liabilitiesByCountry,
    retirementByCountry,
    netWorthByCountryConverted,
    countriesInUse,
    liquidAssets,
    emergencyFundMonths,
    averageInterestRate,
    debtToIncome,
    debtServiceRatio,
    liabilitiesWithPayoff,
    goodDebt,
    badDebt,
    variableRateDebtBalance,
    variableRateDebtRatio,
    upcomingRateResetBalance12m,
    creditUtilization,
    investmentCostBase,
    investmentUnrealisedGain,
    investmentDiversificationScore,
    investmentByCountry,
    institutionConcentration,
    dividendMonthlyIncome,
    dividendYield,
    rentalMonthlyIncome,
    retirementEmployerMonthlyContribution,
    retirementPersonalMonthlyContribution,
    investmentAnnualContribution,
    investmentContributionRate,
    retirementContributionRate,
    retirementEmployerContributionRate,
    insuranceByType,
    totalAnnualPremium,
    upcomingRenewals,
    incomeProtectionWaitingPeriodDays,
    ratios,
    snapshots: input.snapshots,
    goals: input.goals,
    // LR-FI-1: the two cash-flow completeness flags follow the same household
    // scope as the figures they gate — a household whose only income row is
    // SMSF rent genuinely has no household income, and reporting hasIncome
    // while grossMonthlyIncome is 0 would make every downstream engine score
    // a zero-income household instead of honestly saying "add your income".
    // hasAssets/hasLiabilities are wealth flags and stay on the full
    // registers, so SMSF economic value keeps counting (§5, §28).
    //
    // WP-03 (DC-05 / EXP-G6): planned OR actual on the canonical path, so an
    // imported-only household is no longer treated as having no income or
    // expenses; false when that section could not be read.
    hasIncome: cf.hasIncome,
    hasExpenses: cf.hasExpenses,
    hasAssets: input.assets.length > 0 || input.investments.length > 0 || input.retirement.length > 0,
    hasLiabilities: input.liabilities.length > 0,
    dataStatus: {
      basis: input.canonical ? 'canonical_read_models' : 'registers_only',
      unavailable: cf.unavailable,
      unconverted,
      netIncomeUnknownComponents: cf.netUnknownComponents,
      netIncomeBasis,
      grossIncomeIncludesNetFloor: cf.grossIncludesNetFloor,
      costOfDebtMonthly: cf.costOfDebtMonthly,
      window: input.canonical?.window ?? null,
      importedNotInNetWorth: input.canonical?.importedNotInNetWorth ?? null,
      bankBalanceEvidence: input.canonical?.bankBalanceEvidence ?? null,
      retirementContributionFrequencyUnknown,
      possibleDuplicateIncomeCount: cf.possibleDuplicateIncomeCount,
      unknownPendingCount: cf.unknownPendingCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared insurance-adequacy facts, reused by both the Health Score's
// Insurance & Protection component (Module 4) and the Resilience engine's
// Insurance & Protection component (Module 6) so the underlying life-cover
// gap calculation isn't duplicated across modules.
// ---------------------------------------------------------------------------
export interface InsuranceAdequacyFacts {
  hasLife: boolean;
  hasIncomeProtection: boolean;
  lifeCover: number;
  targetLifeCover: number;
  adequacyRatio: number | null;
  incomeProtectionWaitingPeriodDays: number | null;
}

export function computeInsuranceAdequacy(d: DashboardSummary, dependantsCount: number): InsuranceAdequacyFacts {
  const hasLife = d.insuranceByType.some((i) => i.coverType === 'life');
  const hasIncomeProtection = d.insuranceByType.some((i) => i.coverType === 'income_protection');
  const lifeCover = d.insuranceByType.find((i) => i.coverType === 'life')?.coverAmount ?? 0;
  const annualIncome = d.grossMonthlyIncome * 12;
  const targetLifeCover = annualIncome * (dependantsCount > 0 ? 10 : 5);
  const adequacyRatio = targetLifeCover > 0 ? lifeCover / targetLifeCover : null;
  return {
    hasLife,
    hasIncomeProtection,
    lifeCover,
    targetLifeCover,
    adequacyRatio,
    incomeProtectionWaitingPeriodDays: d.incomeProtectionWaitingPeriodDays,
  };
}
