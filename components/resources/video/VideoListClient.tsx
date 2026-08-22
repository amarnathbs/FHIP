'use client';

// R1.4 Video list — spec §13. Metadata-only columns (no transcript/chapters
// — spec §124). Reuses R1.2's states/pagination components.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceJurisdictionBadge } from '@/components/resources/admin/ResourceBadges';
import { ResourcePagination } from '@/components/resources/admin/ResourcePagination';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { JURISDICTION_LABELS, JURISDICTION_VALUES, COMPLIANCE_LABELS, COMPLIANCE_VALUES, STATUS_LABELS, STATUS_VALUES, formatAdminDate } from '@/lib/resources/admin/labels';
import { buildYouTubeThumbnailUrl } from '@/lib/resources/video/youtube';
import type { VideoListItem } from '@/lib/resources/video/queries';

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const selectClass = 'rounded border border-line bg-white px-2 py-1.5 text-sm text-ink';

export function VideoListClient({ canCreate }: { canCreate: boolean }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [jurisdiction, setJurisdiction] = useState('all');
  const [compliance, setCompliance] = useState('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<VideoListItem[]>([]);
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
      if (compliance !== 'all') qp.set('compliance', compliance);
      if (page > 1) qp.set('page', String(page));
      const res = await fetch(`/api/admin/resources/videos?${qp.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "We couldn't load Videos. Try again.");
      setItems(json.data.items);
      setTotal(json.data.total);
      setPageSize(json.data.pageSize);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [search, status, jurisdiction, compliance, page]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, reloadToken]);

  const hasFilters = search !== '' || status !== 'all' || jurisdiction !== 'all' || compliance !== 'all';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Videos</h1>
          <p className="mt-1 text-sm text-muted">
            @GKTC-hosted video content. FHIP stores metadata and embeds; YouTube remains the source-of-truth host.
          </p>
        </div>
        {canCreate && (
          <Link href="/admin/resources/videos/new" className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            Add @GKTC Video
          </Link>
        )}
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" aria-label="Search Videos" placeholder="Search title or YouTube ID…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-56 rounded border border-line bg-white px-3 py-1.5 text-sm text-ink" />
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
            <button type="button" onClick={() => { setSearch(''); setStatus('all'); setJurisdiction('all'); setCompliance('all'); setPage(1); }} className="text-sm font-semibold text-trust hover:underline">
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
              title={hasFilters ? 'No videos match these filters.' : 'No @GKTC videos have been added yet.'}
              message={hasFilters ? 'Try adjusting or clearing your filters.' : 'Add a video by entering its YouTube URL or video ID.'}
              action={canCreate && !hasFilters ? { label: 'Add @GKTC Video', onClick: () => (window.location.href = '/admin/resources/videos/new') } : undefined}
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3 font-semibold">Thumbnail</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Title</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">YouTube ID</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Duration</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold lg:table-cell">Jurisdiction</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold xl:table-cell">Category</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Status</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Compliance</th>
                      <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Updated</th>
                      <th scope="col" className="py-2 pl-3 font-semibold"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((v) => {
                      const thumb = v.thumbnail_url || buildYouTubeThumbnailUrl(v.youtube_video_id);
                      return (
                        <tr key={v.id} className="border-b border-line/60 hover:bg-gray-50">
                          <td className="py-2.5 pr-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {thumb ? <img src={thumb} alt="" className="h-10 w-16 rounded object-cover" /> : <span className="text-xs text-muted">—</span>}
                          </td>
                          <td className="max-w-[240px] py-2.5 pr-3">
                            <Link href={`/admin/resources/videos/${v.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                              {v.title}
                            </Link>
                          </td>
                          <td className="hidden py-2.5 pr-3 text-muted md:table-cell">{v.youtube_video_id}</td>
                          <td className="hidden py-2.5 pr-3 text-muted lg:table-cell">{formatDuration(v.duration_seconds)}</td>
                          <td className="hidden py-2.5 pr-3 lg:table-cell"><ResourceJurisdictionBadge jurisdiction={v.jurisdiction} /></td>
                          <td className="hidden py-2.5 pr-3 text-muted xl:table-cell">{v.primary_category?.name ?? '—'}</td>
                          <td className="py-2.5 pr-3"><ResourceStatusBadge status={v.status} /></td>
                          <td className="py-2.5 pr-3"><ResourceComplianceBadge compliance={v.compliance_classification} /></td>
                          <td className="hidden py-2.5 pr-3 text-muted sm:table-cell">{formatAdminDate(v.updated_at)}</td>
                          <td className="py-2.5 pl-3 text-right">
                            <Link href={`/admin/resources/videos/${v.id}/edit`} className="text-xs font-semibold text-trust hover:underline" aria-label={`Edit "${v.title}"`}>
                              Edit
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-2 sm:hidden">
                {items.map((v) => (
                  <li key={v.id} className="rounded-card border border-line p-3">
                    <Link href={`/admin/resources/videos/${v.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                      {v.title}
                    </Link>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <ResourceStatusBadge status={v.status} />
                      <ResourceComplianceBadge compliance={v.compliance_classification} />
                      <ResourceJurisdictionBadge jurisdiction={v.jurisdiction} />
                    </div>
                    <p className="mt-2 text-xs text-muted">Updated {formatAdminDate(v.updated_at)}</p>
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
