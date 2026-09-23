'use client';

/**
 * FDH-11 — Australia Investment Statement Intelligence: the Investments-tab
 * statement import journey (spec sections 2, 15-25, 43-46, 63-65, 76, 108).
 *
 * Upload -> Review evidence -> Match account -> Match securities -> Bank
 * match -> Approve evidence -> Current vs statement -> explicit Apply.
 * Every step before the final Apply click is INERT — nothing here mutates
 * canonical Investment Intelligence until the user presses "Apply" (spec
 * section 63).
 *
 * WHY THIS FILE, NOT A NEW TOP-LEVEL DESTINATION. Product architecture (spec
 * section 76): FDH-11 lives entirely behind the Investments tab, exactly
 * like FDH-9/FDH-10 live behind Income/Liabilities
 * (`components/income/PayslipImportPanel.tsx`,
 * `components/liabilities/LiabilityImportPanel.tsx`, whose structure this
 * file deliberately mirrors). This component talks to the FDH-backed API
 * surface purely over `fetch()`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  waitForDocumentToLeaveValidating,
  SCANNING_MESSAGE,
  SCAN_TIMEOUT_MESSAGE,
} from '@/components/financial-data-hub/scanStatusPolling';

// 'ai_fallback_review' (2026-09-23, AIE unified document fallback): the native
// CSV extractor could not read this layout and an AI read a DRAFT off the same
// file. Nothing is saved until the user confirms from this phase — it sits
// BEFORE the ordinary 'review' phase, which shows evidence that already exists
// in the database.
type Phase = 'form' | 'uploading' | 'scanning' | 'unable_to_read' | 'scan_timeout' | 'duplicate' | 'ai_fallback_review' | 'review' | 'matching' | 'comparing' | 'applied' | 'error';

/** One AI-read holdings line, exactly as the confirm route accepts it. Every
 * numeric is an exact decimal STRING — FDH-11 stores units and money as
 * strings to keep float loss out of a share registry's 6-decimal unit
 * holdings, and parsing them to numbers here just to display them would
 * reintroduce it on the way back. */
interface AiDraftHolding {
  securityNameRaw: string;
  tickerRaw: string | null;
  isin: string | null;
  quantity: string;
  unitPrice: string | null;
  marketValue: string | null;
  valuationDate: string;
}

/** One AI-read activity line, exactly as the confirm route accepts it. */
interface AiDraftActivity {
  transactionType: string;
  tradeDate: string | null;
  settlementDate: string | null;
  securityNameRaw: string | null;
  tickerRaw: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string;
  brokerageRaw: string | null;
}

interface AiFallbackDraft {
  holdings: AiDraftHolding[];
  activities: AiDraftActivity[];
  institutionName: string | null;
  statementDate: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  allRowsListed: boolean;
  warnings: string[];
}

// 2026-09-21 (real-malware-gate async fix) — same honest, non-technical
// discipline as every other FDH-3 panel's failure copy: never "malware" or
// "virus".
const SCAN_REJECTION_MESSAGES: Record<string, string> = {
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file, or add this investment manually below.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file, or add this investment manually below.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again, or add this investment manually below.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again, or add this investment manually below.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again, or add this investment manually below.',
};

/** Shown when the user rejects an AI-read draft. Deliberately the same
 * "we couldn't read it, add it yourself" dead end an unreadable statement
 * already produces — declining a draft must not read as an error the user
 * caused. */
const AI_FALLBACK_DECLINED_MESSAGE =
  "We haven't saved anything. You can try a different file, or add this investment manually instead.";

interface Statement {
  id: string;
  statement_type: string;
  institution_name: string | null;
  masked_account_identifier: string | null;
  base_currency: string;
  opening_portfolio_value: number | null;
  closing_portfolio_value: number | null;
  cash_balance: number | null;
  reconciliation_status: 'reconciled' | 'variance' | 'insufficient_data';
  approval_status: 'pending' | 'approved';
  canonical_account_id: string | null;
}
interface Position {
  id: string;
  security_name_raw: string;
  ticker_raw: string | null;
  isin: string | null;
  quantity: string;
  security_match_status: string;
  matched_instrument_id: string | null;
}
interface Activity {
  id: string;
  activity_type: string;
  trade_date: string | null;
  amount: string;
  security_match_status: string;
  bank_match_status: string;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const reconciliationLabel: Record<string, string> = {
  reconciled: 'Reconciled — the statement adds up',
  variance: 'Needs review — a gap was found between the statement and canonical holdings',
  insufficient_data: 'Insufficient information to check this statement',
};

export function AuInvestmentStatementImportPanel({ onClose, onApplied }: { onClose: () => void; onApplied?: () => void }) {
  const [phase, setPhase] = useState<Phase>('form');
  const [csvKind, setCsvKind] = useState<'transaction' | 'portfolio'>('transaction');
  const [institutionName, setInstitutionName] = useState('');
  const [maskedAccountIdentifier, setMaskedAccountIdentifier] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<{ applied_count: number } | null>(null);
  // App Review 2026-09-14, item 2: same gap as BankStatementImportPanel.tsx
  // (see that file's identical comment) — this panel used to always render
  // as a fully working upload form and only discover the FDH-3 production
  // hard gate (lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed. `null` = not checked yet; `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // AIE AU investment-statement AI-fallback (2026-09-23). Held only for the
  // lifetime of the `ai_fallback_review` phase; cleared by `reset()` and on
  // confirm. Nothing in this draft exists in the database yet.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  // Real-malware-gate async fix (2026-09-21): cancels an in-flight status
  // poll if the panel unmounts mid-scan.
  const scanPollCancelRef = useRef({ cancelled: false });
  useEffect(() => () => {
    scanPollCancelRef.current.cancelled = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/financial-data-hub/upload-status')
      .then((res) => (res.ok ? res.json() : { data: { enabled: false } }))
      .then((json) => {
        if (!cancelled) setUploadEnabled(Boolean(json.data?.enabled));
      })
      .catch(() => {
        if (!cancelled) setUploadEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function reset() {
    setPhase('form');
    setFile(null);
    setDocumentId(null);
    setMessage(null);
    setStatement(null);
    setPositions([]);
    setActivities([]);
    setAiDraft(null);
  }

  /** Removes one AI-read line the user judges wrong. Deletion is the only
   * per-row edit offered here, deliberately: the statement's own review,
   * matching and approval steps (which this draft feeds into once saved) are
   * where values get examined in detail, and duplicating them as an editable
   * grid before anything exists would be a second review surface. Removing a
   * line the model hallucinated or double-counted is the one correction that
   * must happen BEFORE the write, because it is the one that would otherwise
   * become evidence. */
  function removeAiDraftHolding(index: number) {
    setAiDraft((d) => (d ? { ...d, holdings: d.holdings.filter((_, i) => i !== index) } : d));
  }

  function removeAiDraftActivity(index: number) {
    setAiDraft((d) => (d ? { ...d, activities: d.activities.filter((_, i) => i !== index) } : d));
  }

  async function handleConfirmAiDraft() {
    if (!aiDraft || !documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The user's own form choice travels back with the confirmation —
          // the statement's kind is caller context, never the model's reading.
          csv_kind: csvKind,
          holdings: aiDraft.holdings,
          activities: aiDraft.activities,
          institutionName: institutionName || aiDraft.institutionName,
          maskedAccountIdentifier: maskedAccountIdentifier || null,
          statementDate: aiDraft.statementDate,
          statementPeriodStart: aiDraft.statementPeriodStart,
          statementPeriodEnd: aiDraft.statementPeriodEnd,
        }),
      });
      const { ok: confirmOk, json } = await readJson(res);
      if (!confirmOk) {
        setMessage(json.error ?? 'We could not save this statement.');
        setPhase('error');
        return;
      }
      setAiDraft(null);
      // The confirm route returns the SAME envelope as upload/process, so the
      // journey rejoins the ordinary path here: review -> match -> approve ->
      // apply, with nothing downstream aware that a model was involved.
      await handleStatementOutcome(json);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function loadReview(docId: string) {
    const res = await fetch(`/api/financial-data-hub/investment-statement/${docId}`);
    const { ok, json } = await readJson(res);
    if (!ok) {
      setMessage(json.error ?? 'We could not load this statement.');
      setPhase('error');
      return;
    }
    setStatement(json.data.statement as Statement);
    setPositions((json.data.positions as Position[]) ?? []);
    setActivities((json.data.activities as Activity[]) ?? []);
    setPhase('review');
  }

  // Handles the JSON body from EITHER the initial upload call or the
  // real-malware-gate async fix's `.../process` resumption call — both
  // return the identical `{ document_id, pipeline_status, statement_id,
  // error_message, duplicate }` shape (see the API routes), so one function
  // covers the "what do we do with this outcome" decision for both.
  async function handleStatementOutcome(json: Record<string, unknown>) {
    const data = json.data as Record<string, unknown>;
    // AIE AU investment-statement AI-fallback (2026-09-23). Checked BEFORE the
    // "no statement_id means we could not read it" branch below, which would
    // otherwise misread a perfectly good draft as a hard failure — an
    // AI-fallback response deliberately carries NO statement_id, because
    // nothing has been written yet.
    if (data.pipeline_status === 'ai_fallback_available' && data.ai_fallback_draft) {
      setDocumentId(data.document_id as string);
      setAiDraft(data.ai_fallback_draft as AiFallbackDraft);
      setPhase('ai_fallback_review');
      return;
    }
    if (!data.statement_id) {
      setMessage((data.error_message as string | undefined) ?? 'We could not read this statement.');
      setPhase('unable_to_read');
      return;
    }
    setDocumentId(data.document_id as string);
    if (data.duplicate) {
      setMessage('This statement has already been uploaded. Showing the evidence already on file.');
      await loadReview(data.document_id as string);
      setPhase('duplicate');
      return;
    }
    await loadReview(data.document_id as string);
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    try {
      const params = new URLSearchParams({ csv_kind: csvKind, currency_code: 'AUD' });
      if (institutionName) params.set('institution_name', institutionName);
      if (maskedAccountIdentifier) params.set('masked_account_identifier', maskedAccountIdentifier);

      const res = await fetch(`/api/financial-data-hub/investment-statement/upload?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      });
      const { ok, json } = await readJson(res);
      if (!ok) {
        setMessage(json.error ?? 'We could not process this statement.');
        setPhase('unable_to_read');
        return;
      }

      // Real-malware-gate async fix (2026-09-21): the upload route now
      // returns `pipeline_status: 'pending_scan'` (statement_id: null,
      // NOT a failure) instead of extracting immediately when the real
      // S3+GuardDuty scan has not yet resolved — see
      // investmentStatementProcessingService.ts's `resolveAuInvestment
      // StatementDocument()`. Checked BEFORE the "no statement_id means
      // unable to read" branch below, which would otherwise misread this
      // wait state as a real failure.
      if (json.data.pipeline_status === 'pending_scan') {
        const docId = json.data.document_id as string;
        setDocumentId(docId);
        setPhase('scanning');
        setMessage(SCANNING_MESSAGE);
        const waited = await waitForDocumentToLeaveValidating(docId, { signal: scanPollCancelRef.current });
        if (waited.outcome === 'timeout') {
          setMessage(SCAN_TIMEOUT_MESSAGE);
          setPhase('scan_timeout');
          return;
        }
        if (waited.processingStatus === 'failed' || waited.processingStatus === 'rejected') {
          setMessage(
            (waited.errorCode && SCAN_REJECTION_MESSAGES[waited.errorCode])
              ?? 'This file could not be accepted. Please try a different file, or add this investment manually below.',
          );
          setPhase('unable_to_read');
          return;
        }
        // The scan cleared -- finish the extraction the upload route
        // deferred, re-submitting the SAME metadata originally supplied.
        const processRes = await fetch(`/api/financial-data-hub/investment-statement/${docId}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csv_kind: csvKind,
            currency_code: 'AUD',
            institution_name: institutionName || undefined,
            masked_account_identifier: maskedAccountIdentifier || undefined,
          }),
        });
        const { ok: processOk, json: processJson } = await readJson(processRes);
        if (!processOk) {
          setMessage(processJson.error ?? 'We could not process this statement.');
          setPhase('unable_to_read');
          return;
        }
        await handleStatementOutcome(processJson);
        return;
      }

      await handleStatementOutcome(json);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleMatchAll() {
    if (!documentId) return;
    setBusy(true);
    setPhase('matching');
    try {
      await fetch(`/api/financial-data-hub/investment-statement/${documentId}/account-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', account_type: 'broker', currency_code: statement?.base_currency ?? 'AUD' }),
      });
      for (const row of positions) {
        if (row.security_match_status === 'not_attempted') {
          await fetch(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'fdh_investment_statement_positions', row_id: row.id }),
          });
        }
      }
      for (const row of activities) {
        if (row.security_match_status === 'not_attempted') {
          await fetch(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'fdh_investment_statement_activities', row_id: row.id }),
          });
        }
      }
      await fetch(`/api/financial-data-hub/investment-statement/${documentId}/bank-match`, { method: 'POST' });
      await loadReview(documentId);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/approve`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'Could not approve this statement evidence.');
      await loadReview(documentId);
      setPhase('comparing');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/apply`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'The change could not be saved.');
      setApplyResult({ applied_count: json.data.applied_count });
      setPhase('applied');
      onApplied?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  const unresolvedCount = [...positions, ...activities].filter((r) => r.security_match_status !== 'matched').length;

  return (
    <div role="region" aria-label="Import an Australian investment statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import Australian Investment Statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close statement import">
          Close
        </button>
      </div>

      {uploadEnabled === false && phase === 'form' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Statement import isn&apos;t turned on in this environment yet. You can still add this investment
            yourself using the Investments form below.
          </p>
        </div>
      )}

      {uploadEnabled !== false && phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a transaction-history or portfolio-holdings CSV and FHIP will extract the details for you to review before
            anything is added to your Investments.
          </p>
          <p className="text-xs text-muted">
            FHIP currently reads two generic Australian CSV layouts (a transaction-history export and a portfolio/holdings
            export with standard column headers). Broker-specific exports or PDF statements outside these layouts are not
            yet supported — you can still add the investment manually below instead.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Statement contains</span>
              <select className="w-full rounded border border-gray-300 px-3 py-2" value={csvKind} onChange={(e) => setCsvKind(e.target.value as 'transaction' | 'portfolio')}>
                <option value="transaction">Transaction history</option>
                <option value="portfolio">Portfolio / holdings</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Broker / institution</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Account (masked, e.g. ****1234)</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={maskedAccountIdentifier} onChange={(e) => setMaskedAccountIdentifier(e.target.value)} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement file (CSV)</span>
            <input type="file" accept="text/csv,.csv" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" onClick={handleUpload} disabled={!file || busy || uploadEnabled !== true} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
            Upload statement
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'matching' || phase === 'scanning') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' && 'Uploading and reading your statement…'}
          {phase === 'scanning' && (message ?? SCANNING_MESSAGE)}
          {phase === 'matching' && 'Matching accounts, securities and bank evidence…'}
        </p>
      )}

      {phase === 'unable_to_read' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <p className="text-sm text-muted">You can try a different file, or add this investment manually instead.</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'scan_timeout' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? SCAN_TIMEOUT_MESSAGE}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not recognise this statement&apos;s layout automatically, so we used AI to read it instead. Please
            check these lines before saving — <strong>nothing has been saved yet</strong>.
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted">Broker / institution</dt>
              <dd>{institutionName || aiDraft.institutionName || 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Statement date</dt>
              <dd>{aiDraft.statementDate ?? 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Period</dt>
              <dd>
                {aiDraft.statementPeriodStart ?? '?'} to {aiDraft.statementPeriodEnd ?? '?'}
              </dd>
            </div>
          </dl>

          {!aiDraft.allRowsListed && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The AI reported that it could <strong>not</strong> list every line on this statement. If you save this,
              the evidence will be incomplete — we recommend adding the missing lines by hand afterwards, or trying a
              different file.
            </p>
          )}

          {aiDraft.holdings.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted">
                {aiDraft.holdings.length} holding{aiDraft.holdings.length === 1 ? '' : 's'} read. Remove any line that
                is wrong or is not really a holding.
              </p>
              <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <caption className="sr-only">Holdings read from this statement by AI, awaiting your confirmation</caption>
                  <thead className="sticky top-0 bg-gray-50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2">Security</th>
                      <th scope="col" className="px-3 py-2">Code</th>
                      <th scope="col" className="px-3 py-2 text-right">Units</th>
                      <th scope="col" className="px-3 py-2 text-right">Value</th>
                      <th scope="col" className="px-3 py-2">As at</th>
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiDraft.holdings.map((h, i) => (
                      <tr key={`${h.securityNameRaw}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2">{h.securityNameRaw}</td>
                        <td className="px-3 py-2">{h.tickerRaw ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.marketValue ?? '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{h.valuationDate}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeAiDraftHolding(i)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                            Remove<span className="sr-only"> the {h.securityNameRaw} holding</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {aiDraft.activities.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted">
                {aiDraft.activities.length} transaction{aiDraft.activities.length === 1 ? '' : 's'} read. Remove any
                line that is wrong or is not really a transaction.
              </p>
              <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <caption className="sr-only">Transactions read from this statement by AI, awaiting your confirmation</caption>
                  <thead className="sticky top-0 bg-gray-50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2">Date</th>
                      <th scope="col" className="px-3 py-2">Type</th>
                      <th scope="col" className="px-3 py-2">Security</th>
                      <th scope="col" className="px-3 py-2 text-right">Units</th>
                      <th scope="col" className="px-3 py-2 text-right">Amount</th>
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiDraft.activities.map((a, i) => (
                      <tr key={`${a.transactionType}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2 whitespace-nowrap">{a.tradeDate ?? '—'}</td>
                        <td className="px-3 py-2">{a.transactionType}</td>
                        <td className="px-3 py-2">{a.securityNameRaw ?? a.tickerRaw ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.quantity ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.amount}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeAiDraftActivity(i)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                            Remove<span className="sr-only"> the {a.transactionType} line on {a.tradeDate ?? 'an unknown date'}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only. Saving them creates statement evidence — exactly as a
            statement we read automatically would — which you then match, reconcile and explicitly approve before
            anything reaches your Investments.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setAiDraft(null);
                setMessage(AI_FALLBACK_DECLINED_MESSAGE);
                setPhase('unable_to_read');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || aiDraft.holdings.length + aiDraft.activities.length === 0}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save this statement
            </button>
          </div>
        </div>
      )}

      {(phase === 'review' || phase === 'duplicate' || phase === 'comparing') && statement && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Statement review</h3>
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Institution</dt>
            <dd>{statement.institution_name ?? 'Not identified'}</dd>
            <dt className="text-muted">Account (masked)</dt>
            <dd>{statement.masked_account_identifier ?? 'Not provided'}</dd>
            <dt className="text-muted">Investment account</dt>
            <dd>{statement.canonical_account_id ? 'Matched to an existing account' : 'Not yet matched'}</dd>
          </dl>
          <p className="text-sm" role="status">
            <span className="font-medium">Reconciliation: </span>
            {reconciliationLabel[statement.reconciliation_status]}
          </p>

          {positions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">Holdings on this statement ({positions.length})</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {positions.map((p) => (
                  <li key={p.id} className="flex justify-between border-b border-gray-100 py-1">
                    <span>{p.security_name_raw} — {p.quantity} units</span>
                    <span className="text-muted">{p.security_match_status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {activities.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">Transactions on this statement ({activities.length})</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {activities.map((a) => (
                  <li key={a.id} className="flex justify-between border-b border-gray-100 py-1">
                    <span>{a.trade_date ?? '—'} — {a.activity_type} {a.amount}</span>
                    <span className="text-muted">{a.security_match_status} / {a.bank_match_status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {statement.approval_status !== 'approved' && (
            <div className="flex gap-3">
              <button type="button" onClick={handleMatchAll} disabled={busy} className="rounded border border-trust px-3 py-1 text-sm text-trust">
                Match accounts &amp; securities
              </button>
              <button type="button" onClick={handleApprove} disabled={busy || unresolvedCount > 0} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
                Approve evidence
              </button>
              {unresolvedCount > 0 && <span className="self-center text-xs text-muted">{unresolvedCount} item(s) still need a confirmed match — review required.</span>}
            </div>
          )}

          {statement.approval_status === 'approved' && (
            <div className="space-y-2">
              <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">This statement evidence has been approved. Canonical Investment Intelligence is still unchanged.</p>
              <button type="button" onClick={handleApply} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Apply to Investment Intelligence
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'applied' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {applyResult ? `${applyResult.applied_count} item(s) applied to your Investment Intelligence portfolio.` : 'Applied.'}
          </p>
          {/* LR-4 (2026-09-08): found during the import-capability audit —
              "Apply" here lands in Investment Intelligence's own evidence
              tables, not directly in the current-holding value this
              Investments tab (and your Net Worth/Dashboard) actually
              display. Reaching those requires one more explicit step —
              reviewing and publishing the position in Investment
              Intelligence — which nothing here previously told the user
              about or linked to, so an applied statement could silently
              never show up anywhere the user was looking. This link closes
              that gap without touching Investment Intelligence itself. */}
          <p className="text-sm text-muted">
            This is evidence, not yet a current holding value. To have it count toward your Investments and Net Worth,
            review and publish it in Investment Intelligence.
          </p>
          <div className="flex gap-3">
            <a
              href="/investment-intelligence/data"
              className="rounded bg-trust px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Review and publish
            </a>
            <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
