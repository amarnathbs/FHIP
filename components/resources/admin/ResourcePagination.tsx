// Spec §33: server/database pagination, "Showing 26–50 of 218" wording.
//
// Admin A0.2 Wave 5 (§8.7, §11): the control group was a bare <div> with no
// landmark or accessible name, the page position was never announced when it
// changed, and the Previous/Next targets were under the 44px minimum. Also,
// pressing Next onto the final page disables the very button holding focus,
// which drops focus to <body>; focus now moves to the surviving control so
// the operator keeps their place.

import { useRef } from 'react';

export function ResourcePagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  function go(target: number) {
    onPageChange(target);
    // If the button just pressed is about to become disabled, hand focus to
    // its sibling rather than letting it fall to the document body.
    if (target <= 1) requestAnimationFrame(() => nextRef.current?.focus());
    else if (target >= totalPages) requestAnimationFrame(() => prevRef.current?.focus());
  }

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {total === 0 ? 'No results' : `Showing ${from}–${to} of ${total} · Page ${page} of ${totalPages}`}
      </p>
      <div className="flex items-center gap-2">
        <button
          ref={prevRef}
          type="button"
          onClick={() => go(page - 1)}
          disabled={page <= 1}
          className="min-h-11 rounded border border-line px-3 py-1.5 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          ref={nextRef}
          type="button"
          onClick={() => go(page + 1)}
          disabled={page >= totalPages}
          className="min-h-11 rounded border border-line px-3 py-1.5 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
