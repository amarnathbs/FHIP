'use client';

import { useCallback, useEffect, useState } from 'react';
import { fmtDate, fmtDateTime } from './dateDisplay';
import { OwnerChangeDialog, type OwnerSubmitResult } from './OwnerChangeDialog';
import { apiErrorMessage, type OwnerSelectionBody, type OwnershipView } from './ownerChange';

// 2026-09-28 owner-exception unification, item 4 of the Product Owner's
// decision: the "Resolutions" tab becomes a HISTORY + AMENDMENT view, not
// an active-decision surface competing with the Review tab
// (ReviewCentreClient.tsx remains the single place OPEN exceptions are
// decided). This reads `GET /api/investment-intelligence/resolutions`
// (decided ii_reconciliation_cases, newest first) and, for the
// owner_unmatched/owner_mismatch types, offers "Amend" — re-deciding who a
// statement's account belongs to, without ever mutating the original
// decision (see the /amend route's header for the supersession discipline
// this mirrors from PC5's own K.18).
//
// 2026-10-01: an amendment (and the original decision shown here) can now be
// a household member, a trust / HUF / company, or a joint split with
// percentages -- chosen in OwnerChangeDialog, whose second step is an explicit
// confirmation. A decided joint-holding case is amendable too (to another
// joint split). The history row for an entity / joint decision shows the
// owners with their shares, never raw ids.

interface ResolutionItem {
  id: string;
  subjectType: string;
  subjectId: string;
  discrepancyType: string;
  status: string;
  openedAt: string;
  resolvedAt: string | null;
  resolutionMethod: string | null;
  resolvedByActorType: string | null;
  accountLabel: string | null;
  amendable: boolean;
  amendsCaseId: string | null;
  isSuperseded: boolean;
  resolvedOwnerName: string | null;
  previousOwnerName: string | null;
  resolvedOwner?: OwnershipView | null;
  previousOwner?: OwnershipView | null;
  matchedMemberIds?: string[];
  declaredOwnerName: string | null;
  matchedOwnerName: string | null;
  maskedHolderName: string | null;
  outcomeKind: string | null;
  reason: string | null;
  accountCurrencyCode: string | null;
}

const DISCREPANCY_LABEL: Record<string, string> = {
  owner_unmatched: 'No owner declared',
  owner_mismatch: 'Owner did not match statement',
  joint_holding_allocation_required: 'Joint holding',
};

export function ResolutionHistoryClient() {
  const [items, setItems] = useState<ResolutionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amendingId, setAmendingId] = useState<string | null>(null);
  const [amendSuccess, setAmendSuccess] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/investment-intelligence/resolutions');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load resolution history');
      setItems(json.data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load resolution history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  function startAmend(caseId: string) {
    setAmendingId(caseId);
    setAmendSuccess((prev) => ({ ...prev, [caseId]: '' }));
  }

  // `confirm: true` is the explicit confirmation from the dialog's second step.
  async function submitAmend(caseId: string, owner: OwnerSelectionBody): Promise<OwnerSubmitResult> {
    try {
      const res = await fetch(`/api/investment-intelligence/resolutions/${encodeURIComponent(caseId)}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, confirm: true }),
      });
      const json = await res.json();
      if (!res.ok) return { ok: false, error: apiErrorMessage(json, 'Could not record that amendment.') };
      setAmendSuccess((prev) => ({ ...prev, [caseId]: 'Amended — the owner has been updated and the earlier decision is kept in history.' }));
      await load();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not record that amendment.' };
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">Decisions already made on statement/owner exceptions. Open questions are decided on the Review tab.</p>
        <button onClick={() => void load()} className="rounded-md border px-3 py-1 text-sm text-muted">
          Refresh
        </button>
      </div>

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && items.length === 0 && <p className="text-sm text-muted">No decisions have been recorded yet.</p>}

      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className={`rounded-lg border p-4 ${item.isSuperseded ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{item.status === 'resolved' ? 'Resolved' : 'Dismissed'}</span>
                  <span className="text-xs uppercase tracking-wide text-muted">{DISCREPANCY_LABEL[item.discrepancyType] ?? item.discrepancyType.replace(/_/g, ' ')}</span>
                  {item.isSuperseded && <span className="text-xs text-amber-700">· superseded by a later amendment</span>}
                </div>
                <h3 className="mt-1 font-medium text-ink">{item.accountLabel ?? 'Statement exception'}</h3>
                {item.maskedHolderName && <p className="mt-1 text-sm text-muted">Statement printed in the name of {item.maskedHolderName}.</p>}
                <p className="mt-1 text-sm text-muted">
                  {item.resolutionMethod === 'user_amended_owner' ? 'Amended to' : item.resolvedOwner?.kind === 'joint' ? 'Split as' : 'Assigned to'}{' '}
                  <strong>{item.resolvedOwnerName ?? '(unknown owner)'}</strong>
                  {item.resolvedOwner && item.resolvedOwner.kind !== 'joint' && item.resolvedOwner.kind !== 'unassigned' && item.resolvedOwner.owners[0] ? (
                    <span className="text-xs"> ({item.resolvedOwner.owners[0].detail})</span>
                  ) : null}
                  {item.previousOwnerName ? <> — previously {item.previousOwnerName}</> : null}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {item.status === 'resolved' ? 'Resolved' : 'Dismissed'} {item.resolvedAt ? fmtDateTime(item.resolvedAt, item.accountCurrencyCode) : ''} · opened{' '}
                  {fmtDate(item.openedAt, item.accountCurrencyCode)}
                  {item.resolvedByActorType ? ` · by ${item.resolvedByActorType}` : ''}
                </p>

                {item.amendable && !item.isSuperseded && amendingId !== item.id && (
                  <button onClick={() => void startAmend(item.id)} className="mt-2 rounded-md border px-2 py-1 text-xs font-medium text-primary">
                    Amend this decision
                  </button>
                )}
                {item.amendable && !item.isSuperseded && amendingId === item.id && item.subjectType === 'account' && (
                  <OwnerChangeDialog
                    accountId={item.subjectId}
                    accountLabel={item.accountLabel}
                    mode="amend"
                    jointOnly={item.discrepancyType === 'joint_holding_allocation_required'}
                    suggestedJointMemberIds={item.matchedMemberIds ?? []}
                    holderHint={item.maskedHolderName}
                    submit={(owner) => submitAmend(item.id, owner)}
                    onClose={() => setAmendingId(null)}
                    onDone={() => setAmendingId(null)}
                  />
                )}
                {amendSuccess[item.id] && <p className="mt-1 text-xs text-green-700">{amendSuccess[item.id]}</p>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
