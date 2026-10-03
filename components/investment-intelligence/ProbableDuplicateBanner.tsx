'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { isCrossSourceReviewType } from '@/lib/services/investment-intelligence/crossSourceReviewPolicy';

// A non-blocking banner (Document2 D-5, PO decision 2026-10-03): "some of your
// entries may be duplicates, here is where you decide". It never hides or
// disables anything and renders nothing when there is nothing to decide. A
// failure to load is silent on purpose: this is a courtesy highlight, the
// analysis it describes does not depend on it.
export function ProbableDuplicateBanner() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/reconciliation-cases?status=open');
        const json = await res.json();
        if (!res.ok || cancelled) return;
        const rows = Array.isArray(json.data) ? (json.data as Array<{ discrepancy_type?: string }>) : [];
        setCount(rows.filter((r) => isCrossSourceReviewType(r.discrepancy_type)).length);
      } catch {
        /* silent by design */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (count === 0) return null;
  return (
    <div role="status" className="mb-6 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
      <strong className="text-ink">
        {count === 1 ? '1 possible duplicate' : `${count} possible duplicates`}
      </strong>{' '}
      <span className="text-muted">
        between a statement and an entry you added. Both are counted in your figures for now, so nothing is blocked. You decide what to keep.
      </span>{' '}
      <Link href="/investment-intelligence/review" className="font-medium text-primary underline">
        Review {count === 1 ? 'it' : 'them'}
      </Link>
    </div>
  );
}
