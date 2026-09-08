'use client';

/**
 * LR-3 — Expenses Bank Statement Workflow: the Expenses-tab bank-statement
 * import journey.
 *
 * Upload -> processing -> a link to the existing FDH review/approval
 * workspace, where the extracted transactions are corrected and approved.
 * This panel deliberately does NOT re-implement that review UI inline (unlike
 * components/income/PayslipImportPanel.tsx's fully-inlined proposal-compare
 * flow) — a bank statement can extract dozens or hundreds of individual
 * transactions, which already has its own dedicated, more capable review
 * surface at /financial-data-hub/review; duplicating it here would be a
 * second, divergent copy of the same UI. Once a transaction is approved
 * there, it already counts toward Monthly Surplus on its own (see
 * lib/engines/dashboard.ts's LR-3 section) — there is no separate "Apply"
 * step for Expenses the way Income has one (see FDH15_BRIDGE_ARCHITECTURE_
 * INVENTORY.md's documented rationale: approval is the terminal state for
 * this domain, by design).
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

import { useState } from 'react';

type Phase = 'form' | 'uploading' | 'processing' | 'done' | 'error';

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_file_type: 'Unsupported file type. Only PDF and CSV files are accepted.',
  file_corrupt: 'This file appears to be corrupted or unreadable.',
  password_required: 'This PDF is password-protected. Password-protected statements will be supported by a future processing step.',
  password_invalid: 'The password provided could not open this document.',
  internal_error: 'Something went wrong while processing this upload.',
};

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export function BankStatementImportPanel({ onClose }: { onClose: () => void }) {
  const [documentType, setDocumentType] = useState<'bank_statement' | 'credit_card_statement' | 'loan_statement'>('bank_statement');
  const [country, setCountry] = useState<'AU' | 'IN'>('AU');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [message, setMessage] = useState<string | null>(null);

  async function handleUpload() {
    if (!file) return;
    setPhase('uploading');
    setMessage(null);
    try {
      const mimeType = file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/pdf';
      const sessionRes = await fetch('/api/financial-data-hub/documents/upload-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_type: documentType,
          source_type: mimeType === 'text/csv' ? 'csv' : 'pdf_native',
          country_code: country,
          declared_mime_type: mimeType,
          declared_file_size_bytes: file.size,
        }),
      });
      const { ok: sessionOk, json: sessionJson } = await readJson(sessionRes);
      if (!sessionOk) throw new Error(sessionJson.error ?? 'Could not start upload');

      setPhase('processing');
      const completeRes = await fetch(
        `/api/financial-data-hub/documents/upload-sessions/${sessionJson.data.session_id}/complete`,
        { method: 'POST', headers: { 'Content-Type': mimeType }, body: file },
      );
      const { ok: completeOk, json: completeJson } = await readJson(completeRes);
      if (!completeOk) throw new Error(completeJson.error ?? 'Upload failed');
      if (completeJson.data.error_code) {
        setMessage(FAILURE_MESSAGES[completeJson.data.error_code] ?? 'This file could not be processed.');
        setPhase('error');
        return;
      }
      setPhase('done');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    }
  }

  function reset() {
    setPhase('form');
    setFile(null);
    setMessage(null);
  }

  return (
    <div role="region" aria-label="Import bank statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import bank statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close bank statement import">
          Close
        </button>
      </div>

      {phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a bank or credit card statement (PDF or CSV) and FHIP will extract your transactions for you to
            review and approve. Approved transactions count toward your Monthly Surplus automatically — nothing here
            changes your totals until you approve it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Statement type</span>
              <select
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={documentType}
                onChange={(e) => setDocumentType(e.target.value as typeof documentType)}
              >
                <option value="bank_statement">Bank statement</option>
                <option value="credit_card_statement">Credit card statement</option>
                <option value="loan_statement">Loan statement</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Country this statement is from</span>
              <select
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={country}
                onChange={(e) => setCountry(e.target.value as 'AU' | 'IN')}
              >
                <option value="AU">Australia</option>
                <option value="IN">India</option>
              </select>
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
            disabled={!file}
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
            Uploaded. Your transactions are being extracted for review.
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
