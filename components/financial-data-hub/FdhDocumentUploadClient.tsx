'use client';

import { useCallback, useEffect, useState } from 'react';
import { FDH_COUNTRY_CODES, FDH_DOCUMENT_TYPES } from '@/lib/financial-data-hub/constants/enums';

type DocumentListItem = {
  document: {
    id: string;
    document_type: string | null;
    country_code: string | null;
    processing_status: string;
    error_code: string | null;
    raw_document_purge_status: string;
    created_at: string;
  };
  statusLabel: string;
};

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  bank_statement: 'Bank statement',
  credit_card_statement: 'Credit card statement',
  loan_statement: 'Loan statement',
  payslip: 'Payslip',
  investment_statement: 'Investment statement',
  super_statement: 'Superannuation statement',
  epf_statement: 'EPF statement',
  nps_statement: 'NPS statement',
  tax_document: 'Tax document',
  other: 'Other financial document',
};

// Unsupported-file / failure user-facing copy (spec section 38) — never an
// internal enum name or a stack trace.
const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_file_type: 'Unsupported file type. Only PDF and CSV files are accepted.',
  file_corrupt: 'This file appears to be corrupted or unreadable.',
  password_required: 'This PDF is password-protected. Password-protected statements will be supported by a future processing step.',
  password_invalid: 'The password provided could not open this document.',
  internal_error: 'Something went wrong while processing this upload.',
};

export function FdhDocumentUploadClient({ uploadEnabled }: { uploadEnabled: boolean }) {
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [documentType, setDocumentType] = useState<string>('bank_statement');
  const [countryCode, setCountryCode] = useState<string>('AU');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'validating' | 'error' | 'done'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // No synchronous setState at the top of this function — `loading` starts
  // `true` (its initial useState value covers the first call) and is only
  // ever set from inside the `finally` block, after the `await` above it,
  // which is not a "setState synchronously within an effect" pattern.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/financial-data-hub/documents');
      const json = await res.json();
      if (res.ok) setDocuments(json.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleUpload() {
    if (!file) return;
    setPhase('uploading');
    setErrorMessage(null);
    try {
      const mimeType = file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/pdf';
      const sessionRes = await fetch('/api/financial-data-hub/documents/upload-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_type: documentType,
          source_type: mimeType === 'text/csv' ? 'csv' : 'pdf_native',
          country_code: countryCode,
          declared_mime_type: mimeType,
          declared_file_size_bytes: file.size,
        }),
      });
      const sessionJson = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionJson.error ?? 'Could not start upload');

      setPhase('validating');
      const completeRes = await fetch(
        `/api/financial-data-hub/documents/upload-sessions/${sessionJson.data.session_id}/complete`,
        { method: 'POST', headers: { 'Content-Type': mimeType }, body: file },
      );
      const completeJson = await completeRes.json();
      if (!completeRes.ok) throw new Error(completeJson.error ?? 'Upload failed');
      if (completeJson.data.error_code) {
        setErrorMessage(FAILURE_MESSAGES[completeJson.data.error_code] ?? 'This file could not be processed.');
        setPhase('error');
      } else {
        setPhase('done');
      }
      setFile(null);
      await refresh();
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    }
  }

  async function handleDelete(documentId: string) {
    await fetch(`/api/financial-data-hub/documents/${documentId}`, { method: 'DELETE' });
    await refresh();
  }

  return (
    <div className="space-y-8">
      <div className="rounded border border-gray-200 p-5">
        <h2 className="text-lg font-semibold text-trust">Upload a document</h2>
        {!uploadEnabled && (
          <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Document uploads are not currently enabled in this environment.
          </p>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted">Document type</span>
            <select
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
            >
              {FDH_DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Country</span>
            <select
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
            >
              {FDH_COUNTRY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-muted">File (PDF or CSV, up to 20MB)</span>
          <input
            type="file"
            accept="application/pdf,text/csv"
            className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={!uploadEnabled}
          />
        </label>
        <button
          type="button"
          onClick={handleUpload}
          disabled={!uploadEnabled || !file || phase === 'uploading' || phase === 'validating'}
          className="mt-4 rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {phase === 'uploading' ? 'Uploading…' : phase === 'validating' ? 'Validating…' : 'Upload'}
        </button>
        {phase === 'error' && errorMessage && (
          <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">{errorMessage}</p>
        )}
        {phase === 'done' && <p className="mt-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">Uploaded and queued for processing.</p>}
      </div>

      <div className="rounded border border-gray-200 p-5">
        <h2 className="text-lg font-semibold text-trust">Your documents</h2>
        {loading && <p className="mt-2 text-sm text-muted">Loading…</p>}
        {!loading && documents.length === 0 && <p className="mt-2 text-sm text-muted">No documents uploaded yet.</p>}
        <ul className="mt-3 divide-y divide-gray-100">
          {documents.map(({ document, statusLabel }) => (
            <li key={document.id} className="flex items-center justify-between py-3 text-sm">
              <div>
                <p className="font-medium">{DOCUMENT_TYPE_LABELS[document.document_type ?? 'other'] ?? 'Document'}</p>
                <p className="text-muted">
                  {statusLabel}
                  {document.error_code && FAILURE_MESSAGES[document.error_code]
                    ? ` — ${FAILURE_MESSAGES[document.error_code]}`
                    : ''}
                </p>
              </div>
              {document.raw_document_purge_status !== 'purged' && (
                <button
                  type="button"
                  onClick={() => handleDelete(document.id)}
                  className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
