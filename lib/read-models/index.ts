/**
 * Canonical read models -- public entry point (WP-02).
 *
 * Server-only (every selector reads the database). UI code that needs a label
 * or a group name imports from './core/categoryGroups' or './core/types'
 * directly, and types with `import type`.
 *
 *   selectIncome(userId, { client })       -> IncomeReadModel
 *   selectExpenses(userId, { client, basis }) -> ExpensesReadModel
 *   selectLiabilities(userId, { client })  -> LiabilitiesReadModel
 *   selectInvestments(userId, { client })  -> InvestmentsReadModel
 *   selectRetirement(userId, { client })   -> RetirementReadModel
 *   selectAssets(userId, { client })       -> AssetsReadModel
 *   buildCanonicalFinancialSnapshot(userId, { client }) -> all of the above, once
 *
 * Contract: CANONICAL_EXPENSE_DATA_CONTRACT.md (in the FDH docs folder) and
 * DOWNSTREAM_DATA_CONSUMER_MATRIX.md (same folder).
 */
export { selectIncome, computeIncome, type IncomeReadModel, type IncomeReadModelData } from './income';
export { selectExpenses, computeExpenses, type ExpenseBasis, type ExpensesReadModel, type ExpensesReadModelData } from './expenses';
export { selectLiabilities, computeLiabilities, type CardRepaymentRule, type LiabilitiesReadModel, type LiabilitiesReadModelData } from './liabilities';
export { selectInvestments, computeInvestments, UNPUBLISHED_BUCKET_LABEL, type InvestmentsReadModel, type InvestmentsReadModelData } from './investments';
export { selectRetirement, computeRetirement, type RetirementReadModel, type RetirementReadModelData } from './retirement';
export { selectAssets, computeAssets, BANK_BALANCE_EVIDENCE_LABEL, type AssetsReadModel, type AssetsReadModelData } from './assets';
export { buildCanonicalFinancialSnapshot, type CanonicalFinancialSnapshot, type CanonicalFinancialSnapshotResult } from './snapshot';
export type { ReadModelOptions } from './core/context';
export type { ReadModelResult, ReadModelUnavailable, MoneyValue, Provenance } from './core/types';
export type { ReadWindow } from './core/window';
export type { FxContext } from './core/currency';
