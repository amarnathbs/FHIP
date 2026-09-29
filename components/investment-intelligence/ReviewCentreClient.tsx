'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// R9 — Review Centre UX (spec sections 56, 59, 134). Sections mirror the
// spec's suggested layout: Overview (severity counts) + a filterable list.
// Values are grouped by review_type (goal/portfolio/performance/sip/
// tax_cost/data_quality) rather than re-derived — every figure shown is
// exactly what the API returned, never recomputed client-side (spec section
// 40, no client-side "AI" or heuristic reclassification).

interface ReviewItem {
  id: string;
  review_type: string;
  category: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  compliance_classification: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  source_module: string;
  as_of_date: string;
  status: string;
  created_at: string;
}

interface HouseholdMemberOption {
  id: string;
  full_name: string;
  relationship: string;
  is_active: boolean;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEVERITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function ReviewCentreClient() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'open' | 'acknowledged' | 'resolved' | 'dismissed'>('open');
  const [error, setError] = useState<string | null>(null);
  // Owner-unmatched reconciliation cases (evidence.discrepancyType ===
  // 'owner_unmatched', subjectType 'account') previously had NO real
  // resolution path from this screen: the generic "Review statement" link
  // (below) always points at the static Statements & data list, and for this
  // case type there is nothing there to act on -- found live 2026-09-28, a
  // dead end for any household whose members were never explicitly set up.
  // `PATCH /api/investment-intelligence/accounts/[id]/owner` already existed
  // and already auto-resolves the matching case; this screen simply never
  // called it. Household members are loaded lazily, only once any open item
  // actually needs them.
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMemberOption[] | null>(null);
  const [selectedMemberByItem, setSelectedMemberByItem] = useState<Record<string, string>>({});
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<Record<string, string>>({});
  // 2026-09-29 "more resolution actions" audit: production data (read-only
  // check, twwpnltizhtjxhamyoxt) showed 'unsupported_document'/
  // 'document_corrupt'/'parse_incomplete' as the next-highest-value real gap
  // after owner_unmatched/owner_mismatch (3 open unsupported_document cases
  // at the time of the audit) -- all three are documents that failed BEFORE
  // any account/transaction was ever created for them (see
  // documentProcessing.ts) and can never succeed on a retry of the same
  // uploaded bytes. "Acknowledge" never told the user that, or that
  // re-uploading a corrected file is the only way forward -- see
  // /api/investment-intelligence/source-documents/[id]/discard's header for
  // the full rationale, including why ambiguous_instrument and the
  // cross_source_* types were checked and found to have ZERO occurrences
  // ever in production, and so were not given a bespoke action here.
  const [discardingItemId, setDiscardingItemId] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<Record<string, string>>({});

  const load = useCallback(async (status: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/investment-intelligence/review?status=${status}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load review items');
      setItems(json.data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load review items');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await load(statusFilter);
      if (cancelled) return;
      void result;
    })();
    return () => {
      cancelled = true;
    };
  }, [statusFilter, load]);

  useEffect(() => {
    const needsMembers = items.some(
      (i) =>
        typeof i.evidence?.discrepancyType === 'string' &&
        (i.evidence.discrepancyType === 'owner_unmatched' || i.evidence.discrepancyType === 'owner_mismatch') &&
        i.evidence.subjectType === 'account'
    );
    if (needsMembers) void ensureHouseholdMembersLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function refresh() {
    setRefreshing(true);
    try {
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } finally {
      setRefreshing(false);
    }
  }

  async function act(id: string, action: 'acknowledge' | 'dismiss') {
    await fetch(`/api/investment-intelligence/review/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    await load(statusFilter);
  }

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

  async function assignOwner(itemId: string, accountId: string) {
    const ownerMemberId = selectedMemberByItem[itemId];
    if (!ownerMemberId) return;
    setAssigningItemId(itemId);
    setAssignError((prev) => ({ ...prev, [itemId]: '' }));
    try {
      const res = await fetch(`/api/investment-intelligence/accounts/${encodeURIComponent(accountId)}/owner`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerMemberId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not assign that owner.');
      // Review items are a materialised snapshot (the same reason `refresh()`
      // above hits /review/refresh before reloading, not just /review) --
      // resolving the underlying ii_reconciliation_cases row does not by
      // itself remove this item from an already-computed "open" list. Found
      // live 2026-09-28: the assignment genuinely succeeded (verified in the
      // database) but the item stayed on screen until a manual "Refresh
      // observations" click, which would have looked like the fix silently
      // failed.
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } catch (e) {
      setAssignError((prev) => ({ ...prev, [itemId]: e instanceof Error ? e.message : 'Could not assign that owner.' }));
    } finally {
      setAssigningItemId(null);
    }
  }

  async function discardDocument(itemId: string, sourceDocumentId: string) {
    if (!window.confirm('This document could not be processed and has no automatic retry path. Discard it? You can re-upload a corrected file afterwards.')) return;
    setDiscardingItemId(itemId);
    setDiscardError((prev) => ({ ...prev, [itemId]: '' }));
    try {
      const res = await fetch(`/api/investment-intelligence/source-documents/${encodeURIComponent(sourceDocumentId)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not discard that document.');
      // Same reason assignOwner() above hits /review/refresh before reloading
      // -- ii_review_items is a materialised snapshot of ii_reconciliation_cases,
      // not the same table, so resolving the case does not by itself remove
      // this item from an already-computed "open" list.
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } catch (e) {
      setDiscardError((prev) => ({ ...prev, [itemId]: e instanceof Error ? e.message : 'Could not discard that document.' }));
    } finally {
      setDiscardingItemId(null);
    }
  }

  const bySeverity = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.severity]: (acc[i.severity] ?? 0) + 1 }), {});

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* II-PC2 responsive fix (spec sections 34, 54): this row of four
            status chips had no flex-wrap, so at 320px it forced the whole
            PAGE to scroll horizontally (measured 395px against a 320px
            viewport). Pre-existing on origin/main — reproduced there with the
            PC2 sub-navigation removed, so this is a genuine baseline defect
            rather than one PC2 introduced. Wrapping is the minimal fix and
            changes nothing above the breakpoint. */}
        <div className="flex flex-wrap gap-2">
          {(['open', 'acknowledged', 'resolved', 'dismissed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1 text-sm ${statusFilter === s ? 'bg-ink text-white' : 'bg-gray-100 text-muted'}`}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button onClick={refresh} disabled={refreshing} className="ml-auto rounded-md border px-3 py-1 text-sm text-muted disabled:opacity-50">
          {refreshing ? 'Refreshing…' : 'Refresh observations'}
        </button>
      </div>

      {statusFilter === 'open' && (
        <div className="mb-4 flex gap-3 text-sm">
          {(['high', 'medium', 'low', 'info'] as const).map((sev) => (
            <span key={sev} className="rounded-md bg-gray-50 px-2 py-1">
              {SEVERITY_LABEL[sev]}: {counts[sev] ?? 0}
            </span>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && bySeverity.length === 0 && <p className="text-sm text-muted">No {statusFilter} review items right now.</p>}

      <ul className="space-y-3">
        {bySeverity.map((item) => {
          // PC4 section 19: neither Acknowledge nor Dismiss resolves the
          // underlying reconciliation issue — they only change this review
          // item's own bookkeeping status. A person reading only the button
          // labels has no way to know that, so this must say so explicitly
          // rather than implying either action fixes anything. Where a
          // genuine self-service resolution path exists (a source document
          // is on file), a real deep link is offered instead of leaving the
          // person with only Acknowledge/Dismiss.
          const discrepancyType = typeof item.evidence?.discrepancyType === 'string' ? item.evidence.discrepancyType : null;
          const sourceDocumentId = typeof item.evidence?.sourceDocumentId === 'string' ? item.evidence.sourceDocumentId : null;
          const subjectType = typeof item.evidence?.subjectType === 'string' ? item.evidence.subjectType : null;
          const subjectId = typeof item.evidence?.subjectId === 'string' ? item.evidence.subjectId : null;
          const details = (item.evidence?.discrepancyDetails ?? null) as Record<string, unknown> | null;
          const maskedHolderName = typeof details?.maskedHolderName === 'string' ? details.maskedHolderName : null;
          // 2026-09-28 owner-exception unification: 'owner_mismatch' is the
          // sibling of 'owner_unmatched' -- the user DID declare an owner,
          // but the statement's own printed holder name disagrees (K.7).
          // The correct action is the SAME assign-to-household-member
          // control (it doubles as "confirm/override" when the user decides
          // the declared owner is right despite the mismatch, or "correct
          // it" when the statement is right) -- see
          // /api/investment-intelligence/accounts/[id]/owner's 2026-09-28
          // comment for why one endpoint now resolves both case types.
          const isOwnerAssignableAccount = (discrepancyType === 'owner_unmatched' || discrepancyType === 'owner_mismatch') && subjectType === 'account' && !!subjectId;
          const isJointHoldingAccount = discrepancyType === 'joint_holding_allocation_required' && subjectType === 'account';
          // 2026-09-29: 'document_password_required' already has a real,
          // working, auto-resolving fix -- InvestmentIntelligenceClient.tsx's
          // "Submit password & process" flow on the Data tab (found live: a
          // successful reparse already auto-resolves this exact case via
          // documentProcessing.ts's 'auto_resolved_on_reparse' path). The gap
          // was never a missing mechanism, only that this screen never told
          // the user it existed -- so this is guidance to the existing flow,
          // not a new one.
          const isPasswordRequiredDocument = discrepancyType === 'document_password_required' && !!sourceDocumentId;
          // These three are permanently dead ends for the uploaded file (see
          // the discard route's header) -- a genuine "Discard" action is
          // offered instead of the generic Acknowledge/Dismiss, which never
          // touched the document's own status or told the user to re-upload.
          const isDiscardableDocument = (discrepancyType === 'unsupported_document' || discrepancyType === 'document_corrupt' || discrepancyType === 'parse_incomplete') && !!sourceDocumentId;
          // A genuine resolver now exists for owner_unmatched/owner_mismatch
          // accounts and nothing else; joint holdings are DETECTED (K.6) but
          // deliberately not offered a one-owner "fix" here, because forcing
          // a joint folio onto a single owner would misattribute someone
          // else's share of it -- a real percentage-split allocation UI is
          // not yet built (see this file's header history).
          const hasNoResolver = (discrepancyType === 'owner_unmatched' && !isOwnerAssignableAccount) || isJointHoldingAccount;
          return (
            <li key={item.id} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${item.severity === 'high' ? 'bg-red-100 text-red-800' : item.severity === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}>
                      {SEVERITY_LABEL[item.severity]}
                    </span>
                    <span className="text-xs uppercase tracking-wide text-muted">{item.review_type.replace('_', ' ')}</span>
                    <span className="text-xs text-muted">· {item.compliance_classification}</span>
                  </div>
                  <h3 className="mt-1 font-medium text-ink">{item.title}</h3>
                  <p className="mt-1 text-sm text-muted">{item.description}</p>
                  <p className="mt-2 text-xs text-muted">
                    Source: {item.source_module.replace(/_/g, ' ')} · as of {item.as_of_date}
                  </p>
                  {statusFilter === 'open' && sourceDocumentId && !isOwnerAssignableAccount && !isDiscardableDocument && (
                    <Link href="/investment-intelligence/data" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
                      Review statement
                    </Link>
                  )}
                  {statusFilter === 'open' && isPasswordRequiredDocument && (
                    <p className="mt-2 text-xs text-amber-800">
                      This statement is password-protected. Open it from Statements &amp; data above, enter the password and click &quot;Submit password &amp; process&quot; —
                      this issue clears automatically once the document opens successfully.
                    </p>
                  )}
                  {statusFilter === 'open' && isDiscardableDocument && (
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <p className="text-xs text-amber-800">
                        {discrepancyType === 'unsupported_document' && 'This file’s format could not be identified and it cannot be processed as uploaded.'}
                        {discrepancyType === 'document_corrupt' && 'This file could not be read (it may be corrupted) and cannot be processed as uploaded.'}
                        {discrepancyType === 'parse_incomplete' && 'This statement could not be fully read and cannot be processed as uploaded.'}
                        {' '}Re-uploading the same file will fail again the same way — discard it, then upload a corrected file from Statements &amp; data if you have one.
                      </p>
                      <button
                        onClick={() => discardDocument(item.id, sourceDocumentId as string)}
                        disabled={discardingItemId === item.id}
                        className="rounded-md border px-2 py-1 text-xs font-medium text-red-700 disabled:opacity-50"
                      >
                        {discardingItemId === item.id ? 'Discarding…' : 'Discard this document'}
                      </button>
                      {discardError[item.id] && <p className="text-xs text-red-600">{discardError[item.id]}</p>}
                    </div>
                  )}
                  {statusFilter === 'open' && isJointHoldingAccount && (
                    <p className="mt-2 text-xs text-amber-800">
                      This statement prints a joint holding{maskedHolderName ? ` (${maskedHolderName})` : ''}. A single owner cannot be assumed without a percentage-split
                      decision, which this screen does not yet support — acknowledge for now, or discard the statement from Statements &amp; data if it was filed against the
                      wrong account.
                    </p>
                  )}
                  {statusFilter === 'open' && hasNoResolver && !isJointHoldingAccount && (
                    <p className="mt-2 text-xs text-amber-800">This issue requires owner/reconciliation functionality that is not yet available.</p>
                  )}
                  {statusFilter === 'open' && discrepancyType === 'owner_mismatch' && maskedHolderName && (
                    <p className="mt-2 text-xs text-amber-800">This statement is printed in the name of {maskedHolderName}, which does not match who it is currently filed under.</p>
                  )}
                  {statusFilter === 'open' && isOwnerAssignableAccount && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="text-xs text-muted" htmlFor={`owner-select-${item.id}`}>
                        {discrepancyType === 'owner_mismatch' ? 'Correct owner to:' : 'Assign to:'}
                      </label>
                      <select
                        id={`owner-select-${item.id}`}
                        className="rounded-md border px-2 py-1 text-xs"
                        value={selectedMemberByItem[item.id] ?? ''}
                        onChange={(e) => setSelectedMemberByItem((prev) => ({ ...prev, [item.id]: e.target.value }))}
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
                        onClick={() => assignOwner(item.id, subjectId as string)}
                        disabled={!selectedMemberByItem[item.id] || assigningItemId === item.id}
                        className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                      >
                        {assigningItemId === item.id ? 'Assigning…' : 'Assign'}
                      </button>
                      {assignError[item.id] && <p className="w-full text-xs text-red-600">{assignError[item.id]}</p>}
                    </div>
                  )}
                </div>
                {statusFilter === 'open' && (
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex gap-2">
                      <button onClick={() => act(item.id, 'acknowledge')} className="rounded-md border px-2 py-1 text-xs text-muted">
                        Acknowledge
                      </button>
                      <button onClick={() => act(item.id, 'dismiss')} className="rounded-md border px-2 py-1 text-xs text-muted">
                        Dismiss
                      </button>
                    </div>
                    <p className="max-w-[14rem] text-right text-[11px] text-muted">Records that you&apos;ve seen this — it does not resolve the underlying issue.</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
