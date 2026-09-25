'use client';

/**
 * LR-3 — Expenses Bank Statement Workflow: the Expenses-tab bank-statement
 * import journey.
 *
 * Upload -> detect (CSV only) -> process -> a link to the existing FDH
 * review/approval workspace, where the extracted transactions are corrected
 * and approved. This panel deliberately does NOT re-implement that review UI
 * inline (unlike components/income/PayslipImportPanel.tsx's fully-inlined
 * proposal-compare flow) — a bank statement can extract dozens or hundreds
 * of individual transactions, which already has its own dedicated, more
 * capable review surface at /financial-data-hub/review; duplicating it here
 * would be a second, divergent copy of the same UI. Once a transaction is
 * approved there, it already counts toward Monthly Surplus on its own (see
 * lib/engines/dashboard.ts's LR-3 section) — there is no separate "Apply"
 * step for Expenses the way Income has one (see FDH15_BRIDGE_ARCHITECTURE_
 * INVENTORY.md's documented rationale: approval is the terminal state for
 * this domain, by design).
 *
 * 2026-09-21 fix (P1-7, LR audit): this panel used to call the GENERIC FDH-3
 * upload-session endpoints (create-session, then complete) and then stop —
 * those primitives only ever store the file and mark the document
 * `processing_status = 'queued'` (see uploadLifecycle.ts's own header
 * comment: "No worker is implemented in FDH-3; this only creates the job
 * record"). Nothing ever advanced the document past `queued`, so the
 * "Uploaded. Your transactions are being extracted for review." message was
 * false — no worker exists to do that extraction, and the panel never asked
 * for it. The bank-CSV/bank-PDF engines this app already has (10 certified
 * adapters, live-DEV E2E proven in LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md)
 * are reached through their OWN dedicated routes instead
 * (`bank-csv/upload` + `bank-csv/{id}/detect` + `bank-csv/{id}/process`, or
 * `bank-pdf/upload` + `bank-pdf/{id}/process`) — the same routes that oracle
 * drove directly over HTTP, and the same account-identity resolution
 * (`uploadBankCsv`/`uploadBankPdf`) those routes perform that the generic
 * session endpoints never did. This panel now calls those real routes
 * itself, so the button it sits behind can actually do what its own copy
 * always claimed. The former "Credit card statement" / "Loan statement"
 * options are removed here — neither ever had a working backend behind this
 * panel (they would need `liability-statement/upload`, which already has its
 * own real, working entry point at `components/liabilities/
 * LiabilityImportPanel.tsx` under the Liabilities tab) — offering them here
 * was always a second, non-functional path to the same place.
 *
 * WHY THIS FILE, NOT A DIRECT IMPORT OF FdhDocumentUploadClient. Same
 * precedent as PayslipImportPanel.tsx/LiabilityImportPanel.tsx/
 * AuInvestmentStatementImportPanel.tsx/RetirementStatementImportPanel.tsx:
 * this module lives behind its own tab (Expenses), not as a new top-level
 * destination, and talks to the FDH-backed API surface purely over
 * `fetch()` — the same relationship any other HTTP client has to a public
 * route, not a `lib/financial-data-hub` import. `tests/unit/
 * fdh1Isolation.test.ts`'s "is imported by nothing outside itself" check is
 * a naive path-substring search, so this file (and its one call site,
 * app/(app)/expenses/page.tsx) is named in that test's own documented
 * FDH_APPROVED_CONSUMER_FILES allowlist, for the identical reason the four
 * files above already are.
 */

import { useEffect, useRef, useState } from 'react';
import {
  waitForDocumentToLeaveValidating,
  SCANNING_MESSAGE,
  SCAN_TIMEOUT_MESSAGE,
} from '@/components/financial-data-hub/scanStatusPolling';
import {
  useWaitingImports,
  WaitingImportsList,
  discardAiDraft,
  DUPLICATE_UPLOAD_MESSAGE,
  type WaitingImport,
} from '@/components/financial-data-hub/WaitingImports';

type Phase =
  | 'form'
  | 'uploading'
  | 'scanning'
  | 'processing'
  | 'awaiting_password'
  // AIE bank-statement AI-fallback (2026-09-23). The native parse failed on a
  // readable-but-unrecognised layout and an AI read a DRAFT off it; nothing
  // is saved until the user confirms from this phase.
  | 'ai_fallback_review'
  | 'scan_timeout'
  | 'done'
  | 'error';

/** One AI-read transaction line, exactly as the confirm route accepts it. */
interface AiDraftRow {
  transactionDate: string;
  descriptionRaw: string;
  amountOriginal: number;
  creditDebit: 'credit' | 'debit';
  balanceAfter: number | null;
}

interface AiFallbackDraft {
  rows: AiDraftRow[];
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  declaredOpeningBalance: number | null;
  declaredClosingBalance: number | null;
  allTransactionsListed: boolean;
  warnings: string[];
}

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_file_type: 'Unsupported file type. Only PDF and CSV files are accepted.',
  mime_mismatch: 'This file does not actually look like the type it claims to be.',
  file_corrupt: 'This file appears to be corrupted or unreadable.',
  file_too_large: 'This file is too large.',
  password_required: 'This PDF is password-protected. Enter its password to continue.',
  password_invalid: 'The password provided could not open this document.',
  // 2026-09-21 — deliberately does NOT say "malware" or "virus": this check
  // (`lib/shared/pdfStructuralScan.ts`) is a structural/heuristic scan for a
  // specific known bypass technique, not a real malware scanner, and the
  // user-facing message must not overclaim what actually happened.
  structural_scan_rejected: 'This PDF could not be accepted because it failed a security check on its internal structure. Please try re-exporting or re-saving the document and upload it again.',
  ocr_required: 'This PDF appears to be a scanned image rather than a text statement, so it cannot be read automatically.',
  page_limit_exceeded: 'This statement has too many pages to process automatically.',
  layout_unsupported: 'This statement’s layout is not one FHIP currently recognises.',
  format_ambiguous: 'FHIP could not confidently tell which columns hold your transactions.',
  extraction_low_confidence: 'FHIP could not read this statement with enough confidence to certify it.',
  data_validation_failed: 'The extracted data on this statement did not pass basic checks.',
  internal_error: 'Something went wrong while processing this upload.',
  // 2026-09-21 (real-malware-gate async fix) — deliberately does NOT say
  // "malware" or "virus", same discipline as structural_scan_rejected above:
  // a real scan verdict, but the user-facing copy stays calm and generic.
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again.',
};

interface ProcessSummary {
  transactionsCreated: number;
  duplicatesSkipped: number;
  reconciliationStatus: string | null;
  /** 2026-09-25: this upload was a byte-identical copy of a statement already
   * imported; nothing was read again and nothing new was created. */
  alreadyImported?: boolean;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export function BankStatementImportPanel({ onClose }: { onClose: () => void }) {
  const [country, setCountry] = useState<'AU' | 'IN'>('AU');
  const [currency, setCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [maskedIdentifier, setMaskedIdentifier] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // App Review 2026-09-14, item 2: this panel used to always render as a
  // fully working upload form and only discover the FDH-3 production hard
  // gate (see lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed — a dead-end that read as a broken button rather
  // than a known, temporary limitation. `null` = not checked yet (render
  // nothing that could flash and disappear); `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // AIE bank-statement AI-fallback (2026-09-23). Held only for the lifetime of
  // the `ai_fallback_review` phase; cleared by `reset()` and on confirm.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  // Real-malware-gate async fix (2026-09-21): cancels an in-flight status
  // poll if the panel unmounts mid-scan.
  const scanPollCancelRef = useRef({ cancelled: false });
  useEffect(() => () => {
    scanPollCancelRef.current.cancelled = true;
  }, []);
  // 2026-09-25: AI readings this user left unchecked. Before, closing the
  // panel or reloading the page stranded a reading that had been paid for --
  // and re-uploading the file paid for another one.
  const { items: waiting, reload: reloadWaiting } = useWaitingImports('bank');

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
    setPassword('');
    setDocumentId(null);
    setMessage(null);
    setSummary(null);
    setAiDraft(null);
  }

  function failWith(errorCode: string | null | undefined, fallback: string) {
    setMessage((errorCode && FAILURE_MESSAGES[errorCode]) ?? fallback);
    setPhase('error');
  }

  /** Removes one AI-read line the user judges wrong. Deletion is the only
   * per-row edit offered here, deliberately: a statement can carry dozens of
   * lines, and an inline editable grid for all of them would duplicate the
   * review workspace at /financial-data-hub/review that already exists for
   * exactly that job — and which the user reaches straight after saving.
   * Removing a line the model hallucinated or double-counted is the one
   * correction that must happen BEFORE the write, because it is the one the
   * balance check will otherwise trip on. */
  function removeAiDraftRow(index: number) {
    setAiDraft((d) => (d ? { ...d, rows: d.rows.filter((_, i) => i !== index) } : d));
  }

  async function handleConfirmAiDraft() {
    if (!aiDraft || !documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/bank-pdf/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: aiDraft.rows,
          statementPeriodStart: aiDraft.statementPeriodStart,
          statementPeriodEnd: aiDraft.statementPeriodEnd,
          declaredOpeningBalance: aiDraft.declaredOpeningBalance,
          declaredClosingBalance: aiDraft.declaredClosingBalance,
          maskedAccountIdentifier: aiDraft.maskedAccountIdentifier,
        }),
      });
      const { ok: confirmOk, json } = await readJson(res);
      if (!confirmOk) {
        setMessage(json.error ?? 'We could not save this statement.');
        setPhase('error');
        return;
      }
      const data = json.data ?? {};
      // Best-effort auto-classification, exactly as the native success path
      // does it — an AI-fallback import must land in the same state a native
      // one does, including this.
      try {
        await fetch('/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
      } catch {
        // Best-effort only; transactions are still correctable by hand.
      }
      setAiDraft(null);
      reloadWaiting();
      setSummary({
        transactionsCreated: data.transactions_created ?? 0,
        duplicatesSkipped: data.duplicates_skipped ?? 0,
        reconciliationStatus: data.reconciliation_status ?? null,
      });
      setPhase('done');
    } finally {
      setBusy(false);
    }
  }

  // Runs the real parse for an already-uploaded document: `detect` (CSV
  // only — bank-PDF's own pipeline detects layout internally) then
  // `process`, mirroring exactly what LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md
  // proved works end-to-end (upload -> detect -> process -> categorise ->
  // approve). `password` is only ever sent on the bank-PDF path, and only
  // once the upload step has already told us this document needs one.
  async function runProcessing(docId: string, csv: boolean, pdfPassword?: string, knownCopy = false) {
    setPhase('processing');
    setMessage(null);

    // A byte-identical copy of a statement already imported is never read
    // again (2026-09-25): processing answers straight away with the original,
    // so format detection is skipped too.
    if (csv && !knownCopy) {
      const detectRes = await fetch(`/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
      const { ok: detectOk, json: detectJson } = await readJson(detectRes);
      if (!detectOk) {
        setMessage(detectJson.error ?? 'We could not determine the format of this file.');
        setPhase('error');
        return;
      }
    }

    const processRes = csv
      ? await fetch(`/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' })
      : await fetch(`/api/financial-data-hub/bank-pdf/${docId}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pdfPassword ? { password: pdfPassword } : {}),
        });
    const { ok: processOk, json: processJson } = await readJson(processRes);
    if (!processOk) {
      setMessage(processJson.error ?? 'We could not process this bank statement.');
      setPhase('error');
      return;
    }

    const data = processJson.data ?? {};
    // 2026-09-25: a re-upload of a statement already imported. Nothing was
    // read and nothing new was created; say so and point at the review page.
    if (data.duplicate && data.pipeline_status !== 'ai_fallback_available') {
      setMessage(DUPLICATE_UPLOAD_MESSAGE);
      setSummary({
        transactionsCreated: 0,
        duplicatesSkipped: data.duplicates_skipped ?? 0,
        reconciliationStatus: data.reconciliation_status ?? null,
        alreadyImported: true,
      });
      setPhase('done');
      return;
    }
    // AIE bank-statement AI-fallback. Checked BEFORE the password branch
    // (2026-09-25): a draft means the file was already read, so a password
    // code still on the document must not send the user back to the password
    // prompt -- that is how a resumed draft would otherwise dead-end. For a
    // re-upload, `document_id` is the ORIGINAL upload whose reading awaits a
    // check, and the confirm goes there.
    if (data.pipeline_status === 'ai_fallback_available' && data.ai_fallback_draft) {
      setDocumentId((data.document_id as string | undefined) ?? docId);
      setMessage(data.duplicate_of_document_id ? DUPLICATE_UPLOAD_MESSAGE : null);
      setAiDraft(data.ai_fallback_draft as AiFallbackDraft);
      setPhase('ai_fallback_review');
      return;
    }
    if (data.error_code === 'password_required' || data.error_code === 'password_invalid') {
      if (data.error_code === 'password_invalid') setPassword('');
      setMessage(data.error_code === 'password_invalid' ? FAILURE_MESSAGES.password_invalid : null);
      setPhase('awaiting_password');
      return;
    }
    // (The AI-fallback draft branch, 2026-09-23, now sits above the password
    // branch -- see there. It must stay before the generic `error_code`
    // branch below, or a perfectly good draft would be read as a failure.)

    if (data.error_code) {
      failWith(data.error_code, 'This file could not be processed.');
      return;
    }

    // R8/FDH-6's own real, already-certified auto-classification pass
    // (`classifyUserTransactions`, exposed at this route) is not invoked by
    // ANY surface in the app today, including the pre-existing direct
    // `/financial-data-hub` DEV upload page — every newly-processed
    // transaction is persisted `economic_transaction_type = 'unknown'` and
    // stays that way until either this runs or a human corrects each row.
    // That is a separate, pre-existing, app-wide gap this fix does not
    // otherwise attempt to close — but calling this already-built, safe,
    // idempotent endpoint here (best-effort; never blocks the "done" state
    // on failure) means transactions imported through Expenses at least
    // arrive already classified wherever an existing rule matches, instead
    // of 100% "Uncategorised" for a reviewer to fix by hand.
    try {
      await fetch('/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
    } catch {
      // Best-effort only — the transactions still exist and are correctable
      // by hand at /financial-data-hub/review if this call fails.
    }

    setSummary({
      transactionsCreated: data.transactions_created ?? 0,
      duplicatesSkipped: data.duplicates_skipped ?? 0,
      reconciliationStatus: data.reconciliation_status ?? null,
    });
    setPhase('done');
  }

  async function handleUpload() {
    if (!file) return;
    const csv = file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv');
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    try {
      const params = new URLSearchParams({ country_code: country, currency_code: currency });
      if (maskedIdentifier) params.set('masked_identifier', maskedIdentifier);
      if (file.name) params.set('filename', file.name);

      const uploadRes = await fetch(
        `/api/financial-data-hub/${csv ? 'bank-csv' : 'bank-pdf'}/upload?${params.toString()}`,
        { method: 'POST', headers: { 'Content-Type': csv ? 'text/csv' : 'application/pdf' }, body: file },
      );
      const { ok: uploadOk, json: uploadJson } = await readJson(uploadRes);
      if (!uploadOk) {
        setMessage(uploadJson.error ?? 'Could not upload this statement.');
        setPhase('error');
        return;
      }
      const data = uploadJson.data ?? {};
      const docId = data.document_id as string;
      setDocumentId(docId);

      // 2026-09-25: a byte-identical re-upload of a statement already imported
      // (or whose AI reading awaits a check). Go straight to the original --
      // no account question, no password prompt, no second read.
      if (data.duplicate_of_document_id) {
        await runProcessing(docId, csv, undefined, true);
        return;
      }

      if (data.account_resolution === 'ambiguous') {
        setMessage(
          'We couldn’t automatically match this statement to one of your accounts. Try adding the last few digits of the account or card number above and uploading again.',
        );
        setPhase('error');
        return;
      }

      // Bank PDFs may come back declaring `password_required` at the UPLOAD
      // step (structure-only detection, before any parsing is attempted) —
      // that is not a failure, just a signal to collect a password before
      // calling `process`.
      if (!csv && data.password_required) {
        setPhase('awaiting_password');
        return;
      }
      if (data.error_code) {
        failWith(data.error_code, 'This file could not be uploaded.');
        return;
      }

      // Real-malware-gate async fix (2026-09-21): the upload step may have
      // left this document genuinely, legally waiting in `validating` — the
      // real S3+GuardDuty scan has not resolved yet. Calling detect/process
      // immediately in that case used to surface a raw `invalid_state`
      // error even though nothing had gone wrong. Wait for the document to
      // leave `validating` first, showing an honest "scanning" state.
      if (data.processing_status === 'validating') {
        setPhase('scanning');
        setMessage(SCANNING_MESSAGE);
        const waited = await waitForDocumentToLeaveValidating(docId, { signal: scanPollCancelRef.current });
        if (waited.outcome === 'timeout') {
          setMessage(SCAN_TIMEOUT_MESSAGE);
          setPhase('scan_timeout');
          return;
        }
        if (waited.processingStatus === 'failed' || waited.processingStatus === 'rejected') {
          failWith(waited.errorCode, 'This file could not be accepted.');
          return;
        }
        setMessage(null);
      }

      await runProcessing(docId, csv);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  /** Continue an AI reading left unchecked (2026-09-25). */
  function resumeWaiting(item: WaitingImport) {
    if (item.stage !== 'ai_draft' || !item.ai_fallback_draft) return;
    setDocumentId(item.document_id);
    setMessage(null);
    setAiDraft(item.ai_fallback_draft as AiFallbackDraft);
    setPhase('ai_fallback_review');
  }

  async function handleSubmitPassword() {
    if (!documentId || !password) return;
    setBusy(true);
    try {
      await runProcessing(documentId, false, password);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="region" aria-label="Import bank statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import bank statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close bank statement import">
          Close
        </button>
      </div>

      {uploadEnabled === false && phase === 'form' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Statement import isn&apos;t turned on in this environment yet. You can still add these transactions
            yourself using the Expenses list below.
          </p>
        </div>
      )}

      {phase === 'form' && <WaitingImportsList items={waiting} busy={busy} onContinue={resumeWaiting} />}

      {uploadEnabled !== false && phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a bank statement (PDF or CSV) and FHIP will extract your transactions for you to review and
            approve. Approved transactions count toward your Monthly Surplus automatically — nothing here changes
            your totals until you approve it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Country this statement is from</span>
              <select
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={country}
                onChange={(e) => {
                  const c = e.target.value as 'AU' | 'IN';
                  setCountry(c);
                  setCurrency(c === 'AU' ? 'AUD' : 'INR');
                }}
              >
                <option value="AU">Australia</option>
                <option value="IN">India</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Account / card number (last few digits, optional)</span>
              <input
                className="w-full rounded border border-gray-300 px-3 py-2"
                placeholder="e.g. 1234"
                value={maskedIdentifier}
                onChange={(e) => setMaskedIdentifier(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement file (PDF or CSV, up to 20MB)</span>
            <input
              type="file"
              accept="application/pdf,text/csv"
              className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || busy || uploadEnabled !== true}
            className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Upload statement
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'processing' || phase === 'scanning') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' && 'Uploading your statement…'}
          {phase === 'scanning' && (message ?? SCANNING_MESSAGE)}
          {phase === 'processing' && 'Processing your statement — extracting transactions…'}
        </p>
      )}

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not recognise this statement&apos;s layout automatically, so we used AI to read it instead. Please
            check these transactions before saving — <strong>nothing has been saved yet</strong>.
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">Institution</dt>
              <dd>{aiDraft.institutionName ?? 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Period</dt>
              <dd>
                {aiDraft.statementPeriodStart ?? '?'} to {aiDraft.statementPeriodEnd ?? '?'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Opening balance</dt>
              <dd>{aiDraft.declaredOpeningBalance ?? 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Closing balance</dt>
              <dd>{aiDraft.declaredClosingBalance ?? 'Not shown'}</dd>
            </div>
          </dl>

          {!aiDraft.allTransactionsListed && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The AI reported that it could <strong>not</strong> list every transaction on this statement. If you save
              this, the import will be incomplete — we recommend adding the missing transactions by hand afterwards, or
              trying a different file.
            </p>
          )}

          <div>
            <p className="mb-2 text-sm text-muted">
              {aiDraft.rows.length} transaction{aiDraft.rows.length === 1 ? '' : 's'} read. Remove any line that is
              wrong or is not really a transaction.
            </p>
            <div className="max-h-80 overflow-y-auto rounded border border-gray-200">
              <table className="w-full text-sm">
                <caption className="sr-only">Transactions read from this statement by AI, awaiting your confirmation</caption>
                <thead className="sticky top-0 bg-gray-50 text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2">Date</th>
                    <th scope="col" className="px-3 py-2">Description</th>
                    <th scope="col" className="px-3 py-2 text-right">Amount</th>
                    <th scope="col" className="px-3 py-2">In/Out</th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aiDraft.rows.map((row, i) => (
                    <tr key={`${row.transactionDate}-${i}`} className="border-t border-gray-100">
                      <td className="px-3 py-2 whitespace-nowrap">{row.transactionDate}</td>
                      <td className="px-3 py-2">{row.descriptionRaw}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.amountOriginal.toFixed(2)}</td>
                      <td className="px-3 py-2">{row.creditDebit === 'credit' ? 'In' : 'Out'}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeAiDraftRow(i)}
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        >
                          Remove<span className="sr-only"> the {row.descriptionRaw} transaction on {row.transactionDate}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only. When you save, we check these transactions against the
            statement&apos;s own opening and closing balances — exactly as we do for a statement we read automatically —
            and flag the import for review if they do not add up.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                // 2026-09-25: recorded on the server too, so the reading is not
                // offered again as something to continue.
                if (documentId) void discardAiDraft(documentId).then(reloadWaiting);
                setAiDraft(null);
                setMessage(FAILURE_MESSAGES.layout_unsupported);
                setPhase('error');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || aiDraft.rows.length === 0}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save these transactions
            </button>
          </div>
        </div>
      )}

      {phase === 'scan_timeout' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? SCAN_TIMEOUT_MESSAGE}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
        </div>
      )}

      {phase === 'awaiting_password' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? FAILURE_MESSAGES.password_required}</p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement password</span>
            <input
              type="password"
              className="w-full max-w-xs rounded border border-gray-300 px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleSubmitPassword}
              disabled={!password || busy}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Continue
            </button>
            <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
        </div>
      )}

      {phase === 'done' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {summary?.alreadyImported
              ? `${DUPLICATE_UPLOAD_MESSAGE} Nothing new was added.`
              : summary && summary.transactionsCreated > 0
              ? `Done. ${summary.transactionsCreated} transaction${summary.transactionsCreated === 1 ? '' : 's'} extracted${
                  summary.duplicatesSkipped > 0
                    ? ` (${summary.duplicatesSkipped} already-imported duplicate${summary.duplicatesSkipped === 1 ? '' : 's'} skipped)`
                    : ''
                } — ready for your review.`
              : summary && summary.duplicatesSkipped > 0
                ? `Done. Every transaction on this statement was already imported (${summary.duplicatesSkipped} duplicate${summary.duplicatesSkipped === 1 ? '' : 's'} skipped).`
                : 'Done. This statement has been processed.'}
          </p>
          <a href="/financial-data-hub/review" className="inline-block rounded bg-trust px-4 py-2 text-sm text-white">
            Review and approve transactions
          </a>
          <button type="button" onClick={reset} className="ml-3 rounded border border-gray-300 px-3 py-1 text-sm">
            Upload another
          </button>
        </div>
      )}
    </div>
  );
}
