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

export function SaveStatus({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm" aria-live="polite">
      <span className={`font-medium ${STYLES[state]}`}>{COPY[state]}</span>
      {state === 'error' && (
        <>
          <span className="text-xs text-muted">Your latest changes could not be saved.</span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="rounded-full border border-risk px-2.5 py-0.5 text-xs font-semibold text-risk hover:bg-risk/5">
              Retry Save
            </button>
          )}
        </>
      )}
    </div>
  );
}
