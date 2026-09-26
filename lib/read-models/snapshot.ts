/**
 * buildCanonicalFinancialSnapshot -- every canonical selector computed ONCE per
 * request, from one FX rate, one window and one ledger (DC-15).
 *
 * Each section is independently 'ok' or 'unavailable': a failed investments
 * read does not blank the expense figures, and no failed section is ever
 * returned as zeros. Consumers (Dashboard, Score, DNA, Resilience, Goals,
 * Twin, Forecast, Reports) take this object instead of re-querying registers.
 */
import '@/lib/serverOnly';
import { resolveContext, type ReadModelOptions } from './core/context';
import type { FxContext } from './core/currency';
import type { NormalisedLedger } from './core/ledger';
import { toUnavailable, type ReadModelUnavailable } from './core/types';
import type { ReadWindow } from './core/window';
import { selectAssets, type AssetsReadModel } from './assets';
import { selectExpenses, type ExpenseBasis, type ExpensesReadModel } from './expenses';
import { selectIncome, type IncomeReadModel } from './income';
import { selectInvestments, type InvestmentsReadModel } from './investments';
import { loadLiabilityRows, selectLiabilities, type CardRepaymentRule, type LiabilitiesReadModel, type LoadedLiabilities } from './liabilities';
import { selectRetirement, type RetirementReadModel } from './retirement';

export interface CanonicalFinancialSnapshot {
  status: 'ok';
  userId: string;
  fx: FxContext;
  window: ReadWindow;
  /** The shared ledger, or why it is unavailable (income/expenses/liabilities then are too). */
  ledger: { status: 'ok'; value: NormalisedLedger } | ReadModelUnavailable;
  income: IncomeReadModel;
  expenses: ExpensesReadModel;
  liabilities: LiabilitiesReadModel;
  investments: InvestmentsReadModel;
  retirement: RetirementReadModel;
  assets: AssetsReadModel;
}

export type CanonicalFinancialSnapshotResult = CanonicalFinancialSnapshot | ReadModelUnavailable;

export async function buildCanonicalFinancialSnapshot(
  userId: string,
  opts: ReadModelOptions & { expenseBasis?: ExpenseBasis; cardRepaymentRule?: CardRepaymentRule },
): Promise<CanonicalFinancialSnapshotResult> {
  let ctx;
  try {
    ctx = await resolveContext(userId, opts);
  } catch (error) {
    // No FX context: nothing can be converted, so nothing is reported.
    return toUnavailable(error, 'buildCanonicalFinancialSnapshot');
  }
  let ledgerSection: CanonicalFinancialSnapshot['ledger'];
  try {
    ledgerSection = { status: 'ok', value: await ctx.ledger() };
  } catch (error) {
    ledgerSection = toUnavailable(error, 'ledger');
  }
  let liabilities: LoadedLiabilities | undefined;
  try {
    liabilities = await loadLiabilityRows(userId, ctx.client);
  } catch {
    liabilities = undefined; // each selector below reloads and reports its own failure
  }
  const shared = { client: ctx.client, fx: ctx.fx, window: ctx.window };
  if (ledgerSection.status !== 'ok') {
    const unavailable = ledgerSection;
    const [investments, retirement, assets] = await Promise.all([
      selectInvestments(userId, shared),
      selectRetirement(userId, shared),
      selectAssets(userId, shared),
    ]);
    return { status: 'ok', userId, fx: ctx.fx, window: ctx.window, ledger: unavailable, income: unavailable, expenses: unavailable, liabilities: unavailable, investments, retirement, assets };
  }
  const ledger = ledgerSection.value;
  const withLedger = { ...shared, ledger };
  const [income, expenses, liabilitiesModel, investments, retirement, assets] = await Promise.all([
    selectIncome(userId, withLedger),
    selectExpenses(userId, { ...withLedger, basis: opts.expenseBasis ?? 'combined', liabilities }),
    selectLiabilities(userId, { ...withLedger, cardRepaymentRule: opts.cardRepaymentRule, liabilities }),
    selectInvestments(userId, shared),
    selectRetirement(userId, shared),
    selectAssets(userId, withLedger),
  ]);
  return { status: 'ok', userId, fx: ctx.fx, window: ctx.window, ledger: ledgerSection, income, expenses, liabilities: liabilitiesModel, investments, retirement, assets };
}
