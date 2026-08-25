'use client';

// R1.6 CTA Library list — spec §42.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { CTA_DESTINATION_TYPE_LABELS } from '@/lib/resources/cta/types';
import type { CtaRow, CtaDestinationType } from '@/lib/resources/cta/types';

export function CtaListClient({ canManage }: { canManage: boolean }) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<CtaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('q', search);
      const res = await fetch(`/api/admin/resources/ctas?${qp.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load CTAs.');
      setItems(json.data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [load, reloadToken]);

  async function toggleActive(cta: CtaRow) {
    setToggling(cta.id);
    try {
      const res = await fetch(`/api/admin/resources/ctas/${cta.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !cta.is_active }),
      });
      if (!res.ok) throw new Error();
      setReloadToken((t) => t + 1);
    } catch {
      setError('Could not update this CTA. Try again.');
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">CTA Library</h1>
          <p className="mt-1 text-sm text-muted">Controlled calls-to-action that bridge education to FHIP action. No financial advice, no AI-personalised CTAs.</p>
        </div>
        {canManage && (
          <Link href="/admin/resources/ctas/new" className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            New CTA
          </Link>
        )}
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <input type="search" aria-label="Search CTAs" placeholder="Search name or label…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-64 rounded border border-line bg-white px-3 py-1.5 text-sm text-ink" />

        <div className="mt-4">
          {loading ? (
            <ResourceLoadingSkeleton />
          ) : error ? (
            <ResourceErrorState message={error} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState title="No CTAs have been created yet." message="Create your first CTA." action={canManage ? { label: 'New CTA', onClick: () => (window.location.href = '/admin/resources/ctas/new') } : undefined} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Label
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Destination Type
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Destination
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Active
                    </th>
                    <th scope="col" className="py-2 pl-3 font-semibold">
                      <span className="sr-only left-0 top-0">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((cta) => (
                    <tr key={cta.id} className="border-b border-line/60 hover:bg-gray-50">
                      <td className="max-w-[220px] py-2.5 pr-3">
                        {canManage ? (
                          <Link href={`/admin/resources/ctas/${cta.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                            {cta.label}
                          </Link>
                        ) : (
                          <span className="font-medium text-ink">{cta.label}</span>
                        )}
                        <p className="text-xs text-muted">{cta.name}</p>
                      </td>
                      <td className="py-2.5 pr-3 text-muted">{CTA_DESTINATION_TYPE_LABELS[cta.destination_type as CtaDestinationType]}</td>
                      <td className="max-w-[240px] truncate py-2.5 pr-3 text-muted" title={cta.destination_url}>
                        {cta.destination_url}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cta.is_active ? 'bg-positive/10 text-positive' : 'bg-gray-100 text-gray-500'}`}>{cta.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        {canManage && (
                          <button type="button" disabled={toggling === cta.id} onClick={() => toggleActive(cta)} className="text-xs font-semibold text-trust hover:underline disabled:opacity-50">
                            {cta.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
