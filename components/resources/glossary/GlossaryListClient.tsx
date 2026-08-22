'use client';

// R1.4 Glossary list — spec §25.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ResourceStatusBadge, ResourceJurisdictionBadge } from '@/components/resources/admin/ResourceBadges';
import { ResourcePagination } from '@/components/resources/admin/ResourcePagination';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { JURISDICTION_LABELS, JURISDICTION_VALUES, STATUS_LABELS, STATUS_VALUES, formatAdminDate } from '@/lib/resources/admin/labels';
import type { GlossaryListItem } from '@/lib/resources/glossary/queries';

const selectClass = 'rounded border border-line bg-white px-2 py-1.5 text-sm text-ink';

export function GlossaryListClient({ canCreate }: { canCreate: boolean }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [jurisdiction, setJurisdiction] = useState('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<GlossaryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('q', search);
      if (status !== 'all') qp.set('status', status);
      if (jurisdiction !== 'all') qp.set('jurisdiction', jurisdiction);
      if (page > 1) qp.set('page', String(page));
      const res = await fetch(`/api/admin/resources/glossary?${qp.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "We couldn't load Glossary definitions. Try again.");
      setItems(json.data.items);
      setTotal(json.data.total);
      setPageSize(json.data.pageSize);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [search, status, jurisdiction, page]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, reloadToken]);

  const hasFilters = search !== '' || status !== 'all' || jurisdiction !== 'all';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Glossary</h1>
          <p className="mt-1 text-sm text-muted">Concise financial definitions used across FHIP.</p>
        </div>
        {canCreate && (
          <Link href="/admin/resources/glossary/new" className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            New Glossary Definition
          </Link>
        )}
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" aria-label="Search Glossary" placeholder="Search term, alias or definition…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-56 rounded border border-line bg-white px-3 py-1.5 text-sm text-ink" />
          <select aria-label="Filter by status" className={selectClass} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="all">All statuses</option>
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <select aria-label="Filter by jurisdiction" className={selectClass} value={jurisdiction} onChange={(e) => { setJurisdiction(e.target.value); setPage(1); }}>
            <option value="all">All jurisdictions</option>
            {JURISDICTION_VALUES.map((j) => (
              <option key={j} value={j}>{JURISDICTION_LABELS[j]}</option>
            ))}
          </select>
          {hasFilters && (
            <button type="button" onClick={() => { setSearch(''); setStatus('all'); setJurisdiction('all'); setPage(1); }} className="text-sm font-semibold text-trust hover:underline">
              Clear Filters
            </button>
          )}
        </div>

        <div className="mt-4">
          {loading ? (
            <ResourceLoadingSkeleton />
          ) : error ? (
            <ResourceErrorState message={error} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState
              title={hasFilters ? 'No definitions match these filters.' : 'No glossary definitions have been created yet.'}
              message={hasFilters ? 'Try adjusting or clearing your filters.' : 'Create your first glossary definition.'}
              action={canCreate && !hasFilters ? { label: 'New Glossary Definition', onClick: () => (window.location.href = '/admin/resources/glossary/new') } : undefined}
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3 font-semibold">Term</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">Short Definition</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Category</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Jurisdiction</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Updated</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold xl:table-cell">Review Due</th>
                      <th scope="col" className="py-2 pl-3 font-semibold"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((g) => (
                      <tr key={g.id} className="border-b border-line/60 hover:bg-gray-50">
                        <td className="max-w-[200px] py-2.5 pr-3">
                          <Link href={`/admin/resources/glossary/${g.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                            {g.title}
                          </Link>
                        </td>
                        <td className="hidden max-w-[280px] truncate py-2.5 pr-3 text-muted md:table-cell">{g.excerpt ?? '—'}</td>
                        <td className="hidden py-2.5 pr-3 text-muted lg:table-cell">{g.primary_category?.name ?? '—'}</td>
                        <td className="hidden py-2.5 pr-3 lg:table-cell"><ResourceJurisdictionBadge jurisdiction={g.jurisdiction} /></td>
                        <td className="py-2.5 pr-3"><ResourceStatusBadge status={g.status} /></td>
                        <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{formatAdminDate(g.updated_at)}</td>
                        <td className="hidden py-2.5 pr-3 text-muted xl:table-cell">{formatAdminDate(g.next_review_at)}</td>
                        <td className="py-2.5 pl-3 text-right">
                          <Link href={`/admin/resources/glossary/${g.id}/edit`} className="text-xs font-semibold text-trust hover:underline" aria-label={`Edit "${g.title}"`}>
                            Edit
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-2 sm:hidden">
                {items.map((g) => (
                  <li key={g.id} className="rounded-card border border-line p-3">
                    <Link href={`/admin/resources/glossary/${g.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                      {g.title}
                    </Link>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <ResourceStatusBadge status={g.status} />
                      <ResourceJurisdictionBadge jurisdiction={g.jurisdiction} />
                    </div>
                    <p className="mt-2 text-xs text-muted">Updated {formatAdminDate(g.updated_at)}</p>
                  </li>
                ))}
              </ul>

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
