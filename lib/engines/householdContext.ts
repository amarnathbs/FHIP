// ---------------------------------------------------------------------------
// LR-FI-1 — SMSF Household Financial Isolation (P0 financial-integrity hotfix)
//
// The `owner` column has allowed 'smsf' on all seven financial-data-grid
// registers since the very first grid migration
// (supabase/migrations/0004_financial_data_grid.sql: `check (owner in
// ('self','spouse','joint','child','family_trust','company','smsf','other'))`,
// applied identically to income_sources / expense_items / assets /
// liabilities / investments / retirement_accounts / insurance_policies), and
// the live grid UI offers it (lib/constants.ts OWNER_OPTIONS). No calculation
// engine ever consumed it, so an SMSF loan instalment, SMSF audit fee or SMSF
// rental receipt flowed straight into the PERSONAL household's Monthly
// Expenses / Monthly Surplus / Savings Rate / Debt Service Ratio, and from
// there into the Health Score, Resilience, Financial Twin, Financial DNA,
// Forecasting and Reports — every one of which derives those figures from
// computeDashboard() rather than recomputing them.
//
// CANONICAL CONTEXT SIGNAL (LR-FI-1 §8). `owner = 'smsf'` is the only
// discriminator that currently exists for these rows, and it is deliberately
// the one used here:
//   * smsf_funds / smsf_holdings / smsf_fund_members (migration 0084) model
//     the certified SMSF *valuation* architecture, and they never reference
//     the grid registers' `owner` column at all;
//   * smsf_create_fund()'s own p_owner is constrained to 'self'|'spouse'|
//     'joint' (lib/validation/smsf.ts), so a fund's retirement_accounts row
//     is NEVER owner='smsf' — the certified SMSF wealth path is structurally
//     untouched by anything in this file;
//   * property_liability_links.link_type='smsf_property_loan' identifies a
//     fund's property loan, but it is optional, fund-scoped, and absent for
//     the plain "user tagged this row as SMSF" case this defect is about.
// So `owner` is the strongest currently available canonical discriminator for
// grid-row SMSF context. If a richer context_type/context_id model lands with
// the future SMSF entity workspace, this module is the single place to
// re-point — no engine hard-codes the string itself.
//
// SCOPE — CASH FLOW ONLY (LR-FI-1 §5, §28). SMSF economic value must REMAIN
// in household wealth: assets, investments, retirement balances, liability
// balances, Gross Assets and Net Worth are all deliberately left untouched by
// this rule, so the hotfix's Net Worth effect is $0 for unchanged economic
// balances. What is removed is only the household's *operating cash flow*
// reading of an SMSF-context row: its income, its expense, its loan
// instalment, its insurance premium. A liability keeps its balance in Net
// Worth while its repayment leaves household expenses — exactly the
// separation LR-FI-1 §12 specifies.
// ---------------------------------------------------------------------------

/** The `owner` value denoting an SMSF-context row (migration 0004's CHECK). */
export const SMSF_OWNER = 'smsf';

/** Minimal shape of any financial-data-grid row this rule can classify. */
export interface OwnedRow {
  owner?: string | null;
}

/**
 * True when a row's economic context is the personal household, so its
 * amounts belong in household operating cash flow (income received, expenses
 * paid, loan instalments serviced, premiums paid).
 *
 * Self / spouse / joint / child / other all remain household context —
 * LR-FI-1 §16-18 are explicit that "not Self" must never be confused with
 * "not household". Company and family_trust are knowingly left as household
 * context here: LR-FI-1 §19 defers their entity semantics to the later
 * entity-context work and forbids silently expanding this hotfix's scope to
 * them. Rows with no `owner` loaded (undefined) or a null owner are treated
 * as household — the fail-safe direction, since it preserves today's
 * behaviour for every caller that has not opted into this rule.
 */
export function isHouseholdOperatingCashFlow(row: OwnedRow): boolean {
  return row.owner !== SMSF_OWNER;
}

/** Convenience filter — the array form of isHouseholdOperatingCashFlow. */
export function householdOperatingCashFlowRows<T extends OwnedRow>(rows: T[]): T[] {
  return rows.filter(isHouseholdOperatingCashFlow);
}

// QUERY-LEVEL EXCLUSION.
//
// Two registers — income_sources and expense_items — are 100% operating cash
// flow: they carry no balance, cover or valuation that Net Worth or
// protection adequacy could ever need. Readers of those two that aggregate
// OUTSIDE computeDashboard() therefore exclude SMSF rows in the query itself,
// chaining `.neq('owner', SMSF_OWNER)` alongside the existing
// `.eq('is_active', true)` — the codebase's own filter idiom.
//
// A builder-wrapping helper (excludeSmsfOwned(query)) was written and then
// deliberately removed: every typed form of it (self-referential
// `T extends { neq(...): T }`, infer-the-result, and infer-the-argument with
// an assertion) makes tsc re-enter PostgrestFilterBuilder's recursive
// generics and fail with TS2589 "type instantiation is excessively deep" at
// lib/services/twinData.ts, where the call sits inside an 11-element
// Promise.all tuple. Exporting the constant and chaining .neq() directly
// keeps the literal 'smsf' in exactly one place with zero type cost, and the
// real shared rule still lives in isHouseholdOperatingCashFlow() above —
// which is what computeDashboard(), the single hub every household engine
// derives from, actually applies.
//
// liabilities / insurance_policies / assets / investments /
// retirement_accounts are deliberately NEVER filtered at the query level:
// those rows must still be read in full so their balances and cover keep
// contributing to Net Worth and protection adequacy. For them the row is
// loaded whole and only the cash-flow-bearing field (monthly_repayment,
// premium) is filtered, inside computeDashboard().
