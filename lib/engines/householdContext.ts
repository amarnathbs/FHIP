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
// SCOPE — CASH FLOW ONLY (LR-FI-1 §5, §28). This module's own filter
// (isHouseholdOperatingCashFlow/householdOperatingCashFlowRows) is exactly
// `owner !== 'smsf'`, applied to income/expense rows and to a liability's
// *repayment* (and, for DTI, its balance via householdLiabilityBalance) —
// never to a liability's balance for Net Worth. A liability keeps its
// balance in totalLiabilities/liabilityByType/Net Worth regardless of
// owner, including owner='smsf' and including a liability whose EFFECTIVE
// owner was forced to 'smsf' by applySmsfPropertyLoanLinkOverride() below.
//
// The LR independent audit's P0-1 fix (2026-09-14) briefly pointed
// dashboard.ts's totalLiabilities/totalLiabilityMonthlyRepayments/
// liabilityByType at this same owner-filtered array too, reasoning that an
// SMSF fund's own valuation (smsf_compute_detailed_net_value(), migration
// 0084) already subtracts its linked loan before that net figure reaches
// totalRetirement, so also keeping the loan's balance in totalLiabilities
// double-subtracted it (live-proven: a $500,000 SMSF property against a
// $365,000 linked loan, nothing else, reported Net Worth −$230,000 instead
// of $135,000). That scenario is real, but the fix was too broad — it
// excluded EVERY SMSF-context liability from Net Worth, not only ones
// actually netted elsewhere in the same computation, which zeroed out a
// plain owner='smsf' (or LR-12R-linked) liability with no netted fund
// valuation present. That is the $365,000 regression the LR-FI
// Financial-Integrity Recovery (2026-09-17) found across
// tests/unit/smsfHouseholdIsolation.test.ts, lrFi2HouseholdDebtRatios.test.ts
// and lr12rSmsfPropertyLoanLinkOverride.test.ts, and reverted — see
// dashboard.ts's totalLiabilities doc comment for the restored mechanism.
// Correctly fixing the original double-subtraction needs a per-loan/
// per-fund correlation this module does not have (or a gross, not netted,
// fund valuation) and remains an open item for the PO.
//
// Assets, investments and retirement balances remain untouched by this
// rule, as originally stated — an SMSF-owned one of those must keep
// contributing to Net Worth (spec §5, §28).
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

// ---------------------------------------------------------------------------
// LR-12R reconciliation (2026-09-11, PO ruling) — the gap this module's own
// header (line 28-30 above) explicitly named as deferred: a liability
// structurally linked to an SMSF fund as its property loan
// (property_liability_links.link_type='smsf_property_loan') is the fund's
// own debt regardless of whether the row is ALSO manually owner-tagged
// 'smsf'. A live oracle (household income $10k/mo, personal debt service
// $1k/mo, an SMSF-linked-but-not-owner-tagged loan repayment of $2k/mo)
// proved DSR came back 30% instead of the required 10% before this fix —
// a real financial-context defect, not a discoverability nuance. The PO's
// own instruction: "The correct fix should preferably use the canonical
// SMSF link/context rather than requiring a user to understand that they
// must separately set owner='smsf'."
//
// This does not change isHouseholdOperatingCashFlow()'s own rule (still
// exactly `owner !== 'smsf'`) — it widens what counts as 'smsf' for
// liabilities specifically, by overriding the EFFECTIVE owner on a shallow
// copy fed to computeDashboard(). The real, stored liabilities.owner
// column — and every other reader of it, including the Liabilities
// register's own display/edit UI — is completely untouched; only
// computeDashboard()'s own input is enriched. Consumed by DTI/DSR only —
// certified by tests/unit/lr12rSmsfPropertyLoanLinkOverride.test.ts to leave
// totalLiabilities/liabilityByType/Net Worth whole. The P0-1 fix
// (2026-09-14) briefly also routed Net Worth through this override's
// effective owner; the LR-FI Financial-Integrity Recovery (2026-09-17)
// reverted that as an over-broad regression — see dashboard.ts's
// totalLiabilities doc comment.
/** Minimal shape of a liability row this override needs to see. */
export interface LiabilityRowForSmsfLinkOverride {
  id: string;
  owner?: string | null;
}

/**
 * Returns a new array where any liability whose id is in `smsfLinkedLiabilityIds`
 * has its effective `owner` forced to `'smsf'` — used only as computeDashboard()'s
 * input, never written back to the database. Rows not in the set are returned
 * unchanged (same object reference), so this is a no-op, allocation-free pass
 * for the overwhelmingly common household with no SMSF-linked property loan.
 */
export function applySmsfPropertyLoanLinkOverride<T extends LiabilityRowForSmsfLinkOverride>(
  liabilities: T[],
  smsfLinkedLiabilityIds: ReadonlySet<string>
): T[] {
  if (smsfLinkedLiabilityIds.size === 0) return liabilities;
  return liabilities.map((l) => (smsfLinkedLiabilityIds.has(l.id) ? { ...l, owner: SMSF_OWNER } : l));
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
