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

import { useEffect, useState } from 'react';

type Phase =
  | 'form'
  | 'uploading'
  | 'processing'
  | 'awaiting_password'
  | 'done'
  | 'error';

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_file_type: 'Unsupported file type. Only PDF and CSV files are accepted.',
  mime_mismatch: 'This file does not actually look like the type it claims to be.',
  file_corrupt: 'This file appears to be corrupted or unreadable.',
  file_too_large: 'This file is too large.',
  password_required: 'This PDF is password-protected. Enter its password to continue.',
  password_invalid: 'The password provided could not open this document.',
  ocr_required: 'This PDF appears to be a scanned image rather than a text statement, so it cannot be read automatically.',
  page_limit_exceeded: 'This statement has too many pages to process automatically.',
  layout_unsupported: 'This statement’s layout is not one FHIP currently recognises.',
  format_ambiguous: 'FHIP could not confidently tell which columns hold your transactions.',
  extraction_low_confidence: 'FHIP could not read this statement with enough confidence to certify it.',
  data_validation_failed: 'The extracted data on this statement did not pass basic checks.',
  internal_error: 'Something went wrong while processing this upload.',
};

interface ProcessSummary {
  transactionsCreated: number;
  duplicatesSkipped: number;
  reconciliationStatus: string | null;
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
  }

  function failWith(errorCode: string | null | undefined, fallback: string) {
    setMessage((errorCode && FAILURE_MESSAGES[errorCode]) ?? fallback);
    setPhase('error');
  }

  // Runs the real parse for an already-uploaded document: `detect` (CSV
  // only — bank-PDF's own pipeline detects layout internally) then
  // `process`, mirroring exactly what LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md
  // proved works end-to-end (upload -> detect -> process -> categorise ->
  // approve). `password` is only ever sent on the bank-PDF path, and only
  // once the upload step has already told us this document needs one.
  async function runProcessing(docId: string, csv: boolean, pdfPassword?: string) {
    setPhase('processing');
    setMessage(null);

    if (csv) {
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
    if (data.error_code === 'password_required' || data.error_code === 'password_invalid') {
      if (data.error_code === 'password_invalid') setPassword('');
      setMessage(data.error_code === 'password_invalid' ? FAILURE_MESSAGES.password_invalid : null);
      setPhase('awaiting_password');
      return;
    }
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

      await runProcessing(docId, csv);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    } finally {
      setBusy(false);
    }
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

      {(phase === 'uploading' || phase === 'processing') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' ? 'Uploading your statement…' : 'Processing your statement — extracting transactions…'}
        </p>
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
            {summary && summary.transactionsCreated > 0
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
