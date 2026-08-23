'use client';

// Spec §70: Resources-scoped loading/error/empty states for the public
// section. Modelled on the existing Admin Resources pattern
// (components/resources/admin/ResourceStates.tsx) — same shape, reader-
// facing wording.

export function PublicEmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="rounded-card border border-dashed border-line bg-white p-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {message && <p className="mt-1 text-sm text-muted">{message}</p>}
    </div>
  );
}

export function PublicErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 p-6 text-center">
      <p className="font-semibold text-risk">Something went wrong loading this page.</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 rounded-compact border border-line px-4 py-1.5 text-sm font-semibold text-ink hover:border-trust hover:text-trust">
          Try again
        </button>
      )}
    </div>
  );
}

export function PublicLoadingState() {
  return (
    <div className="animate-pulse space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="h-6 w-1/3 rounded bg-gray-200" />
      <div className="h-4 w-2/3 rounded bg-gray-200" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-48 rounded-card border border-line bg-gray-100" />
        ))}
      </div>
    </div>
  );
}
