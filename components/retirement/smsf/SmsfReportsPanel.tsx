'use client';

import { useEffect, useState } from 'react';
import { fetchJson, formatMoneySafe } from './format';
import type { SmsfFundRow } from './types';

// LR-6 — SMSF P&L, Cash Flow, Contributions, Balance Reconciliation and
// Accountant/Auditor export (WP-02/03/04/06/08/09/10). A read-only reports
// surface: nothing here writes to any table. Figures come from
// GET /api/smsf/[id]/report, which is the exact same computation the CSV
// export at GET /api/smsf/[id]/export uses (NEG-04: export totals must never
// differ from what the UI shows).
interface SmsfReportBundle {
  fund: { fund_name: string; mode: string; currency_code: 'AUD' | 'INR' };
  pnl: {
    operatingIncomeMonthly: number;
    operatingExpenseItemsMonthly: number;
    estimatedLoanInterestMonthly: number;
    operatingExpensesMonthly: number;
    netOperatingResultMonthly: number;
  };
  cashFlow: {
    inflows: { operatingIncomeMonthly: number; contributionsMonthly: number; totalMonthly: number };
    outflows: { operatingExpenseItemsMonthly: number; debtServiceMonthly: number; totalMonthly: number };
    netCashFlowMonthly: number;
  };
  contributions: { employerContributionMonthly: number; personalContributionMonthly: number; totalContributionMonthly: number };
  reconciliation: { detailedNetValue: number | null; summaryBalance: number | null; variance: number | null };
  provenance: { activeHoldingCount: number; activeMemberCount: number; generatedAt: string };
  period: { label: string; startDate: string; endDate: string };
  availablePeriods: string[];
  basis: string;
}

export function SmsfReportsPanel({ fund }: { fund: SmsfFundRow }) {
  const [expanded, setExpanded] = useState(false);
  const [period, setPeriod] = useState<string | null>(null);
  const [bundle, setBundle] = useState<SmsfReportBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = period ? `?period=${encodeURIComponent(period)}` : '';
        const data = await fetchJson<SmsfReportBundle>(`/api/smsf/${fund.id}/report${qs}`);
        if (cancelled) return;
        setBundle(data);
        if (!period) setPeriod(data.period.label);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load SMSF reports');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, period, fund.id]);

  const currency = fund.currency_code;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="text-sm font-medium text-trust hover:underline"
      >
        {`${expanded ? 'Hide' : 'Show'} Reports & Export`}
      </button>

      {expanded && (
        <div className="mt-3">
          {loading && !bundle && <p className="text-sm text-muted">Loading…</p>}
          {error && <p className="text-sm text-risk">{error}</p>}

          {bundle && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={`smsf-period-${fund.id}`} className="text-xs text-muted">
                  Financial year
                </label>
                <select
                  id={`smsf-period-${fund.id}`}
                  value={period ?? bundle.period.label}
                  onChange={(e) => setPeriod(e.target.value)}
                  className="rounded border border-line px-2 py-1 text-sm"
                >
                  {bundle.availablePeriods.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
                <a
                  href={`/api/smsf/${fund.id}/export?period=${encodeURIComponent(period ?? bundle.period.label)}`}
                  className="ml-auto rounded bg-trust px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  Download accountant/auditor CSV
                </a>
              </div>

              <p className="text-[11px] text-muted">
                Figures reflect your currently recorded ongoing SMSF income, expenses and contributions, shown as a
                monthly rate for {bundle.period.label}. This release does not retain a transaction history, so
                historical financial years show the same current rate rather than a distinct past result.
              </p>

              <section aria-labelledby={`smsf-pl-${fund.id}`}>
                <h4 id={`smsf-pl-${fund.id}`} className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Profit &amp; Loss (monthly)
                </h4>
                <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Operating income" value={formatMoneySafe(bundle.pnl.operatingIncomeMonthly, currency)} />
                  <Stat label="Operating expenses" value={formatMoneySafe(bundle.pnl.operatingExpensesMonthly, currency)} />
                  <Stat
                    label="Net operating result"
                    value={formatMoneySafe(bundle.pnl.netOperatingResultMonthly, currency)}
                    emphasise
                  />
                </dl>
                <p className="mt-1 text-[11px] text-muted">
                  Loan interest is estimated from the linked property loan&apos;s rate and balance. Loan principal is
                  never included here — it is a capital repayment, not an operating expense.
                </p>
              </section>

              <section aria-labelledby={`smsf-cf-${fund.id}`}>
                <h4 id={`smsf-cf-${fund.id}`} className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Cash Flow (monthly)
                </h4>
                <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Total inflow" value={formatMoneySafe(bundle.cashFlow.inflows.totalMonthly, currency)} />
                  <Stat label="Debt service" value={formatMoneySafe(bundle.cashFlow.outflows.debtServiceMonthly, currency)} />
                  <Stat label="Total outflow" value={formatMoneySafe(bundle.cashFlow.outflows.totalMonthly, currency)} />
                  <Stat label="Net cash flow" value={formatMoneySafe(bundle.cashFlow.netCashFlowMonthly, currency)} emphasise />
                </dl>
              </section>

              <section aria-labelledby={`smsf-contrib-${fund.id}`}>
                <h4 id={`smsf-contrib-${fund.id}`} className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Contributions (monthly)
                </h4>
                <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Employer" value={formatMoneySafe(bundle.contributions.employerContributionMonthly, currency)} />
                  <Stat label="Personal" value={formatMoneySafe(bundle.contributions.personalContributionMonthly, currency)} />
                  <Stat label="Total" value={formatMoneySafe(bundle.contributions.totalContributionMonthly, currency)} />
                </dl>
                <p className="mt-1 text-[11px] text-muted">Spouse and rollover contribution sources are not separately tracked yet.</p>
              </section>

              <section aria-labelledby={`smsf-recon-${fund.id}`}>
                <h4 id={`smsf-recon-${fund.id}`} className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Balance Reconciliation
                </h4>
                {bundle.provenance.activeHoldingCount === 0 ? (
                  <p className="mt-2 text-sm text-muted">
                    Detailed Holdings has not been set up for this fund yet, so there is nothing to reconcile against
                    Summary Mode. This is expected — Summary Mode is a complete way to track your SMSF on its own.
                  </p>
                ) : (
                  <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <Stat label="Detailed net value" value={formatMoneySafe(bundle.reconciliation.detailedNetValue, currency)} />
                    <Stat label="Summary balance" value={formatMoneySafe(bundle.reconciliation.summaryBalance, currency)} />
                    <Stat
                      label="Variance"
                      value={
                        bundle.reconciliation.variance === null
                          ? '—'
                          : formatMoneySafe(bundle.reconciliation.variance, currency)
                      }
                      emphasise={!!bundle.reconciliation.variance}
                    />
                  </dl>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
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
