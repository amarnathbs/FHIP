'use client';

/**
 * PO rule 17-10-2026: the owner-occupied home-loan repayment counts as an ESSENTIAL expense when the household has
 * recorded no rent (lib/engines/essentialHousing.ts, applied once in computeDashboard()).
 *
 * This read-only block makes that visible where the household enters expenses and debts, so the essential total they
 * see here reconciles with the Dashboard, the Resilience score and the Monthly Report:
 *  - Expenses page: "Home loan repayment (counted as essential, no rent recorded)" with the amount, and the essential
 *    total made of "your essential expenses" plus that line. The repayment itself lives in Liabilities; nothing here
 *    writes anything.
 *  - Liabilities page: an "Essential housing cost" label for the Home Loan.
 * It reads the Dashboard summary (the same figure every other screen reads) and renders nothing when the rule does not
 * apply (no owner-occupied loan), except to say so when the household's rent is what stops it applying.
 */
import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/engines/money';
import { essentialHomeLoanLineLabel, essentialHomeLoanNote, type EssentialHomeLoanResolution } from '@/lib/engines/essentialHousing';

export interface EssentialHomeLoanView {
  currency: 'AUD' | 'INR';
  essentialMonthlyExpenses: number;
  essentialHomeLoan: EssentialHomeLoanResolution | undefined;
}

export function EssentialHomeLoanBlock({ view, variant }: { view: EssentialHomeLoanView; variant: 'expenses' | 'liabilities' }) {
  const r = view.essentialHomeLoan;
  if (!r) return null;
  const note = essentialHomeLoanNote(r, view.currency);
  if (!note) return null;
  const money = (n: number) => formatMoney(n, view.currency);

  if (r.status !== 'counted') {
    return (
      <p className="rounded-card border border-line bg-white p-3 text-xs text-muted" role="note" data-testid={`essential-home-loan-${r.status}`}>
        {note}
      </p>
    );
  }

  if (variant === 'liabilities') {
    return (
      <section className="rounded-card border border-line bg-white p-3 text-sm" aria-label="Essential housing cost" data-testid="essential-home-loan-liabilities">
        <p className="font-medium text-gray-800">
          Essential housing cost <span className="ml-1 rounded bg-trust/10 px-2 py-0.5 text-xs font-medium text-trust">Home loan</span>
        </p>
        <p className="mt-1 text-xs text-muted">{note} It is also part of your debt repayments and is counted once in your monthly surplus.</p>
        <ul className="mt-2 space-y-1 text-xs text-gray-700">
          {r.lines.map((l) => (
            <li key={l.id ?? l.name} className="flex justify-between border-b py-1 last:border-0">
              <span>{l.name}</span>
              <span className="font-medium">{money(l.monthly)} a month</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const withoutLoan = view.essentialMonthlyExpenses - r.monthly;
  return (
    <section className="rounded-card border border-line bg-white p-3 text-sm" aria-label="Essential expenses including the home loan repayment" data-testid="essential-home-loan-expenses">
      <ul className="space-y-1">
        <li className="flex justify-between border-b py-1">
          <span className="text-gray-700">Your expenses marked Essential</span>
          <span className="font-medium text-gray-900">{money(withoutLoan)} a month</span>
        </li>
        {r.lines.map((l) => (
          <li key={l.id ?? l.name} className="flex justify-between border-b py-1" data-testid="essential-home-loan-line">
            <span className="text-gray-700">
              {r.lines.length > 1 ? `${l.name}: ` : ''}
              {essentialHomeLoanLineLabel()}
              <span className="ml-1 text-xs text-muted">(read-only, edit it under Liabilities)</span>
            </span>
            <span className="font-medium text-gray-900">{money(l.monthly)} a month</span>
          </li>
        ))}
        <li className="flex justify-between py-1">
          <span className="font-medium text-gray-800">Essential total</span>
          <span className="font-semibold text-gray-900">{money(view.essentialMonthlyExpenses)} a month</span>
        </li>
      </ul>
      <p className="mt-2 text-xs text-muted">{note} The repayment is also in your debt repayments and is counted once in your monthly surplus. Record rent and it is no longer added.</p>
    </section>
  );
}

export function EssentialHomeLoanNote({ variant }: { variant: 'expenses' | 'liabilities' }) {
  const [view, setView] = useState<EssentialHomeLoanView | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/dashboard/summary')
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { currency?: string; essentialMonthlyExpenses?: number; essentialHomeLoan?: EssentialHomeLoanResolution } };
        const d = json.data;
        if (!d || cancelled) return;
        setView({
          currency: d.currency === 'INR' ? 'INR' : 'AUD',
          essentialMonthlyExpenses: Number(d.essentialMonthlyExpenses ?? 0),
          essentialHomeLoan: d.essentialHomeLoan,
        });
      })
      .catch(() => {
        // Supplementary and read-only: if the summary cannot be read the page works exactly as before.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return view ? <EssentialHomeLoanBlock view={view} variant={variant} /> : null;
}
