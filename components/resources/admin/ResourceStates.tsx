// Loading / empty / error states shared across the Resources Admin shell —
// spec §47-50.

export function ResourceLoadingSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-2" role="status" aria-label="Loading content">
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
        <button type="button" onClick={action.onClick} className="mt-4 text-sm font-semibold text-trust hover:underline">
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ResourceErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 px-6 py-8 text-center">
      <p className="text-sm font-semibold text-risk">We couldn&apos;t load Resources content. Try again.</p>
      <p className="mt-1 text-xs text-muted">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 rounded border border-risk/30 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/10">
          Retry
        </button>
      )}
    </div>
  );
}
