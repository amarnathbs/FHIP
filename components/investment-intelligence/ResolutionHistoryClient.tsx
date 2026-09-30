'use client';

import { useCallback, useEffect, useState } from 'react';
import { fmtDate, fmtDateTime } from './dateDisplay';

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
  declaredOwnerName: string | null;
  matchedOwnerName: string | null;
  maskedHolderName: string | null;
  outcomeKind: string | null;
  reason: string | null;
  accountCurrencyCode: string | null;
}

interface HouseholdMemberOption {
  id: string;
  full_name: string;
  relationship: string;
  is_active: boolean;
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
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMemberOption[] | null>(null);
  const [amendingId, setAmendingId] = useState<string | null>(null);
  const [selectedMemberByCase, setSelectedMemberByCase] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [amendError, setAmendError] = useState<Record<string, string>>({});
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
    void load();
  }, [load]);

  async function ensureHouseholdMembersLoaded() {
    if (householdMembers !== null) return;
    try {
      const res = await fetch('/api/household-members');
      const json = await res.json();
      setHouseholdMembers(res.ok ? (json.data ?? []) : []);
    } catch {
      setHouseholdMembers([]);
    }
  }

  async function startAmend(caseId: string) {
    setAmendingId(caseId);
    setAmendError((prev) => ({ ...prev, [caseId]: '' }));
    setAmendSuccess((prev) => ({ ...prev, [caseId]: '' }));
    await ensureHouseholdMembersLoaded();
  }

  async function submitAmend(caseId: string) {
    const ownerMemberId = selectedMemberByCase[caseId];
    if (!ownerMemberId) return;
    setSubmittingId(caseId);
    setAmendError((prev) => ({ ...prev, [caseId]: '' }));
    try {
      const res = await fetch(`/api/investment-intelligence/resolutions/${encodeURIComponent(caseId)}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerMemberId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not record that amendment.');
      setAmendingId(null);
      setAmendSuccess((prev) => ({ ...prev, [caseId]: 'Amended — the account owner has been updated.' }));
      await load();
    } catch (e) {
      setAmendError((prev) => ({ ...prev, [caseId]: e instanceof Error ? e.message : 'Could not record that amendment.' }));
    } finally {
      setSubmittingId(null);
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
                  {item.resolutionMethod === 'user_amended_owner' ? 'Amended to' : 'Assigned to'} <strong>{item.resolvedOwnerName ?? '(unknown member)'}</strong>
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
                {item.amendable && !item.isSuperseded && amendingId === item.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-xs text-muted" htmlFor={`amend-select-${item.id}`}>
                      Correct owner to:
                    </label>
                    <select
                      id={`amend-select-${item.id}`}
                      className="rounded-md border px-2 py-1 text-xs"
                      value={selectedMemberByCase[item.id] ?? ''}
                      onChange={(e) => setSelectedMemberByCase((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      disabled={householdMembers === null}
                    >
                      <option value="">{householdMembers === null ? 'Loading…' : 'Choose a household member'}</option>
                      {(householdMembers ?? [])
                        .filter((m) => m.is_active)
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.full_name} ({m.relationship})
                          </option>
                        ))}
                    </select>
                    <button
                      onClick={() => void submitAmend(item.id)}
                      disabled={!selectedMemberByCase[item.id] || submittingId === item.id}
                      className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                    >
                      {submittingId === item.id ? 'Saving…' : 'Save amendment'}
                    </button>
                    <button onClick={() => setAmendingId(null)} className="rounded-md border px-2 py-1 text-xs text-muted">
                      Cancel
                    </button>
                  </div>
                )}
                {amendError[item.id] && <p className="mt-1 text-xs text-red-600">{amendError[item.id]}</p>}
                {amendSuccess[item.id] && <p className="mt-1 text-xs text-green-700">{amendSuccess[item.id]}</p>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
