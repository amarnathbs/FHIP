'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { OwnerChangeDialog, type OwnerSubmitExtra, type OwnerSubmitResult } from './OwnerChangeDialog';
import { apiErrorMessage, type OwnerSelectionBody } from './ownerChange';
import { fmtDate } from './dateDisplay';

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

/** The Review item whose owner dialog is open. Everything the dialog needs, resolved from the item's own evidence. */
interface OwnerDialogTarget {
  itemId: string;
  accountId: string;
  caseId: string | null;
  jointOnly: boolean;
  suggestedJointMemberIds: string[];
  holderHint: string | null;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEVERITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

export function ReviewCentreClient({ dateCurrency = 'AUD' }: { dateCurrency?: 'AUD' | 'INR' } = {}) {
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
  // called it.
  //
  // 2026-10-01: the owner can now ALSO be a trust / HUF / company, or a joint
  // split with percentages (resolving a 'joint_holding_allocation_required'
  // case, which previously had no resolver at all). Every owner change goes
  // through OwnerChangeDialog, whose second step is an explicit confirmation
  // (current -> new owner, with consequences in plain words); the PATCH
  // carries `confirm: true` and the server refuses it without.
  const [ownerDialog, setOwnerDialog] = useState<OwnerDialogTarget | null>(null);
  const [ownerNotice, setOwnerNotice] = useState<string | null>(null);
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
  // the full rationale, including why (at the time) ambiguous_instrument and
  // the cross_source_* types were checked and found to have ZERO occurrences
  // ever in production, and so were not given a bespoke action then.
  // 2026-09-30 update: ambiguous_instrument now HAS a real fix action (see
  // below) — a Review issue must have a genuine resolution path regardless
  // of current case volume (the Product Owner's own rule, Document2 final
  // non-benchmark closure #3).
  const [discardingItemId, setDiscardingItemId] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<Record<string, string>>({});
  // Document2 final non-benchmark closure #3 (2026-09-30): 'ambiguous_instrument'
  // previously had NO real resolution path (Acknowledge/Dismiss only) —
  // confirmed by discovery to be a genuine, disclosed gap. The candidate
  // instruments (real display names, never raw ids) were recorded on the
  // case itself at detection time (documentProcessing.ts/
  // aiExtractionReviewApply.ts), so this screen needs no extra lookup.
  const [selectedInstrumentByItem, setSelectedInstrumentByItem] = useState<Record<string, string>>({});
  const [resolvingInstrumentItemId, setResolvingInstrumentItemId] = useState<string | null>(null);
  const [resolveInstrumentError, setResolveInstrumentError] = useState<Record<string, string>>({});
  // Document2 final non-benchmark closure #4 (2026-09-30): a genuine
  // explicit conflict-choice action for 'cross_source_conflict'/
  // 'cross_source_review_required' — see
  // reconciliation-cases/[id]/resolve-cross-source's header for the full
  // category-D rationale (the exact/high-confidence duplicate siblings are
  // already auto-resolved by the system and never reach this screen open).
  const [resolvingCrossSourceItemId, setResolvingCrossSourceItemId] = useState<string | null>(null);
  const [resolveCrossSourceError, setResolveCrossSourceError] = useState<Record<string, string>>({});
  // Document2 final non-benchmark closure #10 (2026-09-30): a genuine
  // resolution path for 'transaction_unclassified' — see
  // reconciliation-cases/[id]/resolve-classification's header for why this
  // matters more than most: a MATERIAL (high-severity) instance is a real
  // certification blocker, and no re-classification action existed before
  // this one despite an earlier report's claim otherwise.
  const RECLASSIFY_TYPES = ['purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment', 'transfer', 'merger', 'fee', 'tax', 'adjustment', 'stp_in', 'stp_out', 'swp', 'transfer_in', 'transfer_out', 'reversal', 'segregation', 'bonus', 'split', 'sale'] as const;
  const [selectedClassificationByItem, setSelectedClassificationByItem] = useState<Record<string, string>>({});
  const [resolvingClassificationItemId, setResolvingClassificationItemId] = useState<string | null>(null);
  const [resolveClassificationError, setResolveClassificationError] = useState<Record<string, string>>({});

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

  async function submitOwner(target: OwnerDialogTarget, owner: OwnerSelectionBody, extra?: OwnerSubmitExtra): Promise<OwnerSubmitResult> {
    try {
      const res = await fetch(`/api/investment-intelligence/accounts/${encodeURIComponent(target.accountId)}/owner`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // `confirm: true` is the explicit confirmation from the dialog's second step.
        body: JSON.stringify({ owner, confirm: true, ...(extra?.confirmNotJoint ? { confirm_not_joint: true } : {}), ...(target.caseId ? { case_id: target.caseId } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) return { ok: false, error: apiErrorMessage(json, 'Could not save that owner.') };
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
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not save that owner.' };
    }
  }

  async function resolveAmbiguousInstrument(itemId: string, caseId: string) {
    const resolvedInstrumentId = selectedInstrumentByItem[itemId];
    if (!resolvedInstrumentId) return;
    setResolvingInstrumentItemId(itemId);
    setResolveInstrumentError((prev) => ({ ...prev, [itemId]: '' }));
    try {
      const res = await fetch(`/api/investment-intelligence/reconciliation-cases/${encodeURIComponent(caseId)}/resolve-instrument`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolvedInstrumentId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not resolve this instrument.');
      // Same reason submitOwner()/discardDocument() above hit /review/refresh
      // before reloading -- ii_review_items is a materialised snapshot, not
      // the same table as ii_reconciliation_cases, so resolving the case (and
      // the reprocess this route already performs) does not by itself remove
      // this item from an already-computed "open" list.
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } catch (e) {
      setResolveInstrumentError((prev) => ({ ...prev, [itemId]: e instanceof Error ? e.message : 'Could not resolve this instrument.' }));
    } finally {
      setResolvingInstrumentItemId(null);
    }
  }

  async function resolveCrossSource(itemId: string, caseId: string, decision: 'confirmed_duplicate' | 'confirmed_distinct') {
    setResolvingCrossSourceItemId(itemId);
    setResolveCrossSourceError((prev) => ({ ...prev, [itemId]: '' }));
    try {
      const res = await fetch(`/api/investment-intelligence/reconciliation-cases/${encodeURIComponent(caseId)}/resolve-cross-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not record that decision.');
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } catch (e) {
      setResolveCrossSourceError((prev) => ({ ...prev, [itemId]: e instanceof Error ? e.message : 'Could not record that decision.' }));
    } finally {
      setResolvingCrossSourceItemId(null);
    }
  }

  async function resolveClassification(itemId: string, caseId: string) {
    const transactionType = selectedClassificationByItem[itemId];
    if (!transactionType) return;
    setResolvingClassificationItemId(itemId);
    setResolveClassificationError((prev) => ({ ...prev, [itemId]: '' }));
    try {
      const res = await fetch(`/api/investment-intelligence/reconciliation-cases/${encodeURIComponent(caseId)}/resolve-classification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionType }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not classify this transaction.');
      await fetch('/api/investment-intelligence/review/refresh', { method: 'POST' });
      await load(statusFilter);
    } catch (e) {
      setResolveClassificationError((prev) => ({ ...prev, [itemId]: e instanceof Error ? e.message : 'Could not classify this transaction.' }));
    } finally {
      setResolvingClassificationItemId(null);
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
      // Same reason submitOwner() above hits /review/refresh before reloading
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

      {ownerNotice && (
        <p role="status" className="mb-3 rounded-md bg-green-50 p-2 text-sm text-green-800">
          {ownerNotice}
        </p>
      )}
      {ownerDialog && (
        <OwnerChangeDialog
          accountId={ownerDialog.accountId}
          accountLabel={null}
          mode="review"
          jointOnly={ownerDialog.jointOnly}
          suggestedJointMemberIds={ownerDialog.suggestedJointMemberIds}
          holderHint={ownerDialog.holderHint}
          submit={(owner, extra) => submitOwner(ownerDialog, owner, extra)}
          onClose={() => setOwnerDialog(null)}
          onDone={() => {
            setOwnerDialog(null);
            setOwnerNotice('Owner saved. This issue has been resolved and is recorded in your history.');
          }}
        />
      )}

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
          // Document2 final closure #3 (2026-09-30): 'ambiguous_instrument'
          // now has a real resolution path — the case's own recorded
          // candidates (real names, never raw ids), a select + Resolve
          // action that reprocesses the source document immediately.
          const caseId = typeof item.evidence?.caseId === 'string' ? item.evidence.caseId : null;
          const ambiguousCandidates = Array.isArray(details?.candidates) ? (details!.candidates as { instrumentId: string; displayName: string; amcName: string | null; isin: string | null }[]) : [];
          const isAmbiguousInstrumentCase = discrepancyType === 'ambiguous_instrument' && !!caseId && ambiguousCandidates.length > 0;
          // Document2 final closure #4: the two cross-source discrepancy
          // types that are ever left OPEN (the exact/high-confidence
          // duplicate siblings auto-resolve at creation and never reach this
          // list) — a genuine explicit conflict-choice action.
          const isCrossSourceConflictCase = (discrepancyType === 'cross_source_conflict' || discrepancyType === 'cross_source_review_required') && !!caseId && typeof details?.newTransactionId === 'string';
          // Document2 final closure #10: 'transaction_unclassified' — see
          // reconciliation-cases/[id]/resolve-classification's header.
          const isClassifiableTransaction = discrepancyType === 'transaction_unclassified' && !!caseId && typeof details?.newTransactionId === 'string';
          // 'transaction_missing_from_restatement' never blocks anything
          // (severity is always 'medium', never in evaluateCertification's
          // blocking-severity set) and nothing was ever deleted or changed —
          // it is genuinely informational, not a silent "figure it out"
          // dead end, so it gets its own explicit no-action-needed message
          // rather than the generic hasNoResolver text.
          // 'other' (severity always 'info') is the AI-fallback path's own
          // "valuation recorded, no transaction fabricated" note — genuinely
          // informational for the identical reason
          // transaction_missing_from_restatement is: nothing is blocked and
          // nothing needs undoing, only explaining.
          const isInformationalMissingRestatement = discrepancyType === 'transaction_missing_from_restatement' || discrepancyType === 'other';
          // A genuine resolver now exists for owner_unmatched/owner_mismatch
          // accounts, ambiguous_instrument, cross_source_conflict/
          // cross_source_review_required, and transaction_unclassified.
          // 2026-10-01: joint holdings (K.6) are resolved too -- never by a
          // one-owner "fix" (that would misattribute someone else's share),
          // but by a joint split with percentages that must total 100%, chosen
          // in OwnerChangeDialog.
          const matchedMemberIds = Array.isArray(details?.matchedMemberIds) ? (details!.matchedMemberIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
          const isJointHoldingResolvable = isJointHoldingAccount && !!subjectId;
          const hasNoResolver =
            (discrepancyType === 'owner_unmatched' && !isOwnerAssignableAccount) ||
            (isJointHoldingAccount && !isJointHoldingResolvable) ||
            (discrepancyType === 'ambiguous_instrument' && !isAmbiguousInstrumentCase) ||
            ((discrepancyType === 'cross_source_conflict' || discrepancyType === 'cross_source_review_required') && !isCrossSourceConflictCase) ||
            (discrepancyType === 'transaction_unclassified' && !isClassifiableTransaction);
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
                    Source: {item.source_module.replace(/_/g, ' ')} · as of {fmtDate(item.as_of_date, dateCurrency)}
                  </p>
                  {statusFilter === 'open' && sourceDocumentId && !isOwnerAssignableAccount && !isDiscardableDocument && (
                    // 2026-09-29 fix (resolution-guidance links): this used to
                    // link to the generic, unscoped Statements & data list,
                    // leaving the person to find the right statement among
                    // however many they have uploaded themselves -- exactly
                    // the "here's a number, go hunt for where to fix it"
                    // pattern the rest of this fix removes elsewhere.
                    // `?documentId=` (read server-side by that page, see its
                    // own 2026-09-29 comment) opens the correct statement's
                    // detail panel directly, scrolled into view. Still gated
                    // on !isDiscardableDocument (2026-09-29, real resolution
                    // actions fix) -- that case gets its own dedicated
                    // Discard action below instead of this generic link.
                    <Link
                      href={`/investment-intelligence/data?documentId=${encodeURIComponent(sourceDocumentId)}`}
                      className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
                    >

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
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <p className="text-xs text-amber-800">
                        This statement prints a joint holding{maskedHolderName ? ` (${maskedHolderName})` : ''}. A single owner cannot be assumed, so say who owns it and what
                        share each owner has — the shares must add up to exactly 100%. If it is not actually a joint holding, you can say so in the dialog and assign a single
                        owner. You will see a summary to confirm before anything is saved.
                      </p>
                      {isJointHoldingResolvable && (
                        <button
                          onClick={() => {
                            setOwnerNotice(null);
                            setOwnerDialog({ itemId: item.id, accountId: subjectId as string, caseId, jointOnly: true, suggestedJointMemberIds: matchedMemberIds, holderHint: maskedHolderName });
                          }}
                          className="rounded-md border px-2 py-1 text-xs font-medium text-primary"
                        >
                          Split ownership…
                        </button>
                      )}
                    </div>
                  )}
                  {statusFilter === 'open' && hasNoResolver && !isJointHoldingAccount && (
                    <p className="mt-2 text-xs text-amber-800">This issue requires owner/reconciliation functionality that is not yet available.</p>
                  )}
                  {statusFilter === 'open' && isAmbiguousInstrumentCase && (
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <p className="text-xs text-amber-800">
                        This statement’s scheme could not be matched to a single canonical instrument. Choose the correct one below — the statement will be re-checked automatically once you save.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-xs text-muted" htmlFor={`instrument-select-${item.id}`}>
                          Correct instrument:
                        </label>
                        <select
                          id={`instrument-select-${item.id}`}
                          className="rounded-md border px-2 py-1 text-xs"
                          value={selectedInstrumentByItem[item.id] ?? ''}
                          onChange={(e) => setSelectedInstrumentByItem((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        >
                          <option value="">Choose an instrument</option>
                          {ambiguousCandidates.map((c) => (
                            <option key={c.instrumentId} value={c.instrumentId}>
                              {c.displayName}
                              {c.amcName ? ` — ${c.amcName}` : ''}
                              {c.isin ? ` (${c.isin})` : ''}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => resolveAmbiguousInstrument(item.id, caseId as string)}
                          disabled={!selectedInstrumentByItem[item.id] || resolvingInstrumentItemId === item.id}
                          className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                        >
                          {resolvingInstrumentItemId === item.id ? 'Resolving…' : 'Resolve'}
                        </button>
                      </div>
                      {resolveInstrumentError[item.id] && <p className="w-full text-xs text-red-600">{resolveInstrumentError[item.id]}</p>}
                    </div>
                  )}
                  {statusFilter === 'open' && isCrossSourceConflictCase && (
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <p className="text-xs text-amber-800">
                        A different statement recorded a transaction that may be the same real-world event as one already on file, but the details don’t match closely enough to
                        be sure automatically. Is this the same transaction, recorded twice?
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => resolveCrossSource(item.id, caseId as string, 'confirmed_duplicate')}
                          disabled={resolvingCrossSourceItemId === item.id}
                          className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                        >
                          Yes, same transaction
                        </button>
                        <button
                          onClick={() => resolveCrossSource(item.id, caseId as string, 'confirmed_distinct')}
                          disabled={resolvingCrossSourceItemId === item.id}
                          className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                        >
                          No, these are different transactions
                        </button>
                      </div>
                      {resolveCrossSourceError[item.id] && <p className="w-full text-xs text-red-600">{resolveCrossSourceError[item.id]}</p>}
                    </div>
                  )}
                  {statusFilter === 'open' && isClassifiableTransaction && (
                    <div className="mt-2 flex flex-col items-start gap-2">
                      <p className="text-xs text-amber-800">
                        This transaction’s type could not be automatically identified{details?.description ? ` (“${String(details.description)}”)` : ''}. Choose the correct type
                        below to clear this issue.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-xs text-muted" htmlFor={`classify-select-${item.id}`}>
                          Transaction type:
                        </label>
                        <select
                          id={`classify-select-${item.id}`}
                          className="rounded-md border px-2 py-1 text-xs"
                          value={selectedClassificationByItem[item.id] ?? ''}
                          onChange={(e) => setSelectedClassificationByItem((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        >
                          <option value="">Choose a type</option>
                          {RECLASSIFY_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t.replace(/_/g, ' ')}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => resolveClassification(item.id, caseId as string)}
                          disabled={!selectedClassificationByItem[item.id] || resolvingClassificationItemId === item.id}
                          className="rounded-md border px-2 py-1 text-xs font-medium text-primary disabled:opacity-50"
                        >
                          {resolvingClassificationItemId === item.id ? 'Saving…' : 'Save classification'}
                        </button>
                      </div>
                      {resolveClassificationError[item.id] && <p className="w-full text-xs text-red-600">{resolveClassificationError[item.id]}</p>}
                    </div>
                  )}
                  {statusFilter === 'open' && isInformationalMissingRestatement && (
                    <p className="mt-2 text-xs text-muted">
                      {discrepancyType === 'other'
                        ? 'Informational only — no action needed. A valuation was recorded for this position without transaction-level detail; no transaction was fabricated to explain it.'
                        : 'Informational only — no action needed. A transaction FHIP already had on file for this position wasn’t re-confirmed by this newer statement. Nothing has been changed or removed.'}
                    </p>
                  )}
                  {statusFilter === 'open' && discrepancyType === 'owner_mismatch' && maskedHolderName && (
                    <p className="mt-2 text-xs text-amber-800">This statement is printed in the name of {maskedHolderName}, which does not match who it is currently filed under.</p>
                  )}
                  {statusFilter === 'open' && isOwnerAssignableAccount && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => {
                          setOwnerNotice(null);
                          setOwnerDialog({ itemId: item.id, accountId: subjectId as string, caseId, jointOnly: false, suggestedJointMemberIds: [], holderHint: maskedHolderName });
                        }}
                        className="rounded-md border px-2 py-1 text-xs font-medium text-primary"
                      >
                        {discrepancyType === 'owner_mismatch' ? 'Correct the owner…' : 'Choose the owner…'}
                      </button>
                      <span className="text-xs text-muted">A household member, a trust / HUF / company, or a joint split with percentages.</span>
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
