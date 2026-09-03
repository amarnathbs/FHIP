'use client';

// R1.6 CTA Library list — spec §42.
//
// Admin A0.2 Wave 5:
//   §10 Deactivating a CTA removes it from every public page that uses it,
//       and was a single unconfirmed click. It now confirms, naming the CTA
//       and the effect.
//   §9  Neither activating nor deactivating gave any confirmation, and a
//       403 rendered in the red "Try again" panel with a Retry that could
//       never succeed.
//   §8  A search returning nothing showed "No CTAs have been created yet. /
//       Create your first CTA." — factually wrong and misleading. The empty
//       state is now filter-aware, the way the FAQ list already was.
//   §11 The row action's accessible name was the bare word "Deactivate" on
//       every row, and there was no result count or announcement.
//   §12 The table had no fallback below `sm`, so a 320px viewport had to
//       scroll a five-column table containing a URL.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { ResourceLoadingSkeleton, ResourceEmptyState, ResourceFailureState } from '@/components/resources/admin/ResourceStates';
import { actionFailureMessage, failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import { CTA_DESTINATION_TYPE_LABELS } from '@/lib/resources/cta/types';
import type { CtaRow, CtaDestinationType } from '@/lib/resources/cta/types';

export function CtaListClient({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<CtaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<CtaRow | null>(null);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const qp = new URLSearchParams();
      if (search) qp.set('q', search);
      const res = await fetch(`/api/admin/resources/ctas?${qp.toString()}`);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        setFailure(failureFromResponse(res.status, json, 'the CTA library'));
        setItems([]);
        return;
      }
      const data = json?.data as { items?: CtaRow[] } | undefined;
      setItems(data?.items ?? []);
    } catch (e) {
      setFailure(failureFromThrown(e, 'the CTA library'));
      setItems([]);
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

  async function applyToggle(cta: CtaRow) {
    setToggling(cta.id);
    clearOutcome();
    try {
      const res = await fetch(`/api/admin/resources/ctas/${cta.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !cta.is_active }),
      });
      if (!res.ok) {
        const json = await readJsonSafely(res);
        reportFailure(actionFailureMessage(res.status, json, cta.is_active ? 'deactivate this CTA' : 'activate this CTA'));
        return;
      }
      reportSuccess(
        cta.is_active
          ? `"${cta.label}" is now inactive. It has been removed from every public page that used it.`
          : `"${cta.label}" is now active and will appear on the content it is attached to.`
      );
      setReloadToken((t) => t + 1);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setToggling(null);
    }
  }

  const hasFilters = search.trim().length > 0;

  const activeBadge = (cta: CtaRow) => (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${cta.is_active ? 'bg-positive/10 text-positive' : 'bg-gray-100 text-gray-600'}`}>
      {cta.is_active ? 'Active' : 'Inactive'}
    </span>
  );

  const toggleButton = (cta: CtaRow) =>
    canManage ? (
      <button
        type="button"
        disabled={toggling === cta.id}
        onClick={() => setPendingToggle(cta)}
        aria-label={`${cta.is_active ? 'Deactivate' : 'Activate'} the CTA "${cta.label}"`}
        className="min-h-11 text-xs font-semibold text-trust hover:underline disabled:opacity-50"
      >
        {toggling === cta.id ? 'Working…' : cta.is_active ? 'Deactivate' : 'Activate'}
      </button>
    ) : null;

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={!!pendingToggle}
        title={pendingToggle?.is_active ? 'Deactivate this CTA?' : 'Activate this CTA?'}
        message={
          pendingToggle
            ? pendingToggle.is_active
              ? `"${pendingToggle.label}" will immediately stop appearing on every public page that uses it. Nothing is deleted — you can activate it again at any time.`
              : `"${pendingToggle.label}" will start appearing on every published page it is attached to.`
            : ''
        }
        confirmLabel={pendingToggle?.is_active ? 'Deactivate' : 'Activate'}
        cancelLabel="Cancel"
        destructive={!!pendingToggle?.is_active}
        onConfirm={() => {
          const cta = pendingToggle;
          setPendingToggle(null);
          if (cta) void applyToggle(cta);
        }}
        onCancel={() => setPendingToggle(null)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">CTAs</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">Controlled calls-to-action that bridge education to FHIP action. No financial advice, no AI-personalised CTAs.</p>
        </div>
        {canManage && (
          <Link href="/admin/resources/ctas/new" className="inline-flex min-h-11 items-center rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            New CTA
          </Link>
        )}
      </div>

      <AdminTaskHelp taskId="ADM-15" />

      <div className="rounded-card border border-line bg-white p-4">
        <label htmlFor="cta-search" className="sr-only">
          Search CTAs
        </label>
        <input
          id="cta-search"
          type="search"
          placeholder="Search name or label…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded border border-line bg-white px-3 py-1.5 text-sm text-ink"
        />

        <AdminActionStatus outcome={outcome} className="mt-3" />

        <p role="status" aria-live="polite" className="mt-3 text-xs text-muted">
          {loading || failure ? '' : `${items.length} ${items.length === 1 ? 'CTA' : 'CTAs'} shown.`}
        </p>

        <div className="mt-2">
          {loading ? (
            <ResourceLoadingSkeleton label="Loading CTAs" />
          ) : failure ? (
            <ResourceFailureState failure={failure} onRetry={() => setReloadToken((t) => t + 1)} />
          ) : items.length === 0 ? (
            <ResourceEmptyState
              title={hasFilters ? 'No CTAs match this search.' : 'No CTAs have been created yet.'}
              message={hasFilters ? 'Try a different name or label.' : 'Create your first CTA.'}
              action={canManage && !hasFilters ? { label: 'New CTA', onClick: () => router.push('/admin/resources/ctas/new') } : undefined}
            />
          ) : (
            <>
              {/* `relative` — the sr-only caption and "Actions" heading are
                  position:absolute; see ResourceContentTable. */}
              <div className="relative hidden overflow-x-auto sm:block">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Calls to action, their destinations and whether they are currently active</caption>
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
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((cta) => (
                      <tr key={cta.id} className="border-b border-line/60 hover:bg-gray-50">
                        <th scope="row" className="max-w-[220px] py-2.5 pr-3 text-left font-normal">
                          {canManage ? (
                            <Link href={`/admin/resources/ctas/${cta.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                              {cta.label}
                            </Link>
                          ) : (
                            <span className="font-medium text-ink">{cta.label}</span>
                          )}
                          <span className="block text-xs text-muted">{cta.name}</span>
                        </th>
                        <td className="py-2.5 pr-3 text-muted">{CTA_DESTINATION_TYPE_LABELS[cta.destination_type as CtaDestinationType]}</td>
                        <td className="max-w-[240px] truncate py-2.5 pr-3 text-muted" title={cta.destination_url}>
                          {cta.destination_url}
                        </td>
                        <td className="py-2.5 pr-3">{activeBadge(cta)}</td>
                        <td className="py-2.5 pl-3 text-right">{toggleButton(cta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="space-y-2 sm:hidden">
                {items.map((cta) => (
                  <li key={cta.id} className="rounded-compact border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {canManage ? (
                        <Link href={`/admin/resources/ctas/${cta.id}/edit`} className="font-medium text-ink hover:text-trust hover:underline">
                          {cta.label}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{cta.label}</span>
                      )}
                      {activeBadge(cta)}
                    </div>
                    <p className="mt-1 text-xs text-muted">{cta.name}</p>
                    <p className="mt-1 text-xs text-muted">{CTA_DESTINATION_TYPE_LABELS[cta.destination_type as CtaDestinationType]}</p>
                    <p className="mt-1 break-all text-xs text-muted">{cta.destination_url}</p>
                    <div className="mt-2">{toggleButton(cta)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
