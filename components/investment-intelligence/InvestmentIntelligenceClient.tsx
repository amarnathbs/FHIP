'use client';

import { useEffect, useState } from 'react';

// R2 minimal UI (spec section 31): Step 1 Upload, Step 2 Password if
// required, Step 3 Processing status, Step 4 Source identified, Step 5
// Portfolio extracted, Step 6 Review issues, Step 7 Resolve material
// exceptions, Step 8 Portfolio Truth status — implemented as one page with
// a document list (steps 1-2) and a detail panel (steps 3-8) for whichever
// document is selected, rather than a literal wizard, since a user
// realistically manages several statements over time, not one linear flow.

interface SourceDocument {
  id: string;
  status: string;
  original_filename: string;
  document_type: string | null;
  uploaded_at: string;
  country_code: string;
}

interface ReconciliationCase {
  id: string;
  discrepancy_type: string;
  severity: string;
  status: string;
  subject_type: string;
  subject_id: string;
  discrepancy_details: Record<string, unknown> | null;
  opened_at: string;
}

interface DocumentSummary {
  document: {
    id: string;
    status: string;
    source_detected: string | null;
    source_confidence: number | null;
    document_type_detected: string | null;
    statement_period_start: string | null;
    statement_period_end: string | null;
    statement_as_of_date: string | null;
    original_filename: string;
  };
  accountsFound: number;
  accounts: { id: string; folio_number: string | null; institution_name: string }[];
  schemesFound: number;
  transactionsFound: number;
  holdingsFound: number;
  holdings: { id: string; account_id: string; instrument_id: string; as_of_date: string; units: string; value: string; quality_status: string }[];
  reconciliationCases: ReconciliationCase[];
  openReconciliationCaseCount: number;
  portfolioTruthStatuses: { account_id: string; instrument_id: string; status: string; blocking_reasons: unknown[]; warning_reasons: unknown[] }[];
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Uploaded — not yet processed',
  parsing: 'Processing…',
  parsed: 'Parsed',
  parse_failed: 'Parse failed',
  password_required: 'Password required',
  reconciliation_required: 'Needs review',
  unsupported: 'Unsupported document',
  superseded: 'Superseded by a newer statement',
  archived: 'Archived',
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  uploaded: 'bg-gray-100 text-gray-700',
  parsing: 'bg-blue-100 text-blue-700',
  parsed: 'bg-green-100 text-green-700',
  parse_failed: 'bg-red-100 text-red-700',
  password_required: 'bg-amber-100 text-amber-700',
  reconciliation_required: 'bg-amber-100 text-amber-700',
  unsupported: 'bg-red-100 text-red-700',
  superseded: 'bg-gray-100 text-gray-500',
  archived: 'bg-gray-100 text-gray-500',
};

const TRUTH_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  parsed: 'Parsed',
  reconciliation_required: 'Reconciliation required',
  certified_with_warnings: 'Certified (with warnings)',
  certified: 'Certified',
  failed: 'Failed',
  superseded: 'Superseded',
  archived: 'Archived',
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[status] ?? 'bg-gray-100 text-gray-700'}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function InvestmentIntelligenceClient() {
  const [documents, setDocuments] = useState<SourceDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DocumentSummary | null>(null);
  const [passwordInputs, setPasswordInputs] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState<string | null>(null);

  // --- upload form state ---
  const [file, setFile] = useState<File | null>(null);
  const [sourceKey, setSourceKey] = useState<'cams' | 'kfintech'>('cams');
  const [countryCode] = useState<'IN'>('IN');
  const [uploading, setUploading] = useState(false);

  async function loadDocuments() {
    try {
      const res = await fetch('/api/investment-intelligence/source-documents');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load statements');
      setDocuments(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  // Defined AND invoked entirely inside the effect (rather than calling
  // the outer loadDocuments() by reference) so the setState calls are
  // provably deferred past the effect's synchronous body for the
  // react-hooks/set-state-in-effect rule — matching the accepted pattern
  // already used by components/grid/FinancialDataGrid.tsx elsewhere in
  // this codebase. loadDocuments() itself is still reused directly (not
  // via this effect) by every mutation handler below (upload/process/
  // resolve/certify), where calling it is not subject to this rule.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/source-documents');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? 'Could not load statements');
        setDocuments(json.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Something went wrong');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadSummary(id: string) {
    try {
      const res = await fetch(`/api/investment-intelligence/source-documents/${id}/summary`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load summary');
      setSummary(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  function selectDocument(id: string) {
    setSelectedId(id);
    setSummary(null);
    loadSummary(id);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append(
        'meta',
        JSON.stringify({
          sourceKey,
          documentType: 'cas_statement',
          countryCode,
        })
      );
      const res = await fetch('/api/investment-intelligence/source-documents', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Upload failed');
      setFile(null);
      await loadDocuments();
      selectDocument(json.data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setUploading(false);
    }
  }

  async function handleProcess(id: string, forceReparse = false) {
    setProcessing(id);
    setError(null);
    try {
      const res = await fetch(`/api/investment-intelligence/source-documents/${id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInputs[id] || undefined, forceReparse }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Processing failed');
      // Password is deliberately cleared from local state immediately
      // after the request completes — the browser must not keep holding
      // it in memory/state longer than needed for the one request.
      setPasswordInputs((prev) => ({ ...prev, [id]: '' }));
      await loadDocuments();
      await loadSummary(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setProcessing(null);
    }
  }

  async function handleResolveCase(caseId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/investment-intelligence/reconciliation-cases/${caseId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: 'accepted_new_value', resolutionMethod: 'user_accepted_anomaly' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not resolve case');
      if (selectedId) await loadSummary(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  async function handleCertify(accountId: string, instrumentId: string) {
    setError(null);
    try {
      const res = await fetch('/api/investment-intelligence/portfolio-truth/certify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, instrumentId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not evaluate certification');
      if (selectedId) await loadSummary(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  return (
    <div className="space-y-6">
      {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {/* Step 1: Upload */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Step 1 — Upload a statement</h2>
        <form onSubmit={handleUpload} className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600">Statement source</label>
            <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value as 'cams' | 'kfintech')} className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm">
              <option value="cams">CAMS</option>
              <option value="kfintech">KFintech</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">PDF or CSV file</label>
            <input
              type="file"
              accept=".pdf,.csv,application/pdf,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block text-sm"
            />
          </div>
          <button type="submit" disabled={!file || uploading} className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </form>
        <p className="mt-2 text-xs text-gray-500">
          Only the statement bytes are uploaded here — nothing is parsed yet. R2 detects the source from the document itself; the dropdown above is a
          hint, not a guarantee.
        </p>
      </section>

      {/* Document list */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Your statements</h2>
        {!documents ? (
          <p className="mt-2 text-sm text-gray-500">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No statements uploaded yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button className="text-left text-sm font-medium text-gray-900 hover:underline" onClick={() => selectDocument(doc.id)}>
                  {doc.original_filename}
                </button>
                <div className="flex items-center gap-2">
                  <StatusBadge status={doc.status} />
                  {doc.status === 'password_required' && (
                    <input
                      type="password"
                      placeholder="Document password"
                      value={passwordInputs[doc.id] ?? ''}
                      onChange={(e) => setPasswordInputs((prev) => ({ ...prev, [doc.id]: e.target.value }))}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    />
                  )}
                  {doc.status !== 'parsed' && doc.status !== 'archived' && doc.status !== 'superseded' && (
                    <button
                      onClick={() => handleProcess(doc.id)}
                      disabled={processing === doc.id}
                      className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                    >
                      {processing === doc.id ? 'Processing…' : doc.status === 'password_required' ? 'Submit password & process' : 'Process'}
                    </button>
                  )}
                  {doc.status === 'parsed' && (
                    <button onClick={() => handleProcess(doc.id, true)} disabled={processing === doc.id} className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200">
                      Reprocess
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Detail panel: steps 3-8 */}
      {selectedId && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Statement detail</h2>
          {!summary ? (
            <p className="mt-2 text-sm text-gray-500">Loading…</p>
          ) : (
            <div className="mt-3 space-y-4">
              {/* Step 4: Source identified */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Source identified</h3>
                <p className="mt-1 text-sm text-gray-800">
                  {summary.document.source_detected ? summary.document.source_detected.toUpperCase() : 'Not yet identified'}
                  {summary.document.source_confidence != null && ` (confidence ${(summary.document.source_confidence * 100).toFixed(0)}%)`}
                </p>
                {(summary.document.statement_period_start || summary.document.statement_period_end) && (
                  <p className="text-xs text-gray-500">
                    Statement period: {summary.document.statement_period_start ?? '?'} to {summary.document.statement_period_end ?? '?'}
                  </p>
                )}
              </div>

              {/* Step 5: Portfolio extracted */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Portfolio extracted</h3>
                <dl className="mt-1 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-gray-500">Accounts/folios</dt>
                    <dd className="font-medium text-gray-900">{summary.accountsFound}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Schemes</dt>
                    <dd className="font-medium text-gray-900">{summary.schemesFound}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Transactions</dt>
                    <dd className="font-medium text-gray-900">{summary.transactionsFound}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Holdings</dt>
                    <dd className="font-medium text-gray-900">{summary.holdingsFound}</dd>
                  </div>
                </dl>
              </div>

              {/* Step 6/7: Review + resolve issues */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Reconciliation issues ({summary.openReconciliationCaseCount} open)
                </h3>
                {summary.reconciliationCases.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-500">No issues raised for this statement.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {summary.reconciliationCases.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-100 px-2 py-1.5 text-sm">
                        <span>
                          <span className="font-medium text-gray-900">{c.discrepancy_type.replace(/_/g, ' ')}</span>{' '}
                          <span className="text-xs text-gray-500">({c.severity}, {c.status})</span>
                        </span>
                        {c.status !== 'resolved' && c.status !== 'dismissed' && (
                          <button onClick={() => handleResolveCase(c.id)} className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white">
                            Resolve
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Step 8: Portfolio Truth status */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Portfolio Truth status</h3>
                {summary.portfolioTruthStatuses.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-500">No positions evaluated yet for this statement.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {summary.portfolioTruthStatuses.map((s) => (
                      <li key={`${s.account_id}:${s.instrument_id}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-100 px-2 py-1.5 text-sm">
                        <span className="text-xs text-gray-600">
                          Position {s.account_id.slice(0, 8)}…/{s.instrument_id.slice(0, 8)}…
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge status={s.status} />
                          <button onClick={() => handleCertify(s.account_id, s.instrument_id)} className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200">
                            Re-evaluate
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export { TRUTH_STATUS_LABEL };
