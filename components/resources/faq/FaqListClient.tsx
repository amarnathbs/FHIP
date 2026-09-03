'use client';

// R1.4 FAQ list — spec §33.
//
// Admin A0.2 Wave 5:
//   §9  Every non-2xx outcome collapsed into the one red "We couldn't load
//       Resources content. Try again." panel — a 403 offered a Retry that
//       could never succeed, and a non-JSON edge response surfaced a raw
//       `SyntaxError` to the operator. Outcomes are now classified once,
//       centrally, and rendered as the state they actually are.
//   §11 There was no result count, so filtering and paging changed the list
//       with nothing announced; the loading skeleton had no specific label.
//   §17 The page carried no Help affordance.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { ResourceJurisdictionBadge } from '@/components/resources/admin/ResourceBadges';
import { ResourcePagination } from '@/components/resources/admin/ResourcePagination';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceFailureState } from '@/components/resources/admin/ResourceStates';
import { failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import { JURISDICTION_LABELS, JURISDICTION_VALUES, formatAdminDate } from '@/lib/resources/admin/labels';
import type { FaqListItem } from '@/lib/resources/faq/queries';

const selectClass = 'rounded border border-line bg-white px-2 py-1.5 text-sm text-ink';

export function FaqListClient({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [jurisdiction, setJurisdiction] = useState('all');
  const [activeOnly, setActiveOnly] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<FaqListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('q', search);
      if (jurisdiction !== 'all') qp.set('jurisdiction', jurisdiction);
      if (activeOnly !== 'all') qp.set('active', activeOnly);
      if (page > 1) qp.set('page', String(page));
      const res = await fetch(`/api/admin/resources/faqs?${qp.toString()}`);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        setFailure(failureFromResponse(res.status, json, 'FAQs'));
        setItems([]);
        setTotal(0);
        return;
      }
      const data = json?.data as { items?: FaqListItem[]; total?: number; pageSize?: number } | undefined;
      setItems(data?.items ?? []);
      setTotal(data?.total ?? 0);
      setPageSize(data?.pageSize ?? 25);
    } catch (e) {
      setFailure(failureFromThrown(e, 'FAQs'));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, jurisdiction, activeOnly, page]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, reloadToken]);

  const hasFilters = search !== '' || jurisdiction !== 'all' || activeOnly !== 'all';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">FAQs</h1>
          <p className="mt-1 text-sm text-muted">Reusable question/answer content, linkable to any Resources post.</p>
        </div>
        {canCreate && (
          <Link href="/admin/resources/faqs/new" className="inline-flex min-h-11 items-center rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            New FAQ
          </Link>
        )}
      </div>

      <AdminTaskHelp taskId="ADM-14" />

      <div className="rounded-card border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" aria-label="Search FAQs" placeholder="Search question or answer…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-56 rounded border border-line bg-white px-3 py-1.5 text-sm text-ink" />
          <select aria-label="Filter by jurisdiction" className={selectClass} value={jurisdiction} onChange={(e) => { setJurisdiction(e.target.value); setPage(1); }}>
            <option value="all">All jurisdictions</option>
            {JURISDICTION_VALUES.map((j) => (
              <option key={j} value={j}>{JURISDICTION_LABELS[j]}</option>
            ))}
          </select>
          <select aria-label="Filter by active state" className={selectClass} value={activeOnly} onChange={(e) => { setActiveOnly(e.target.value as 'all' | 'active' | 'inactive'); setPage(1); }}>
            <option value="all">All (active + inactive)</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
          {hasFilters && (
            <button type="button" onClick={() => { setSearch(''); setJurisdiction('all'); setActiveOnly('all'); setPage(1); }} className="text-sm font-semibold text-trust hover:underline">
              Clear Filters
            </button>
          )}
        </div>

        {/* §11 — the result count is announced, so filtering and paging are
            perceivable without sight. Previously the list simply changed. */}
        <p role="status" aria-live="polite" className="mt-3 text-xs text-muted">
          {loading || failure ? '' : total === 0 ? 'No results.' : `${total} ${total === 1 ? 'FAQ' : 'FAQs'} shown.`}
        </p>

        <div className="mt-2">
          {loading ? (
            <ResourceLoadingSkeleton label="Loading FAQs" />
          ) : failure ? (
            <ResourceFailureState failure={failure} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState
              title={hasFilters ? 'No FAQs match these filters.' : 'No FAQs have been created yet.'}
              message={hasFilters ? 'Try adjusting or clearing your filters.' : 'Create your first FAQ.'}
              action={canCreate && !hasFilters ? { label: 'New FAQ', onClick: () => router.push('/admin/resources/faqs/new') } : undefined}
            />
          ) : (
            <>
              {/* `relative` — see ResourceContentTable for why this is
                  load-bearing rather than cosmetic. */}
              <div className="relative hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3 font-semibold">Question</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">Category</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Jurisdiction</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Active</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Linked</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Updated</th>
                      <th scope="col" className="py-2 pl-3 font-semibold"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((f) => (
                      <tr key={f.id} className="border-b border-line/60 hover:bg-gray-50">
                        <td className="max-w-[280px] py-2.5 pr-3">
                          <Link href={`/admin/resources/faqs/${f.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                            {f.question}
                          </Link>
                        </td>
                        <td className="hidden py-2.5 pr-3 text-muted md:table-cell">{f.category?.name ?? '—'}</td>
                        <td className="hidden py-2.5 pr-3 lg:table-cell"><ResourceJurisdictionBadge jurisdiction={f.jurisdiction} /></td>
                        <td className="py-2.5 pr-3">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${f.is_active ? 'bg-positive/10 text-positive' : 'bg-gray-100 text-gray-500'}`}>{f.is_active ? 'Active' : 'Inactive'}</span>
                        </td>
                        <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{f.linkedCount}</td>
                        <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{formatAdminDate(f.updated_at)}</td>
                        <td className="py-2.5 pl-3 text-right">
                          <Link href={`/admin/resources/faqs/${f.id}/edit`} className="inline-flex min-h-11 items-center text-xs font-semibold text-trust hover:underline" aria-label={`Edit "${f.question}"`}>
                            Edit
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-2 sm:hidden">
                {items.map((f) => (
                  <li key={f.id} className="rounded-card border border-line p-3">
                    {/* break-words — see ResourceContentTable (§12). */}
                    <Link href={`/admin/resources/faqs/${f.id}/edit`} className="block break-words font-medium text-ink hover:text-trust hover:underline">
                      {f.question}
                    </Link>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${f.is_active ? 'bg-positive/10 text-positive' : 'bg-gray-100 text-gray-500'}`}>{f.is_active ? 'Active' : 'Inactive'}</span>
                      <ResourceJurisdictionBadge jurisdiction={f.jurisdiction} />
                    </div>
                    <p className="mt-2 text-xs text-muted">Linked to {f.linkedCount} · Updated {formatAdminDate(f.updated_at)}</p>
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
