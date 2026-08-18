'use client';

// Jurisdiction + content-type filters for the Topic page (spec §24/§25).
// Spec §24: "Use URL state... do not store public filter state only in
// React memory" — every change here calls router.push with an updated
// search-param string, so the filter state lives in the URL (shareable,
// back-button-safe, and still legible if JS fails to hydrate since the
// server component reads the same searchParams to render the initial list).

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { CONTENT_TYPE_LABELS, JURISDICTION_LABELS } from '@/lib/resources/admin/labels';
import { PUBLIC_CONTENT_TYPES } from '@/lib/resources/public/visibility';

const JURISDICTIONS = ['all', 'global', 'australia', 'india', 'australia_india_cross_border'] as const;

export function TopicFilterBar({ jurisdiction, type }: { jurisdiction: string; type: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete(key);
    else params.set(key, value);
    params.delete('page'); // any filter change resets to page 1
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label htmlFor="jurisdiction-filter" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Jurisdiction
        </label>
        <select
          id="jurisdiction-filter"
          value={jurisdiction}
          onChange={(e) => updateParam('jurisdiction', e.target.value)}
          className="rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
        >
          {JURISDICTIONS.map((j) => (
            <option key={j} value={j}>
              {j === 'all' ? 'All' : JURISDICTION_LABELS[j]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="type-filter" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Content type
        </label>
        <select
          id="type-filter"
          value={type}
          onChange={(e) => updateParam('type', e.target.value)}
          className="rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
        >
          <option value="all">All</option>
          {PUBLIC_CONTENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {CONTENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
