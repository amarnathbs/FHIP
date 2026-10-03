'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CROSS_SOURCE_OPTION_COPY } from '@/lib/services/investment-intelligence/crossSourceReviewPolicy';
import { fmtDate } from './dateDisplay';
import { formatMoneyCode } from '@/lib/engines/money';

// Probable duplicate between a statement entry and a manual entry (Document2
// D-5, PO decision 2026-10-03). A NON-BLOCKING highlight: both entries are
// counted in the user's figures until the user chooses, and nothing changes
// until they do.
//
//   1. Keep both as they are
//   2. Accept the statement and remove my manual entry   (asks to confirm)
//   3. Reject the statement entry                        (asks to confirm)
//
// A removal is soft and reversible: the entry is kept on record and "Undo this
// decision" puts it back. The server is the authority on what is offered and
// refuses a removal without `confirm: true`; this component only shows it.

type OptionKey = 'keep_both' | 'accept_statement_remove_manual' | 'reject_statement';

interface EntryView {
  transactionId: string;
  origin: 'manual' | 'statement';
  date: string;
  type: string;
  units: number | null;
  amount: number;
  status: string;
  sourceName: string;
}

interface PairPayload {
  caseId: string;
  status: string;
  kind: 'standard' | 'user_supplied_investment_date';
  subject: EntryView | null;
  candidates: EntryView[];
  offered: Record<OptionKey, boolean>;
  decision: string | null;
  canUndo: boolean;
}

/** What the user is told about an entry's place in their figures. Words, not status codes. */
export function describeEntryStatus(status: string): string {
  if (status === 'reversed') return 'Removed from your figures (kept on record)';
  if (status === 'review_required') return 'Left out until you decide';
  return 'Counted in your figures';
}

const DECISION_LABEL: Record<string, string> = {
  keep_both: 'Kept both',
  accept_statement_remove_manual: 'Accepted the statement and removed your manual entry',
  reject_statement: 'Rejected the statement entry',
  confirmed_duplicate: 'Marked as the same transaction',
  confirmed_distinct: 'Marked as different transactions',
};

const CONFIRM_COPY: Record<'accept_statement_remove_manual' | 'reject_statement', { title: string; message: string; confirmLabel: string }> = {
  accept_statement_remove_manual: {
    title: 'Remove your manual entry?',
    message: 'Your manual entry will be taken out of your figures and the statement entry kept. Nothing is deleted: the manual entry stays on record and you can undo this at any time.',
    confirmLabel: 'Yes, remove my manual entry',
  },
  reject_statement: {
    title: 'Reject the statement entry?',
    message: 'The statement entry will be taken out of your figures and your manual entry kept. Nothing is deleted: the statement entry stays on record and you can undo this at any time.',
    confirmLabel: 'Yes, reject the statement entry',
  },
};

export function EntryTable({ entries, currencyCode }: { entries: EntryView[]; currencyCode: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-xs">
        <caption className="sr-only">The entries that may be the same transaction</caption>
        <thead>
          <tr className="text-muted">
            <th scope="col" className="pb-1 pr-3 font-medium">Source</th>
            <th scope="col" className="pb-1 pr-3 font-medium">Date</th>
            <th scope="col" className="pb-1 pr-3 font-medium">Type</th>
            <th scope="col" className="pb-1 pr-3 text-right font-medium">Units</th>
            <th scope="col" className="pb-1 pr-3 text-right font-medium">Amount</th>
            <th scope="col" className="pb-1 font-medium">In your figures</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.transactionId} className="border-t border-line">
              <td className="py-1 pr-3">{e.sourceName}</td>
              <td className="py-1 pr-3 whitespace-nowrap">{fmtDate(e.date, currencyCode)}</td>
              <td className="py-1 pr-3">{e.type.replace(/_/g, ' ')}</td>
              <td className="py-1 pr-3 text-right">{e.units === null ? '—' : e.units.toLocaleString(currencyCode === 'INR' ? 'en-IN' : 'en-AU', { maximumFractionDigits: 3 })}</td>
              <td className="py-1 pr-3 text-right">{formatMoneyCode(e.amount, currencyCode)}</td>
              <td className="py-1">{describeEntryStatus(e.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProbableDuplicateReview({ caseId, currencyCode, onChanged }: { caseId: string; currencyCode: string | null; onChanged: () => void | Promise<void> }) {
  const [pair, setPair] = useState<PairPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'accept_statement_remove_manual' | 'reject_statement' | null>(null);
  const [counterpartId, setCounterpartId] = useState('');
  const base = `/api/investment-intelligence/reconciliation-cases/${encodeURIComponent(caseId)}/resolve-cross-source`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load the entries.');
      setPair(json.data as PairPayload);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the entries.');
    }
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? json.error ?? 'Could not record that choice.');
      await load();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that choice.');
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  if (loadError) return <p className="mt-2 text-xs text-red-600">{loadError}</p>;
  if (!pair) return <p className="mt-2 text-xs text-muted">Loading the entries…</p>;

  const entries = [...(pair.subject ? [pair.subject] : []), ...pair.candidates];
  const needsCounterpart = pair.candidates.length > 1;
  const decided = pair.status === 'resolved';
  const choose = (key: OptionKey) => {
    if (key === 'keep_both') void send({ decision: key, ...(counterpartId ? { counterpartTransactionId: counterpartId } : {}) });
    else setConfirming(key);
  };

  return (
    <div className="mt-2 flex flex-col items-start gap-2">
      {!decided && (
        <p className="text-xs text-amber-800" role="status">
          <strong>Possible duplicate.</strong> These entries may be the same transaction. Both are counted in your figures until you choose, so nothing is blocked.
          {pair.kind === 'user_supplied_investment_date' ? ' One of them is the investment date you typed in, now that a statement has the full history.' : ''}
        </p>
      )}
      {entries.length > 0 && <EntryTable entries={entries} currencyCode={currencyCode} />}

      {!decided && needsCounterpart && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`counterpart-${caseId}`} className="text-xs text-muted">Which existing entry is it about?</label>
          <select id={`counterpart-${caseId}`} value={counterpartId} onChange={(e) => setCounterpartId(e.target.value)} className="rounded-md border px-2 py-1 text-xs">
            <option value="">Choose one</option>
            {pair.candidates.map((c) => (
              <option key={c.transactionId} value={c.transactionId}>
                {c.sourceName}, {fmtDate(c.date, currencyCode)}, {formatMoneyCode(c.amount, currencyCode)}
              </option>
            ))}
          </select>
        </div>
      )}

      {!decided && (
        <ul className="flex flex-col gap-2">
          {(Object.keys(CROSS_SOURCE_OPTION_COPY) as OptionKey[])
            .filter((key) => pair.offered[key])
            .map((key) => (
              <li key={key} className="flex flex-col items-start gap-0.5">
                <button
                  type="button"
                  onClick={() => choose(key)}
                  disabled={busy || (needsCounterpart && !counterpartId && key !== 'keep_both')}
                  className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                >
                  {CROSS_SOURCE_OPTION_COPY[key].label}
                </button>
                <span className="text-[11px] text-muted">{CROSS_SOURCE_OPTION_COPY[key].effect}</span>
              </li>
            ))}
        </ul>
      )}

      {decided && (
        <div className="flex flex-col items-start gap-1">
          <p className="text-xs text-muted">Your decision: <strong>{(pair.decision && DECISION_LABEL[pair.decision]) ?? 'Decided'}</strong>.</p>
          {pair.canUndo && (
            <button type="button" onClick={() => void send({ decision: 'undo' })} disabled={busy} className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50">
              {busy ? 'Undoing…' : 'Undo this decision'}
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? CONFIRM_COPY[confirming].title : ''}
        message={confirming ? CONFIRM_COPY[confirming].message : ''}
        confirmLabel={confirming ? CONFIRM_COPY[confirming].confirmLabel : 'Confirm'}
        cancelLabel="Keep things as they are"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void send({ decision: confirming, confirm: true, ...(counterpartId ? { counterpartTransactionId: counterpartId } : {}) });
        }}
        confirmDisabled={busy}
      />
    </div>
  );
}
