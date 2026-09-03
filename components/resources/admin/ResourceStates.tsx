// Loading / empty / error states shared across the Resources Admin shell —
// spec §47-50.
//
// Admin A0.2 Wave 5: `ResourceErrorState` previously hardcoded a single
// headline — "We couldn't load Resources content. Try again." — which was
// rendered verbatim on the Resources dashboard, the Users & Roles screen,
// the Videos/Glossary/Money-Updates/FAQ/CTA lists and the route-level error
// boundary, none of which are "Resources content". It also always offered a
// Retry button, including for a 403 permission denial where retrying the
// identical request can never succeed.
//
// The headline is now a prop (defaulting to the original string so the
// non-Admin Financial Data Hub call sites are unchanged), and a distinct
// `ResourceUnavailableState` renders the non-retryable result states
// (`forbidden`, `not_found`, `unavailable`) that must not look like a
// transient failure. See lib/resources/admin/resultState.ts for the
// classification these render.

import type { AdminFailure } from '@/lib/resources/admin/resultState';

export function ResourceLoadingSkeleton({ rows = 6, label = 'Loading content' }: { rows?: number; label?: string }) {
  return (
    <div className="animate-pulse space-y-2" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 rounded border border-line bg-gray-50" />
      ))}
    </div>
  );
}

export function ResourceEmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-card border border-dashed border-line bg-gray-50/50 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="mt-4 min-h-11 text-sm font-semibold text-trust hover:underline">
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ResourceErrorState({
  message,
  title,
  onRetry,
}: {
  message: string;
  /** Specific headline naming what failed. Defaults to the original shared string. */
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 px-6 py-8 text-center">
      <p className="text-sm font-semibold text-risk">{title ?? "We couldn't load Resources content. Try again."}</p>
      <p className="mt-1 text-xs text-muted">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded border border-risk/30 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/10">
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * A result state that is NOT a transient failure — the caller is not
 * permitted, the target does not exist, or the capability itself is not
 * operational. Deliberately neutral (not red/alarming) and deliberately
 * offers no Retry, because retrying changes nothing.
 */
export function ResourceUnavailableState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div role="status" className="rounded-card border border-line bg-white px-6 py-8 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="mt-4 min-h-11 text-sm font-semibold text-trust hover:underline">
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Renders whichever of the two failure presentations is correct for a
 * classified `AdminFailure`, so a screen never has to decide for itself
 * whether a Retry button is honest.
 */
export function ResourceFailureState({ failure, onRetry }: { failure: AdminFailure; onRetry?: () => void }) {
  if (!failure.retryable) {
    return <ResourceUnavailableState title={failure.title} message={failure.message} />;
  }
  return <ResourceErrorState title={failure.title} message={failure.message} onRetry={onRetry} />;
}
