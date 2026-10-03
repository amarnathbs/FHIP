'use client';

import { useCallback, useEffect, useState } from 'react';
import { fmtDate } from './dateDisplay';
import { formatMoneyCode } from '@/lib/engines/money';
import { DATE_INPUT_HINT, DATE_INPUT_PLACEHOLDER, formatDateInput } from '@/lib/engines/dateInput';
import {
  INVESTMENT_DATE_STATE_HELP,
  INVESTMENT_DATE_STATE_LABEL,
  validateInvestmentDate,
  type InvestmentDateItemState,
} from '@/lib/investment-intelligence/investmentDate';

// "Needs investment date" (Document2 D-3, PO decision 2026-10-03).
//
// A statement holding with NO purchase date is listed here with a plain call
// to action: type the date you invested (day first). The date is checked
// here for fast feedback and again on the server, which is the authority.
// Saving it makes the position behave exactly as if the statement had carried
// the date; it can be changed later. Nothing else on the page waits on it.
//
// Renders NOTHING when there is no such position, so it is safe to place on
// any page. Dates are shown day-first (dd-mm-yyyy in India, dd/mm/yyyy in
// Australia) through fmtDate(); the input is a text field read with
// parseDateInput() because a native date picker follows the BROWSER's locale.

export interface InvestmentDateItemView {
  accountId: string;
  instrumentId: string;
  schemeName: string;
  isin: string | null;
  maskedFolio: string | null;
  institutionName: string | null;
  currencyCode: string;
  units: number;
  statementAsOfDate: string;
  statementValue: number | null;
  state: InvestmentDateItemState;
  investmentDate: string | null;
  navPrice: number | null;
  navDate: string | null;
  earliestKnownNavDate: string | null;
}

const BADGE: Record<InvestmentDateItemState, string> = {
  needs_date: 'bg-amber-100 text-amber-800',
  awaiting_nav: 'bg-gray-100 text-gray-700',
  applied: 'bg-green-100 text-green-800',
};

/** One position. Presentational: the container owns the network call. */
export function InvestmentDateRow({
  item,
  busy,
  serverError,
  notice,
  onSave,
  initiallyEditing,
}: {
  item: InvestmentDateItemView;
  busy: boolean;
  serverError: string | null;
  /** The server's plain-words result of the last save or check (e.g. "We will keep trying."). */
  notice?: string | null;
  onSave: (item: InvestmentDateItemView, dateText: string) => void;
  initiallyEditing?: boolean;
}) {
  const [editing, setEditing] = useState(initiallyEditing ?? item.state === 'needs_date');
  const [text, setText] = useState(item.investmentDate ? formatDateInput(item.investmentDate) : '');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputId = `investment-date-${item.accountId}-${item.instrumentId}`;
  const errorId = `${inputId}-error`;
  const helpId = `${inputId}-help`;
  const error = localError ?? serverError;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const check = validateInvestmentDate({
      text,
      todayIso: new Date().toISOString().slice(0, 10),
      inceptionIso: item.earliestKnownNavDate,
      statementAsOfIso: item.statementAsOfDate,
    });
    if (!check.ok) {
      setLocalError(check.message);
      return;
    }
    setLocalError(null);
    onSave(item, text);
  }

  return (
    <li className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-ink">{item.schemeName}</h3>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[item.state]}`}>{INVESTMENT_DATE_STATE_LABEL[item.state]}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {item.institutionName ? `${item.institutionName} · ` : ''}
        {item.maskedFolio ? `Folio ${item.maskedFolio} · ` : ''}
        {item.units.toLocaleString(item.currencyCode === 'INR' ? 'en-IN' : 'en-AU', { maximumFractionDigits: 3 })} units on {fmtDate(item.statementAsOfDate, item.currencyCode)}
        {item.statementValue !== null ? ` · ${formatMoneyCode(item.statementValue, item.currencyCode)} on the statement` : ''}
      </p>
      <p className="mt-2 text-sm text-muted">{INVESTMENT_DATE_STATE_HELP[item.state]}</p>

      {item.state !== 'needs_date' && item.investmentDate && (
        <p className="mt-2 text-sm text-ink">
          Investment date: <strong>{fmtDate(item.investmentDate, item.currencyCode)}</strong>
          {item.navPrice !== null && item.navDate ? ` · fund price used ${formatMoneyCode(item.navPrice, item.currencyCode)} on ${fmtDate(item.navDate, item.currencyCode)}` : ''}
        </p>
      )}

      {editing ? (
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3" noValidate>
          <div>
            <label htmlFor={inputId} className="block text-xs font-medium text-muted">
              Date you invested
            </label>
            <input
              id={inputId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder={DATE_INPUT_PLACEHOLDER}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setLocalError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${helpId} ${errorId}` : helpId}
              className="mt-1 w-40 rounded border border-line px-2 py-1.5 text-sm"
            />
          </div>
          <button type="submit" disabled={busy || text.trim() === ''} className="min-h-9 rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {busy ? 'Saving…' : item.state === 'needs_date' ? 'Save date' : 'Save new date'}
          </button>
          {item.state !== 'needs_date' && (
            <button type="button" onClick={() => setEditing(false)} className="min-h-9 rounded border border-line px-3 py-1.5 text-sm text-ink">
              Cancel
            </button>
          )}
          <p id={helpId} className="w-full text-xs text-muted">
            {DATE_INPUT_HINT}
            {item.earliestKnownNavDate ? ` This fund has price history from ${fmtDate(item.earliestKnownNavDate, item.currencyCode)}.` : ''}
          </p>
          {error && (
            <p id={errorId} role="alert" className="w-full text-xs text-red-600">
              {error}
            </p>
          )}
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className="min-h-9 rounded border border-line px-3 py-1.5 text-sm text-primary">
            Change date
          </button>
          {item.state === 'awaiting_nav' && item.investmentDate && (
            // Saving the same date again is the "check again" action: it retries the fetch of this one fund's price history.
            <button type="button" disabled={busy} onClick={() => onSave(item, formatDateInput(item.investmentDate))} className="min-h-9 rounded border border-line px-3 py-1.5 text-sm text-primary disabled:opacity-50">
              {busy ? 'Checking…' : 'Check again'}
            </button>
          )}
        </div>
      )}
      {notice && !error && (
        <p role="status" className="mt-2 text-xs text-muted">
          {notice}
        </p>
      )}
    </li>
  );
}

export function InvestmentDatePanel() {
  const [items, setItems] = useState<InvestmentDateItemView[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  const [noticeByKey, setNoticeByKey] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/investment-intelligence/investment-dates');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load');
      setItems(json.data.items ?? []);
      setLoadError(null);
    } catch {
      // Non-blocking by design: a failure to load this prompt must never get in the way of the page.
      setLoadError('Could not check which investments need a date.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(item: InvestmentDateItemView, dateText: string) {
    const key = `${item.accountId}:${item.instrumentId}`;
    setBusyKey(key);
    setErrorByKey((prev) => ({ ...prev, [key]: '' }));
    try {
      const res = await fetch('/api/investment-intelligence/investment-dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: item.accountId, instrumentId: item.instrumentId, date: dateText }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? json.error ?? 'Could not save the date.');
      // The server's plain-words status (applied / waiting for price history / could not fetch, "we will keep trying").
      setNoticeByKey((prev) => ({ ...prev, [key]: typeof json.data?.message === 'string' ? json.data.message : '' }));
      await load();
    } catch (e) {
      setErrorByKey((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : 'Could not save the date.' }));
    } finally {
      setBusyKey(null);
    }
  }

  if (loadError) return <p className="mb-4 text-xs text-muted">{loadError}</p>;
  if (!items || items.length === 0) return null;
  const needing = items.filter((i) => i.state === 'needs_date').length;

  return (
    <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50/40 p-4" aria-labelledby="investment-date-heading">
      <h2 id="investment-date-heading" className="text-sm font-semibold text-ink">
        {needing > 0 ? `${needing} ${needing === 1 ? 'investment needs' : 'investments need'} the date you invested` : 'Investment dates you added'}
      </h2>
      <p className="mt-1 text-sm text-muted">
        These holdings come from a statement that shows what you hold but not when you bought it. Add the date and your return is worked out from then. Your other
        figures are not affected while you decide.
      </p>
      <ul className="mt-3 space-y-3">
        {items.map((item) => {
          const key = `${item.accountId}:${item.instrumentId}`;
          // The key carries the saved answer, so after a save the row remounts with fresh state (editor closed, new date shown).
          return <InvestmentDateRow key={`${key}:${item.state}:${item.investmentDate ?? ''}`} item={item} busy={busyKey === key} serverError={errorByKey[key] || null} notice={noticeByKey[key] || null} onSave={save} />;
        })}
      </ul>
    </section>
  );
}
