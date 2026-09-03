'use client';

// R1.3 save-state indicator — spec §38-40/§85/§94. Four distinct states,
// never inferred only from button enabled/disabled styling (spec §94), and
// announced via aria-live="polite" only on actual state transitions (spec
// §85: "avoid excessive announcements on every keystroke" — the parent only
// re-renders this on a real save-state change, not per keystroke, since
// typing itself just flips `dirty` once).

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

const COPY: Record<SaveState, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  dirty: 'Unsaved changes',
  error: 'Save failed',
};

const STYLES: Record<SaveState, string> = {
  saved: 'text-positive',
  saving: 'text-muted',
  dirty: 'text-attention',
  error: 'text-risk',
};

// Admin A0.2 Wave 5 (§8.2, §11, §12): the error state repeated the same
// fact three times in three type sizes, the Retry control stayed enabled
// while a retry was already in flight (so it could be double-submitted),
// and the cluster could not wrap at narrow widths.
export function SaveStatus({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="status" aria-live="polite">
      <span className={`font-medium ${STYLES[state]}`}>{COPY[state]}</span>
      {state === 'error' && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 rounded-full border border-risk px-2.5 py-0.5 text-xs font-semibold text-risk hover:bg-risk/5"
        >
          Retry Save
        </button>
      )}
      {state === 'saving' && onRetry && (
        // While a save is in flight there is nothing to retry; showing a
        // live Retry control here invited a second, racing request.
        <span className="sr-only">Saving your changes.</span>
      )}
    </div>
  );
}
