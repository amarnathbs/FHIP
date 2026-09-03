'use client';

// Shared content-list client — spec §35: "Use the same reusable ContentList
// component/configuration. Do not duplicate entire pages." Every queue page
// (All Content, Drafts, Review Queue, Scheduled, Published, Review Due,
// Archived) renders this same component with a different `queue` prop (or
// none, for All Content); filters/search/sort/pagination all live here.
//
// Filter/search/sort/page state is mirrored into the URL (spec §30: "prefer
// preserving filter state in URL query parameters... refresh-safe;
// shareable within admin; back-button friendly") via router.replace with
// scroll:false, so typing in the search box doesn't jump the page.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ResourceFilters, type FilterState } from './ResourceFilters';
import { ResourceContentTable } from './ResourceContentTable';
import { ResourcePagination } from './ResourcePagination';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceFailureState } from './ResourceStates';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import type { ContentListItem, RelatedRef } from '@/lib/resources/admin/queries';
import type { QueuePreset } from '@/lib/resources/admin/filters';

const DEFAULT_FILTERS: FilterState = {
  search: '',
  status: 'all',
  contentType: 'all',
  jurisdiction: 'all',
  compliance: 'all',
  categoryId: 'all',
  sort: 'updated_desc',
};

function filtersFromParams(params: URLSearchParams): FilterState {
  return {
    search: params.get('q') ?? '',
    status: params.get('status') ?? 'all',
    contentType: params.get('type') ?? 'all',
    jurisdiction: params.get('jurisdiction') ?? 'all',
    compliance: params.get('compliance') ?? 'all',
    categoryId: params.get('category') ?? 'all',
    sort: params.get('sort') ?? 'updated_desc',
  };
}

export function ResourceContentListClient({ queue, title, description }: { queue?: QueuePreset; title: string; description: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [filters, setFilters] = useState<FilterState>(() => filtersFromParams(searchParams));
  const [page, setPage] = useState(() => Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const [items, setItems] = useState<ContentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [categories, setCategories] = useState<RelatedRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [categoriesUnavailable, setCategoriesUnavailable] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    // Admin A0.2 Wave 5 (§8.5): this swallowed every failure, and the
    // category dropdown is rendered only when the list is non-empty — so a
    // failed categories fetch made a whole filter silently vanish, with no
    // way for the operator to tell it had ever existed. The failure is now
    // recorded and disclosed beside the filters.
    fetch('/api/admin/resources/categories')
      .then(async (r) => {
        if (!r.ok) {
          setCategoriesUnavailable(true);
          return;
        }
        const j = await readJsonSafely(r);
        setCategories((j?.data as RelatedRef[]) ?? []);
      })
      .catch(() => setCategoriesUnavailable(true));
  }, []);

  const buildQuery = useCallback(
    (f: FilterState, p: number) => {
      const qp = new URLSearchParams();
      if (f.search) qp.set('q', f.search);
      if (f.status !== 'all') qp.set('status', f.status);
      if (f.contentType !== 'all') qp.set('type', f.contentType);
      if (f.jurisdiction !== 'all') qp.set('jurisdiction', f.jurisdiction);
      if (f.compliance !== 'all') qp.set('compliance', f.compliance);
      if (f.categoryId !== 'all') qp.set('category', f.categoryId);
      if (f.sort !== 'updated_desc') qp.set('sort', f.sort);
      if (p > 1) qp.set('page', String(p));
      if (queue) qp.set('queue', queue);
      return qp;
    },
    [queue]
  );

  const load = useCallback(
    async (f: FilterState, p: number) => {
      setLoading(true);
      setFailure(null);
      try {
        const res = await fetch(`/api/admin/resources/content?${buildQuery(f, p).toString()}`);
        const json = await readJsonSafely(res);
        if (!res.ok) {
          setFailure(failureFromResponse(res.status, json, 'Resources content'));
          setItems([]);
          setTotal(0);
          return;
        }
        const data = json?.data as { items?: ContentListItem[]; total?: number; pageSize?: number } | undefined;
        setItems(data?.items ?? []);
        setTotal(data?.total ?? 0);
        setPageSize(data?.pageSize ?? 25);
      } catch (e) {
        setFailure(failureFromThrown(e, 'Resources content'));
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [buildQuery]
  );

  // Debounced fetch on filter/page change; also mirrors state into the URL.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const qp = buildQuery(filters, page);
      router.replace(qp.toString() ? `?${qp.toString()}` : '?', { scroll: false });
      void load(filters, page);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // `buildQuery`/`load`/`router` deliberately excluded — this effect should
    // only re-fire when filters/page/reloadToken actually change, not on
    // every render (router and the callbacks are stable in practice here;
    // including them would re-trigger the debounce on unrelated re-renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, reloadToken]);

  function handleFilterChange(patch: Partial<FilterState>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function handleClear() {
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }

  const hasActiveFilters = useMemo(
    () =>
      filters.search !== '' ||
      filters.status !== 'all' ||
      filters.contentType !== 'all' ||
      filters.jurisdiction !== 'all' ||
      filters.compliance !== 'all' ||
      filters.categoryId !== 'all',
    [filters]
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>
      </div>

      <AdminTaskHelp taskId={queue ? 'ADM-21' : 'ADM-08'} />

      <div className="rounded-card border border-line bg-white p-4">
        <ResourceFilters value={filters} categories={categories} showStatusFilter={!queue} onChange={handleFilterChange} onClear={handleClear} />

        {categoriesUnavailable && (
          <p role="status" className="mt-2 text-xs text-muted">
            The category filter is unavailable right now, so it is not shown. Everything else on this page still works.
          </p>
        )}

        {/* §11 — the result count is announced, so filtering and paging are
            perceivable without sight. Previously the list simply changed. */}
        <p role="status" aria-live="polite" className="mt-3 text-xs text-muted">
          {loading || failure
            ? ''
            : total === 0
              ? 'No results.'
              : `${total} ${total === 1 ? 'item' : 'items'}${hasActiveFilters ? ' match these filters' : ''}.`}
        </p>

        <div className="mt-2">
          {loading ? (
            <ResourceLoadingSkeleton label={`Loading ${title}`} />
          ) : failure ? (
            <ResourceFailureState failure={failure} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState
              title={hasActiveFilters ? 'No content matches these filters.' : 'No Resources content yet.'}
              message={
                hasActiveFilters
                  ? 'Try adjusting or clearing your filters.'
                  : 'Content you are allowed to see will appear here. If you expected content, your roles may not include access to it.'
              }
              action={hasActiveFilters ? { label: 'Clear Filters', onClick: handleClear } : undefined}
            />
          ) : (
            <>
              <ResourceContentTable items={items} />
              <div className="mt-3">
                <ResourcePagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
