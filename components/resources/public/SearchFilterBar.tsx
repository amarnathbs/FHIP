'use client';

// R1.6 search filters — spec §13/§24. Same "URL is the state" pattern as
// TopicFilterBar.tsx, extended to preserve the `q` param across filter
// changes and reset `page` to 1 on any change.

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { CONTENT_TYPE_LABELS, JURISDICTION_LABELS } from '@/lib/resources/admin/labels';
import { VALID_SEARCH_CONTENT_TYPES, VALID_SEARCH_JURISDICTIONS } from '@/lib/resources/search/validation';
import type { ResourceContentType, ResourceJurisdiction } from '@/lib/resources/types';

export interface SearchTopicOption {
  id: string;
  name: string;
}

export function SearchFilterBar({ contentType, jurisdiction, categoryId, topics }: { contentType: string; jurisdiction: string; categoryId: string; topics: SearchTopicOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete(key);
    else params.set(key, value);
    params.delete('page');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    const q = params.get('q');
    const fresh = new URLSearchParams();
    if (q) fresh.set('q', q);
    const qs = fresh.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const hasActiveFilters = contentType !== 'all' || jurisdiction !== 'all' || categoryId !== 'all';

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label htmlFor="search-type-filter" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Content Type
        </label>
        <select
          id="search-type-filter"
          value={contentType}
          onChange={(e) => updateParam('type', e.target.value)}
          className="rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
        >
          {VALID_SEARCH_CONTENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t === 'all' ? 'All' : CONTENT_TYPE_LABELS[t as ResourceContentType]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="search-topic-filter" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Topic
        </label>
        <select
          id="search-topic-filter"
          value={categoryId}
          onChange={(e) => updateParam('category', e.target.value)}
          className="rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
        >
          <option value="all">All</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="search-jurisdiction-filter" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Jurisdiction
        </label>
        <select
          id="search-jurisdiction-filter"
          value={jurisdiction}
          onChange={(e) => updateParam('jurisdiction', e.target.value)}
          className="rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust"
        >
          {VALID_SEARCH_JURISDICTIONS.map((j) => (
            <option key={j} value={j}>
              {j === 'all' ? 'All' : JURISDICTION_LABELS[j as ResourceJurisdiction]}
            </option>
          ))}
        </select>
      </div>
      {hasActiveFilters && (
        <button type="button" onClick={clearFilters} className="rounded-compact border border-line px-3 py-2 text-sm font-semibold text-ink hover:border-trust hover:text-trust">
          Clear filters
        </button>
      )}
    </div>
  );
}
