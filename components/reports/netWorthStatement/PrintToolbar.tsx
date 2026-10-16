'use client';

import { useEffect, useRef } from 'react';

/**
 * The toolbar on the bare print view. It hides itself when printing (`no-print`). When opened with print=1 it opens the
 * browser's print dialog once, so "Print / Save as PDF" from the Reports page ends in one click; the person can always
 * press the button again. Browser printing is available to every plan (the Export Centre rule on the Reports page).
 */
export function PrintToolbar({ autoPrint }: { autoPrint: boolean }) {
  const done = useRef(false);
  useEffect(() => {
    if (autoPrint && !done.current) {
      done.current = true;
      const t = window.setTimeout(() => window.print(), 300);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [autoPrint]);
  return (
    <div className="no-print mb-4 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => window.print()} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust">
        Print / Save as PDF
      </button>
      <span className="text-xs text-gray-600">Choose &ldquo;Save as PDF&rdquo; as the destination to keep a copy. A4, portrait.</span>
    </div>
  );
}
