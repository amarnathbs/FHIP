import type { SupabaseClient } from '@supabase/supabase-js';
import type { LiabilityRow } from '@/lib/engines/dashboard';
import { computeSmsfPnl, type SmsfPnlResult } from '@/lib/engines/smsf/smsfPnl';
import { computeSmsfCashFlow, type SmsfCashFlowResult } from '@/lib/engines/smsf/smsfCashFlow';
import { computeSmsfContributions, type SmsfContributionSummary } from '@/lib/engines/smsf/smsfContributions';
import { listEntityIncome, listEntityExpenses } from '@/lib/services/entityCashFlowData';
import { loadSmsfBankActuals, type SmsfBankActuals } from '@/lib/read-models/smsfBankActuals';
import type { Frequency } from '@/lib/engines/money';
import { loadSmsfContributionHistory, type SmsfContributionHistory } from '@/lib/services/smsfContributionDestination';
import {
  getSmsfFund,
  listSmsfOwnedIncome,
  listSmsfOwnedExpenses,
  listSmsfPropertyLoanLiabilitiesForPnl,
  listSmsfLiabilities,
  getSmsfFundContributionSource,
} from '@/lib/services/smsfData';

export interface SmsfFundReportBundle {
  fund: { id: string; fund_name: string; mode: string; currency_code: string; retirement_account_id: string };
  pnl: SmsfPnlResult;
  cashFlow: SmsfCashFlowResult;
  contributions: SmsfContributionSummary;
  /**
   * The contribution ledger rows (destination kind smsf, status active) the totals above are made of. Evidence only: NEVER added to the totals,
   * because the fund account's contribution columns are derived from the same ledger (see smsfContributionDestination.ts).
   */
  contributionHistory: SmsfContributionHistory;
  /**
   * The ONE net the fund is worth, as the rest of the app counts it (smsf_fund_counted_net): worked out from the fund's assets and liabilities
   * while it is itemised, the single typed value while it is a net value only. There is no second "summary" figure and no difference between
   * two figures here (PO review 20-10-2026, F19/F20).
   */
  position: { mode: 'itemised' | 'net_only'; net: number | null };
  /**
   * Where the planned (recurring) income and expense figures come from (F22 / F23). The fund's OWN records (migration 0296) are the source; a
   * record entered the earlier way (a personal row tagged SMSF) still counts until it is moved, and is listed so it is never hidden or doubled.
   */
  sources: {
    entityIncomeCount: number;
    entityExpenseCount: number;
    legacyIncomeCount: number;
    legacyExpenseCount: number;
    /** Records in a currency other than the fund currency: left out of the figures and counted, never zeroed silently. */
    otherCurrencyLeftOutCount: number;
  };
  /** Actuals from approved bank statements of the fund's own accounts. Shown beside the planned figures, never added to them. */
  bankActuals: SmsfBankActuals;
  /** WP-10 auditor pack — structured metadata only, never a raw source document. */
  provenance: {
    activeHoldingCount: number;
    activeMemberCount: number;
    generatedAt: string;
  };
}

/**
 * Assembles one fund's P&L/cash-flow/contribution bundle from already-
 * canonical sources — see smsfPnl.ts/smsfCashFlow.ts/smsfContributions.ts
 * headers for exactly which tables/columns each figure is read from. This is
 * a read-only aggregation: nothing here writes to any table.
 *
 * Household-wide income/expense rows are fetched once and reused as-is —
 * see the module-level note in smsfData.ts's listSmsfOwnedIncome/Expenses:
 * these rows carry no smsf_fund_id (no such column exists), so a household
 * with more than one active SMSF fund gets the SAME combined figures
 * attributed to every fund's bundle. That is a disclosed data-model
 * limitation (see the LR-6 phase report), not a silent misattribution —
 * callers with more than one active fund must show the "combined across N
 * funds" caption the fund-list endpoint already returns a count for.
 */
export async function loadSmsfFundReportBundle(
  fundId: string,
  userId: string,
  supabase: SupabaseClient
): Promise<{ data: SmsfFundReportBundle | null; error: Error | null }> {
  const { data: fund, error: fundErr } = await getSmsfFund(fundId, supabase);
  if (fundErr || !fund || fund.user_id !== userId) {
    return { data: null, error: fundErr ?? new Error('not found') };
  }

  const scope = { kind: 'smsf', fundId } as const;
  const [incomeResult, expenseResult, loanLinksResult, contributionResult, fundLiabilitiesResult, entityIncomeResult, entityExpenseResult, bankActuals] = await Promise.all([
    listSmsfOwnedIncome(userId, supabase),
    listSmsfOwnedExpenses(userId, supabase),
    listSmsfPropertyLoanLiabilitiesForPnl(fundId, userId, supabase),
    getSmsfFundContributionSource(fundId, userId, supabase),
    listSmsfLiabilities(fundId, userId, supabase),
    listEntityIncome(scope, userId, supabase),
    listEntityExpenses(scope, userId, supabase),
    loadSmsfBankActuals(userId, supabase),
  ]);
  if (entityIncomeResult.error) return { data: null, error: new Error(entityIncomeResult.error.message) };
  if (entityExpenseResult.error) return { data: null, error: new Error(entityExpenseResult.error.message) };
  if (incomeResult.error) return { data: null, error: new Error(incomeResult.error.message) };
  if (expenseResult.error) return { data: null, error: new Error(expenseResult.error.message) };
  if (loanLinksResult.error) return { data: null, error: new Error(loanLinksResult.error.message) };

  const fundCurrency = fund.currency_code ?? 'AUD';
  const sameCurrency = <T extends { currency_code: string }>(rows: T[]) => rows.filter((r) => r.currency_code === fundCurrency);
  const entityIncome = entityIncomeResult.data ?? [];
  const entityExpenses = entityExpenseResult.data ?? [];
  const entityIncomeUsed = sameCurrency(entityIncome as { currency_code: string }[]) as typeof entityIncome;
  const entityExpensesUsed = sameCurrency(entityExpenses as { currency_code: string }[]) as typeof entityExpenses;
  const legacyIncome = incomeResult.data ?? [];
  const legacyExpenses = expenseResult.data ?? [];
  // The fund's own records first, then anything still recorded the earlier way. Each flow is in exactly ONE place: moving a legacy row retires it.
  const incomeRows = [
    ...entityIncomeUsed.map((r) => ({ amount: Number(r.amount), frequency: r.frequency as Frequency })),
    ...legacyIncome,
  ];
  const expenseRows = [
    ...entityExpensesUsed.map((r) => ({ amount: Number(r.amount), frequency: r.frequency as Frequency, master_item_key: null, expense_category: null })),
    ...legacyExpenses,
  ];

  type LoanLink = { liabilities: Pick<LiabilityRow, 'balance' | 'interest_rate' | 'monthly_repayment' | 'debt_type' | 'master_item_key'> | null };
  if (fundLiabilitiesResult.error) return { data: null, error: new Error(fundLiabilitiesResult.error.message) };
  // The fund's OWN liabilities (migration 0289, entity-level) and any personal loan still linked to the fund both service the same P&L; each loan is
  // in exactly one of the two places (the move action retires the personal side), so nothing is counted twice.
  const fundOwnLoans: NonNullable<LoanLink['liabilities']>[] = (fundLiabilitiesResult.data ?? []).map((l) => ({
    balance: Number(l.balance),
    interest_rate: l.interest_rate === null ? null : Number(l.interest_rate),
    monthly_repayment: l.monthly_repayment === null ? 0 : Number(l.monthly_repayment),
    debt_type: l.liability_type === 'property_loan' ? 'mortgage' : l.liability_type === 'other_loan' ? 'other_term_loan' : 'other',
    master_item_key: null,
  }));
  const propertyLoanLiabilities = [
    ...((loanLinksResult.data ?? []) as unknown as LoanLink[]).map((link) => link.liabilities).filter((l): l is NonNullable<typeof l> => l != null),
    ...fundOwnLoans,
  ];

  const pnl = computeSmsfPnl({ incomeRows, expenseRows, propertyLoanLiabilities });

  const contributionSource = contributionResult.data ?? {
    employer_contribution: null,
    personal_contribution: null,
    contribution_frequency: null,
  };
  const contributions = computeSmsfContributions(contributionSource);
  const contributionHistory = await loadSmsfContributionHistory(userId, fund.retirement_account_id, supabase);

  const cashFlow = computeSmsfCashFlow({
    incomeRows,
    expenseRows,
    propertyLoanLiabilities,
    contributionsMonthly: contributions.totalContributionMonthly,
  });

  // The counted net comes from the ONE database function the rest of the app reads (migration 0289), never recomputed a second way.
  const [netResult, holdingsCountResult, membersCountResult] = await Promise.all([
    supabase.rpc('smsf_fund_counted_net', { p_fund_id: fundId }),
    supabase
      .from('smsf_holdings')
      .select('id', { count: 'exact', head: true })
      .eq('smsf_fund_id', fundId)
      .eq('user_id', userId)
      .eq('is_active', true),
    supabase.from('smsf_fund_members').select('id', { count: 'exact', head: true }).eq('smsf_fund_id', fundId).eq('user_id', userId),
  ]);
  if (netResult.error) return { data: null, error: new Error(netResult.error.message) };

  const countedNet = netResult.data === null || netResult.data === undefined ? null : Number(netResult.data);

  return {
    data: {
      fund: {
        id: fund.id,
        fund_name: fund.fund_name,
        mode: fund.mode,
        currency_code: fund.currency_code ?? 'AUD',
        retirement_account_id: fund.retirement_account_id,
      },
      pnl,
      cashFlow,
      contributions,
      contributionHistory,
      position: { mode: fund.mode === 'detailed' ? 'itemised' : 'net_only', net: countedNet },
      sources: {
        entityIncomeCount: entityIncomeUsed.length,
        entityExpenseCount: entityExpensesUsed.length,
        legacyIncomeCount: legacyIncome.length,
        legacyExpenseCount: legacyExpenses.length,
        otherCurrencyLeftOutCount: entityIncome.length - entityIncomeUsed.length + (entityExpenses.length - entityExpensesUsed.length),
      },
      bankActuals,
      provenance: {
        activeHoldingCount: holdingsCountResult.count ?? 0,
        activeMemberCount: membersCountResult.count ?? 0,
        generatedAt: new Date().toISOString(),
      },
    },
    error: null,
  };
}
