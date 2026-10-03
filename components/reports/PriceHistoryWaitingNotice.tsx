'use client';

// The state shown while a report (or the Performance page) waits for the price
// history of the user's funds to load (PO decision 2026-10-03). Plain words, no
// ids. It never says "not available" for a fund that is still loading; that
// word is only used for a fund that could not be loaded at all (which no longer
// holds anything back).

export interface PriceHistoryWaitState {
  headline: string | null;
  loaded: number;
  total: number;
  waitingFunds: string[];
  unavailableFunds: string[];
  retryWindowMinutes: number;
}

/** Presentational, so the exact words the user sees can be tested. */
export function PriceHistoryWaitingNotice({ state, subject = 'report' }: { state: PriceHistoryWaitState; subject?: 'report' | 'performance figures' }) {
  return (
    <section role="status" aria-live="polite" className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 text-sm">
      <h2 className="font-semibold text-ink">{state.headline ?? `Your ${subject} will be ready once price history is loaded`}</h2>
      <p className="mt-1 text-muted">
        We are fetching the price history of your funds now. {subject === 'report' ? 'Your report is generated automatically as soon as it is in; you do not need to do anything.' : 'The figures appear as soon as it is in; you do not need to do anything.'}{' '}
        If a fund’s history cannot be loaded within about {state.retryWindowMinutes} minutes, we go ahead without it and say so.
      </p>
      {state.waitingFunds.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted">
          {state.waitingFunds.map((name) => (
            <li key={name}>Loading price history for {name}</li>
          ))}
        </ul>
      )}
      {state.unavailableFunds.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-ink">
          {state.unavailableFunds.map((name) => (
            <li key={name}>Price history for {name} could not be loaded; its figures are marked not available.</li>
          ))}
        </ul>
      )}
    </section>
  );
}
