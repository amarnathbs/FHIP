'use client';

import { useEffect, useState } from 'react';
import { fetchJson, formatMoneySafe } from '@/components/retirement/smsf/format';
import { computeEntityCashFlow, type EntityCashFlowResult } from '@/lib/engines/entityCashFlow';
import type { Frequency } from '@/lib/engines/money';

type Currency = 'AUD' | 'INR';

interface IncomeRow { income_type: string; amount: number; frequency: Frequency; currency_code: string }
interface ExpenseRow { expense_type: string; amount: number; frequency: Frequency; currency_code: string }
interface LiabilityRow { value: number; interest_rate: number | null; monthly_repayment: number | null; currency_code: string }

/**
 * The monthly picture of ONE entity from its OWN income, expenses and liabilities (never personal Income or Expenses). The loan principal is cash
 * flow and is never counted as an expense: the operating result carries the estimated interest, the cash flow carries the full repayment once.
 * Reads the same lists the panels edit, so it follows every change (`refreshKey`).
 */
export function EntityCashFlowSummary({ apiBase, currency, refreshKey, fxRateAudInr = 56 }: { apiBase: string; currency: Currency; refreshKey: number; fxRateAudInr?: number }) {
  const [result, setResult] = useState<EntityCashFlowResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [income, expenses, liabilities] = await Promise.all([
          fetchJson<IncomeRow[]>(`${apiBase}/income`),
          fetchJson<ExpenseRow[]>(`${apiBase}/expenses`),
          fetchJson<LiabilityRow[]>(`${apiBase}/liabilities`).catch(() => [] as LiabilityRow[]),
        ]);
        if (cancelled) return;
        setResult(
          computeEntityCashFlow({
            currency,
            fxRateAudInr,
            income: income.map((r) => ({ type: r.income_type, amount: Number(r.amount), frequency: r.frequency, currency: r.currency_code })),
            expenses: expenses.map((r) => ({ type: r.expense_type, amount: Number(r.amount), frequency: r.frequency, currency: r.currency_code })),
            loans: liabilities.map((l) => ({ balance: Number(l.value), interestRatePercent: l.interest_rate, monthlyRepayment: l.monthly_repayment, currency: l.currency_code })),
          }),
        );
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not work out the monthly figures');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, currency, refreshKey, fxRateAudInr]);

  if (error) return <p role="alert" className="text-sm text-risk">{error}</p>;
  if (!result) return <p className="text-sm text-muted">Working out the monthly figures…</p>;
  const m = (n: number) => formatMoneySafe(n, currency);
  return (
    <section aria-label="Monthly cash flow of this entity" data-testid="entity-cash-flow-summary">
      <h4 className="text-sm font-semibold text-ink">Monthly picture</h4>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Stat label="Income" value={m(result.incomeMonthly)} />
        <Stat label="Expenses" value={m(result.expensesMonthly)} />
        <Stat label="Estimated loan interest" value={m(result.estimatedInterestMonthly)} />
        <Stat label="Net operating result" value={m(result.netOperatingResultMonthly)} emphasise />
        <Stat label="Loan repayments (cash flow)" value={m(result.debtServiceMonthly)} />
        <Stat label="Net cash flow" value={m(result.netCashFlowMonthly)} emphasise />
      </dl>
      <p className="mt-1 text-[11px] text-muted">
        Recurring amounts shown as a monthly rate. The loan principal is cash flow, it is never counted as an expense, and none of this is part of your personal income, expenses or debt ratios.
        {result.unconvertedCount > 0 ? ` ${result.unconvertedCount} item(s) in a currency that cannot be converted are left out, not counted as zero.` : ''}
      </p>
    </section>
  );
}

function Stat({ label, value, emphasise }: { label: string; value: string; emphasise?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`tabular-nums text-ink ${emphasise ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}
