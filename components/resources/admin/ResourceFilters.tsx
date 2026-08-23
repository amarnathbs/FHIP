'use client';

// Search + filter bar — spec §26-31. Filter/search/sort state lives in the
// parent (ResourceContentListClient) and is mirrored into the URL there;
// this component is purely presentational plus onChange callbacks.

import { CONTENT_TYPE_VALUES, JURISDICTION_VALUES, COMPLIANCE_VALUES, STATUS_VALUES, CONTENT_TYPE_LABELS, JURISDICTION_LABELS, COMPLIANCE_LABELS, STATUS_LABELS } from '@/lib/resources/admin/labels';
import type { RelatedRef } from '@/lib/resources/admin/queries';

export interface FilterState {
  search: string;
  status: string;
  contentType: string;
  jurisdiction: string;
  compliance: string;
  categoryId: string;
  sort: string;
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'updated_desc', label: 'Recently Updated' },
  { value: 'updated_asc', label: 'Oldest Updated' },
  { value: 'title_asc', label: 'Title A–Z' },
  { value: 'published_desc', label: 'Published Date' },
  { value: 'review_asc', label: 'Review Date' },
];

const selectClass = 'rounded border border-line bg-white px-2 py-1.5 text-sm text-ink';

export function ResourceFilters({
  value,
  categories,
  showStatusFilter = true,
  onChange,
  onClear,
}: {
  value: FilterState;
  categories: RelatedRef[];
  showStatusFilter?: boolean;
  onChange: (patch: Partial<FilterState>) => void;
  onClear: () => void;
}) {
  const hasActiveFilters =
    value.search !== '' ||
    value.status !== 'all' ||
    value.contentType !== 'all' ||
    value.jurisdiction !== 'all' ||
    value.compliance !== 'all' ||
    value.categoryId !== 'all';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <label htmlFor="resource-search" className="sr-only">
          Search Resources content
        </label>
        <input
          id="resource-search"
          type="search"
          placeholder="Search content…"
          value={value.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="w-56 rounded border border-line bg-white px-3 py-1.5 text-sm text-ink"
        />
      </div>

      {showStatusFilter && (
        <select aria-label="Filter by status" className={selectClass} value={value.status} onChange={(e) => onChange({ status: e.target.value })}>
          <option value="all">All statuses</option>
          {STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      )}

      <select aria-label="Filter by content type" className={selectClass} value={value.contentType} onChange={(e) => onChange({ contentType: e.target.value })}>
        <option value="all">All types</option>
        {CONTENT_TYPE_VALUES.map((t) => (
          <option key={t} value={t}>
            {CONTENT_TYPE_LABELS[t]}
          </option>
        ))}
      </select>

      <select aria-label="Filter by jurisdiction" className={selectClass} value={value.jurisdiction} onChange={(e) => onChange({ jurisdiction: e.target.value })}>
        <option value="all">All jurisdictions</option>
        {JURISDICTION_VALUES.map((j) => (
          <option key={j} value={j}>
            {JURISDICTION_LABELS[j]}
          </option>
        ))}
      </select>

      <select aria-label="Filter by compliance classification" className={selectClass} value={value.compliance} onChange={(e) => onChange({ compliance: e.target.value })}>
        <option value="all">All compliance</option>
        {COMPLIANCE_VALUES.map((c) => (
          <option key={c} value={c}>
            {COMPLIANCE_LABELS[c]}
          </option>
        ))}
      </select>

      {categories.length > 0 && (
        <select aria-label="Filter by category" className={selectClass} value={value.categoryId} onChange={(e) => onChange({ categoryId: e.target.value })}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      <select aria-label="Sort by" className={selectClass} value={value.sort} onChange={(e) => onChange({ sort: e.target.value })}>
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {hasActiveFilters && (
        <button type="button" onClick={onClear} className="text-sm font-semibold text-trust hover:underline">
          Clear Filters
        </button>
      )}
    </div>
  );
}
