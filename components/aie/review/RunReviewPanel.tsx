'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ResourceEmptyState, ResourceErrorState, ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EvidenceValue } from './EvidenceReveal';
import { CorrectionForm, type CorrectableFieldSpec } from './CorrectionForm';
import { ariaLiveAnnouncementForRevalidation, textEquivalentForEvidenceRef } from '@/lib/aie/review/ariaLabels';
import { OWNER_OPTIONS } from '@/lib/constants';

interface CandidateView {
  fieldName: string;
  displayValue: string | null;
  isNull: boolean;
  userCorrected: boolean;
}

interface ItemView {
  id: string;
  reasonCode: string;
  itemVersion: number;
  meta: {
    humanQuestion: string;
    explanation: string;
    allowedActions: string[];
    correctableFields?: CorrectableFieldSpec[];
  };
  evidenceRef: Record<string, unknown> | null;
}

interface RunDetail {
  summary: {
    runId: string;
    userState: string;
    moduleLabel: string;
    displayFilename: string | null;
    openBlockingItemCount: number;
  };
  candidates: CandidateView[];
  summaryFieldOrder: string[];
  items: ItemView[];
  integrationTested: boolean;
}

function fieldLabel(fieldName: string): string {
  // A small, honest fallback: turn camelCase into words rather than
  // showing a raw internal field key (ITEM-01's spirit applied to
  // candidate labels too, not just reason codes).
  return fieldName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function idempotencyKey(prefix: string): string {
  return `${prefix}:${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36)}`;
}

async function fetchRunDetail(runId: string): Promise<{ detail: RunDetail } | { error: string }> {
  try {
    const res = await fetch(`/api/aie/review/runs/${runId}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.message ?? body?.error ?? 'Could not load this document.' };
    return { detail: body.data };
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' };
  }
}

export function RunReviewPanel({ runId }: { runId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [ownerRole, setOwnerRole] = useState<string>('self');
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const liveRegionRef = useRef<HTMLDivElement>(null);

  // Reused by every action handler below (submitCorrection, accept,
  // reject) to refresh after a server mutation — those are event-handler
  // callbacks, not effect bodies, so calling this directly there is fine.
  // The mount/retry load itself runs via the cancelled-flag effect beneath
  // it (matching `ReviewInbox.tsx` / `ReviewWorkspace.tsx`'s convention).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchRunDetail(runId);
    if ('error' in result) setError(result.error);
    else setDetail(result.detail);
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const result = await fetchRunDetail(runId);
      if (cancelled) return;
      if ('error' in result) setError(result.error);
      else setDetail(result.detail);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, retryToken]);

  async function submitCorrection(item: ItemView, fieldName: string, rawValue: string) {
    setBusyItemId(item.id);
    setItemErrors((prev) => ({ ...prev, [item.id]: '' }));
    try {
      const res = await fetch(`/api/aie/review/items/${item.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'correct', fieldName, rawValue, itemVersion: item.itemVersion, idempotencyKey: idempotencyKey(`${item.id}:correct`) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setItemErrors((prev) => ({ ...prev, [item.id]: body?.message ?? 'That value could not be saved.' }));
        return;
      }
      const revalidation = body.data.revalidation as { runStatus: 'unresolved' | 'awaiting_acceptance'; openBlockingItemCount: number } | null;
      if (revalidation) {
        setAnnouncement(ariaLiveAnnouncementForRevalidation(revalidation));
      }
      await load();
    } catch {
      setItemErrors((prev) => ({ ...prev, [item.id]: 'Could not reach the server.' }));
    } finally {
      setBusyItemId(null);
    }
  }

  async function submitItemAction(item: ItemView, action: 'not_present' | 'defer') {
    setBusyItemId(item.id);
    try {
      const res = await fetch(`/api/aie/review/items/${item.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, itemVersion: item.itemVersion, idempotencyKey: idempotencyKey(`${item.id}:${action}`) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setItemErrors((prev) => ({ ...prev, [item.id]: body?.message ?? 'That could not be recorded.' }));
        return;
      }
      const revalidation = body.data.revalidation as { runStatus: 'unresolved' | 'awaiting_acceptance'; openBlockingItemCount: number } | null;
      if (revalidation) setAnnouncement(ariaLiveAnnouncementForRevalidation(revalidation));
      await load();
    } finally {
      setBusyItemId(null);
    }
  }

  async function confirmAccept() {
    setAccepting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/aie/review/runs/${runId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerHouseholdRole: ownerRole, idempotencyKey: idempotencyKey(`${runId}:accept`) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(body?.message ?? 'This document could not be accepted.');
        return;
      }
      setShowAcceptConfirm(false);
      await load();
    } catch {
      setActionError('Could not reach the server.');
    } finally {
      setAccepting(false);
    }
  }

  async function confirmReject() {
    setRejecting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/aie/review/runs/${runId}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(body?.message ?? 'This document could not be declined.');
        return;
      }
      setShowRejectConfirm(false);
      router.push('/aie-review');
    } catch {
      setActionError('Could not reach the server.');
    } finally {
      setRejecting(false);
    }
  }

  if (loading) return <ResourceLoadingSkeleton label="Loading this document" />;
  if (error) return <ResourceErrorState message={error} title="We couldn&apos;t load this document." onRetry={() => setRetryToken((t) => t + 1)} />;
  if (!detail) return <ResourceEmptyState title="Not found" message="This document could not be found, or you do not have access to it." />;

  const { summary, candidates, summaryFieldOrder, items, integrationTested } = detail;
  const isClean = summary.userState === 'ready_to_accept';
  const candidateByField = new Map(candidates.map((c) => [c.fieldName, c]));

  return (
    <div className="space-y-4">
      {/* A11Y-06: a single polite live region announces revalidation
          results — never the raw backend state name (IA-07). */}
      <div ref={liveRegionRef} role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <h2 className="text-lg font-semibold text-ink">{summary.displayFilename ?? `${summary.moduleLabel} document`}</h2>
        <p className="text-sm text-muted">{summary.moduleLabel}</p>
        {!integrationTested && (
          <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This document type&apos;s review rendering is design-only and has not been run against a real document in this build.
          </p>
        )}
      </div>

      {isClean && (
        <div className="rounded-card border border-line bg-white p-4">
          <h3 className="text-sm font-semibold text-ink">Summary</h3>
          <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {summaryFieldOrder.map((fieldName) => {
              const c = candidateByField.get(fieldName);
              if (!c) return null;
              return (
                <div key={fieldName}>
                  <dt className="text-xs text-muted">{fieldLabel(fieldName)}</dt>
                  <dd className="text-sm text-ink">
                    <EvidenceValue runId={runId} value={c.displayValue} />
                    {c.userCorrected && <span className="ml-1 text-xs text-trust">(your correction)</span>}
                  </dd>
                </div>
              );
            })}
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label htmlFor="owner-role" className="text-xs font-semibold text-ink">
              Whose item is this?
            </label>
            <select id="owner-role" value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)} className="min-h-11 rounded border border-line px-2 text-sm">
              {OWNER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => setShowAcceptConfirm(true)} className="min-h-11 rounded bg-trust px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
              Accept and save
            </button>
            <button type="button" onClick={() => setShowRejectConfirm(true)} className="min-h-11 rounded border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-gray-50">
              Decline this document
            </button>
          </div>
          {actionError && (
            <p role="alert" className="mt-2 text-sm text-risk">
              {actionError}
            </p>
          )}
        </div>
      )}

      {!isClean && items.length > 0 && (
        <ul className="space-y-3" aria-label="Items needing your review">
          {items.map((item) => (
            <li key={item.id} className="rounded-card border border-line bg-white p-4">
              <p className="text-sm font-semibold text-ink">{item.meta.humanQuestion}</p>
              <p className="mt-1 text-sm text-muted">{item.meta.explanation}</p>
              <p className="mt-2 text-xs text-muted">{textEquivalentForEvidenceRef(item.evidenceRef)}</p>

              {item.meta.allowedActions.includes('correct') && item.meta.correctableFields && item.meta.correctableFields.length > 0 && (
                <CorrectionForm
                  fields={item.meta.correctableFields}
                  submitting={busyItemId === item.id}
                  error={itemErrors[item.id] || null}
                  onSubmit={(fieldName, rawValue) => submitCorrection(item, fieldName, rawValue)}
                />
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {item.meta.allowedActions.includes('not_present') && (
                  <button type="button" disabled={busyItemId === item.id} onClick={() => submitItemAction(item, 'not_present')} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50 disabled:opacity-50">
                    Not on this document
                  </button>
                )}
                {item.meta.allowedActions.includes('defer') && (
                  <button type="button" disabled={busyItemId === item.id} onClick={() => submitItemAction(item, 'defer')} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50 disabled:opacity-50">
                    Decide later
                  </button>
                )}
              </div>
            </li>
          ))}

          <li className="flex gap-2">
            <button type="button" onClick={() => setShowRejectConfirm(true)} className="min-h-11 rounded border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-gray-50">
              Decline this document
            </button>
          </li>
        </ul>
      )}

      {!isClean && items.length === 0 && summary.userState === 'processing' && (
        <ResourceEmptyState title="Still processing" message="We're rechecking this document. This page will update automatically once it's ready." />
      )}

      <ConfirmDialog
        open={showAcceptConfirm}
        title="Accept and save this document?"
        message="This will save the extracted details to your records. This action cannot be undone from here."
        confirmLabel={accepting ? 'Saving…' : 'Accept and save'}
        destructive={false}
        confirmDisabled={accepting}
        onConfirm={confirmAccept}
        onCancel={() => setShowAcceptConfirm(false)}
      />
      <ConfirmDialog
        open={showRejectConfirm}
        title="Decline this document?"
        message="This document will not be saved to your records. You can upload it again later if needed."
        confirmLabel={rejecting ? 'Declining…' : 'Decline document'}
        destructive
        confirmDisabled={rejecting}
        onConfirm={confirmReject}
        onCancel={() => setShowRejectConfirm(false)}
      />
    </div>
  );
}
