'use client';

// R1.4 Money Update list — spec §41. Covers both money_update and
// money_update_template rows (filterable by `type`).

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceJurisdictionBadge } from '@/components/resources/admin/ResourceBadges';
import { ResourcePagination } from '@/components/resources/admin/ResourcePagination';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { JURISDICTION_LABELS, JURISDICTION_VALUES, COMPLIANCE_LABELS, COMPLIANCE_VALUES, STATUS_LABELS, STATUS_VALUES, formatAdminDate } from '@/lib/resources/admin/labels';
import type { MoneyUpdateListItem } from '@/lib/resources/money-update/queries';

const selectClass = 'rounded border border-line bg-white px-2 py-1.5 text-sm text-ink';

function isReviewDue(item: MoneyUpdateListItem): boolean {
  const target = item.next_review_at ?? item.expires_at;
  if (!target) return false;
  return new Date(target).getTime() <= Date.now();
}

export function MoneyUpdateListClient({ canCreate }: { canCreate: boolean }) {
  const [search, setSearch] = useState('');
  const [contentType, setContentType] = useState<'all' | 'money_update' | 'money_update_template'>('all');
  const [status, setStatus] = useState('all');
  const [jurisdiction, setJurisdiction] = useState('all');
  const [compliance, setCompliance] = useState('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<MoneyUpdateListItem[]>([]);
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
      if (contentType !== 'all') qp.set('type', contentType);
      if (status !== 'all') qp.set('status', status);
      if (jurisdiction !== 'all') qp.set('jurisdiction', jurisdiction);
      if (compliance !== 'all') qp.set('compliance', compliance);
      if (page > 1) qp.set('page', String(page));
      const res = await fetch(`/api/admin/resources/money-updates?${qp.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "We couldn't load Money Updates. Try again.");
      setItems(json.data.items);
      setTotal(json.data.total);
      setPageSize(json.data.pageSize);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [search, contentType, status, jurisdiction, compliance, page]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, reloadToken]);

  const hasFilters = search !== '' || contentType !== 'all' || status !== 'all' || jurisdiction !== 'all' || compliance !== 'all';

  function editHref(item: MoneyUpdateListItem) {
    return `/admin/resources/money-updates/${item.id}/edit`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Money Updates</h1>
          <p className="mt-1 text-sm text-muted">Governed interpretation of important financial developments — not generic news.</p>
        </div>
        {canCreate && (
          <Link href="/admin/resources/money-updates/new" className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            New Money Update
          </Link>
        )}
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" aria-label="Search Money Updates" placeholder="Search title or summary…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-56 rounded border border-line bg-white px-3 py-1.5 text-sm text-ink" />
          <select aria-label="Filter by type" className={selectClass} value={contentType} onChange={(e) => { setContentType(e.target.value as typeof contentType); setPage(1); }}>
            <option value="all">Updates + Templates</option>
            <option value="money_update">Money Updates only</option>
            <option value="money_update_template">Templates only</option>
          </select>
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
          <select aria-label="Filter by compliance classification" className={selectClass} value={compliance} onChange={(e) => { setCompliance(e.target.value); setPage(1); }}>
            <option value="all">All compliance</option>
            {COMPLIANCE_VALUES.map((c) => (
              <option key={c} value={c}>{COMPLIANCE_LABELS[c]}</option>
            ))}
          </select>
          {hasFilters && (
            <button type="button" onClick={() => { setSearch(''); setContentType('all'); setStatus('all'); setJurisdiction('all'); setCompliance('all'); setPage(1); }} className="text-sm font-semibold text-trust hover:underline">
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
              title={hasFilters ? 'No Money Updates match these filters.' : 'No Money Updates have been created yet.'}
              message={hasFilters ? 'Try adjusting or clearing your filters.' : 'Create your first Money Update.'}
              action={canCreate && !hasFilters ? { label: 'New Money Update', onClick: () => (window.location.href = '/admin/resources/money-updates/new') } : undefined}
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3 font-semibold">Title</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Jurisdiction</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">Event Date</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Compliance</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Review/Expiry</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Updated</th>
                      <th scope="col" className="py-2 pl-3 font-semibold"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((m) => (
                      <tr key={m.id} className="border-b border-line/60 hover:bg-gray-50">
                        <td className="max-w-[260px] py-2.5 pr-3">
                          <Link href={editHref(m)} className="font-medium text-ink hover:text-trust hover:underline">
                            {m.title}
                          </Link>
                          {isReviewDue(m) && <span className="ml-2 inline-block rounded-full bg-risk/10 px-2 py-0.5 text-xs font-semibold text-risk">Review Due</span>}
                        </td>
                        <td className="hidden py-2.5 pr-3 lg:table-cell"><ResourceJurisdictionBadge jurisdiction={m.jurisdiction} /></td>
                        <td className="hidden py-2.5 pr-3 text-muted md:table-cell">{formatAdminDate(m.event_date)}</td>
                        <td className="py-2.5 pr-3"><ResourceStatusBadge status={m.status} /></td>
                        <td className="py-2.5 pr-3"><ResourceComplianceBadge compliance={m.compliance_classification} /></td>
                        <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{formatAdminDate(m.next_review_at ?? m.expires_at)}</td>
                        <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{formatAdminDate(m.updated_at)}</td>
                        <td className="py-2.5 pl-3 text-right">
                          <Link href={editHref(m)} className="text-xs font-semibold text-trust hover:underline" aria-label={`Edit "${m.title}"`}>
                            Edit
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-2 sm:hidden">
                {items.map((m) => (
                  <li key={m.id} className="rounded-card border border-line p-3">
                    <Link href={editHref(m)} className="font-medium text-ink hover:text-trust hover:underline">
                      {m.title}
                    </Link>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <ResourceStatusBadge status={m.status} />
                      <ResourceComplianceBadge compliance={m.compliance_classification} />
                      <ResourceJurisdictionBadge jurisdiction={m.jurisdiction} />
                      {isReviewDue(m) && <span className="inline-block rounded-full bg-risk/10 px-2 py-0.5 text-xs font-semibold text-risk">Review Due</span>}
                    </div>
                    <p className="mt-2 text-xs text-muted">Event {formatAdminDate(m.event_date)} · Updated {formatAdminDate(m.updated_at)}</p>
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
