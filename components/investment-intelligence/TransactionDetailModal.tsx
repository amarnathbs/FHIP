'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { fmtDate } from './dateDisplay';

// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// The first genuine DATA-DISPLAY modal in this codebase — the only prior
// modal-ish component (components/ui/ConfirmDialog.tsx) is an action
// confirmation, not a content viewer. This follows its established
// accessibility conventions (focus trap cycling Tab/Shift+Tab, Escape to
// close, focus restored to the opener on close, aria-modal + labelled
// title) rather than inventing a new pattern, adapted for `role="dialog"`
// (not `alertdialog`, since nothing here is being confirmed/destroyed) and
// a wider, scrollable content area suited to a full transaction ledger.

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface LedgerRowView {
  transactionId: string;
  date: string;
  description: string;
  transactionType: string;
  amount: number;
  units: number | null;
  navPrice: number | null;
  unitBalanceAfter: number;
  xirrCashFlow: number | null;
  status: string;
  excludedFromXirr: boolean;
}

export interface TerminalRowView {
  date: string;
  description: string;
  amount: number;
}

export interface LedgerView {
  instrumentName: string;
  folioNumber: string | null;
  currencyCode: string;
  rows: LedgerRowView[];
  terminal: TerminalRowView | null;
  investorXirr: { status: string; value?: { rate: number }; detail?: string };
  methodologyNote: string;
}

function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

export function TransactionDetailModal({
  open,
  onClose,
  accountId,
  instrumentId,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string | null;
  instrumentId: string | null;
}) {
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const titleId = `txn-modal-title-${instanceId}`;

  useEffect(() => {
    if (!open || !accountId || !instrumentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/investment-intelligence/holdings/ledger?accountId=${encodeURIComponent(accountId)}&instrumentId=${encodeURIComponent(instrumentId)}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? 'Transaction detail could not be loaded.');
        else setLedger(json.data as LedgerView);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Transaction detail could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, instrumentId]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    returnFocusRef.current = opener instanceof HTMLElement ? opener : null;
    closeRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active instanceof Node ? active : null)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const opener2 = returnFocusRef.current;
      if (opener2 && document.contains(opener2)) opener2.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setLedger(null);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-3xl rounded-card bg-white p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              {ledger ? ledger.instrumentName : 'Transaction detail'}
            </h2>
            {ledger?.folioNumber && <p className="mt-0.5 text-xs text-muted">Folio {ledger.folioNumber}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50"
          >
            Close
          </button>
        </div>

        <div className="mt-4 max-h-[70vh] overflow-y-auto">
          {loading && <p className="text-sm text-muted">Loading transaction history…</p>}
          {error && <p className="rounded-card border border-risk bg-white p-4 text-sm text-risk">{error}</p>}
          {ledger && !loading && !error && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-line uppercase tracking-wide text-muted">
                      <th className="py-2 pr-3 font-medium">Date</th>
                      <th className="py-2 pr-3 font-medium">Transaction details</th>
                      <th className="py-2 pr-3 font-medium text-right">Amount</th>
                      <th className="py-2 pr-3 font-medium text-right">Units</th>
                      <th className="py-2 pr-3 font-medium text-right">NAV/Price</th>
                      <th className="py-2 pr-3 font-medium text-right">Unit balance</th>
                      <th className="py-2 pr-3 font-medium text-right">XIRR cash flow</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.rows.map((r) => (
                      <tr key={r.transactionId} className="border-b border-line align-top">
                        <td className="py-2 pr-3 tabular-nums text-ink">{fmtDate(r.date)}</td>
                        <td className="py-2 pr-3 text-ink">
                          {r.description}
                          {r.excludedFromXirr && <span className="ml-1 text-muted">(excluded — {r.status.replace(/_/g, ' ')})</span>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-ink">{money(r.amount, ledger.currencyCode)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-muted">{r.units === null ? '—' : r.units.toFixed(3)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-muted">{r.navPrice === null ? '—' : r.navPrice.toFixed(4)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-ink">{r.unitBalanceAfter.toFixed(3)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-ink">{r.xirrCashFlow === null ? '—' : money(r.xirrCashFlow, ledger.currencyCode)}</td>
                      </tr>
                    ))}
                    {ledger.terminal && (
                      <tr className="border-b border-line bg-gray-50 font-medium">
                        <td className="py-2 pr-3 tabular-nums text-ink">{fmtDate(ledger.terminal.date)}</td>
                        <td className="py-2 pr-3 text-ink">{ledger.terminal.description}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-ink" colSpan={4} />
                        <td className="py-2 pr-3 text-right tabular-nums text-ink">{money(ledger.terminal.amount, ledger.currencyCode)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 rounded-card border border-line bg-gray-50 p-3">
                <p className="text-sm font-medium text-ink">
                  XIRR:{' '}
                  {ledger.investorXirr.status === 'CALCULATED' && ledger.investorXirr.value ? (
                    <span className="tabular-nums">{pct(ledger.investorXirr.value.rate)}</span>
                  ) : (
                    <span className="text-muted">{ledger.investorXirr.detail ?? 'Not available'}</span>
                  )}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted">{ledger.methodologyNote}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
