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

// R3 — Publish to FHIP (spec sections 41-42). Mirrors the shape returned by
// GET /api/investment-intelligence/positions/[id]/preview.
interface PublicationPreview {
  positionId: string;
  eligibility: { status: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'REVIEW_REQUIRED'; blockingReasons: { code: string; message: string }[]; warningReasons: { code: string; message: string }[] };
  owner: { memberId: string | null; resolvedOwner: string | null; memberName: string | null };
  investmentCategory: string | null;
  institution: string | null;
  sourceCountry: string | null;
  sourceCurrency: string | null;
  valuationAsOfDate: string | null;
  certifiedValue: number | null;
  costBaseStatus: string;
  costBaseValue: number | null;
  annualContributionStatus: string;
  targetRegister: string;
  duplicateCandidates: { investmentId: string; matchScore: number; matchedOn: string[]; existingValue: number; existingCurrency: string; existingInstitution: string | null; existingOwner: string }[];
  financialImpact: { currentIncludedValue: number; newPublishedValue: number; manualValueBeingSuperseded: number; netChange: number; currency: string } | null;
  registerAction: string;
  dataQualityStatus: string;
  baseCurrency: { currencyCode: string | null; amount: number | null; rateUsed: number | null; available: boolean; reason?: string };
  alreadyPublished: { publicationId: string; publishedRowId: string | null; status: string } | null;
}

function formatMoney(value: number | null, currency: string | null): string {
  if (value == null) return '—';
  return `${currency ?? ''} ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();
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

  // R3 — Publish to FHIP flow state.
  const [publishPreview, setPublishPreview] = useState<PublicationPreview | null>(null);
  const [publishPositionId, setPublishPositionId] = useState<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishChoice, setPublishChoice] = useState<'new' | string>('new'); // 'new' or a candidate investmentId
  const [publishResultMessage, setPublishResultMessage] = useState<string | null>(null);

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

  async function openPublishPreview(positionId: string) {
    setError(null);
    setPublishResultMessage(null);
    setPublishChoice('new');
    setPublishPositionId(positionId);
    setPublishPreview(null);
    try {
      const res = await fetch(`/api/investment-intelligence/positions/${positionId}/preview`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not build publication preview');
      setPublishPreview(json.data as PublicationPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setPublishPositionId(null);
    }
  }

  function closePublishPreview() {
    setPublishPositionId(null);
    setPublishPreview(null);
    setPublishResultMessage(null);
  }

  async function confirmPublish() {
    if (!publishPositionId) return;
    setPublishBusy(true);
    setError(null);
    try {
      const body: { linkToExistingInvestmentId?: string; acknowledgedNoDuplicate?: boolean } =
        publishChoice === 'new' ? { acknowledgedNoDuplicate: true } : { linkToExistingInvestmentId: publishChoice };
      const res = await fetch(`/api/investment-intelligence/positions/${publishPositionId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Publish failed');
      setPublishResultMessage(
        `Published. Net change to net worth: ${json.data?.financialImpact ? formatMoney(json.data.financialImpact.netChange, json.data.financialImpact.currency) : '—'}.`
      );
      if (selectedId) await loadSummary(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setPublishBusy(false);
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
                    {summary.portfolioTruthStatuses.map((s) => {
                      const holding = summary.holdings.find((h) => h.account_id === s.account_id && h.instrument_id === s.instrument_id);
                      const canPublish = holding && (s.status === 'certified' || s.status === 'certified_with_warnings');
                      return (
                        <li key={`${s.account_id}:${s.instrument_id}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-100 px-2 py-1.5 text-sm">
                          <span className="text-xs text-gray-600">
                            Position {s.account_id.slice(0, 8)}…/{s.instrument_id.slice(0, 8)}…
                          </span>
                          <span className="flex items-center gap-2">
                            <StatusBadge status={s.status} />
                            <button onClick={() => handleCertify(s.account_id, s.instrument_id)} className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200">
                              Re-evaluate
                            </button>
                            {canPublish && (
                              <button onClick={() => openPublishPreview(holding!.id)} className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700">
                                Publish to FHIP
                              </button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* R3 — Publish to FHIP: Preview -> Duplicate/Conflict Review ->
          Net-worth Impact Preview -> Confirm -> Success (spec sections
          41-42). Minimal inline panel, not a full redesign of the module. */}
      {publishPositionId && (
        <section className="rounded-lg border-2 border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Publish to FHIP</h2>
            <button onClick={closePublishPreview} className="text-xs text-gray-500 hover:underline">
              Close
            </button>
          </div>
          {!publishPreview ? (
            <p className="mt-2 text-sm text-gray-500">Loading preview…</p>
          ) : publishResultMessage ? (
            <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{publishResultMessage}</p>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              {publishPreview.eligibility.status === 'NOT_ELIGIBLE' ? (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-800">
                  <p className="font-medium">Not eligible to publish</p>
                  <ul className="mt-1 list-disc pl-4">
                    {publishPreview.eligibility.blockingReasons.map((r) => (
                      <li key={r.code}>{r.message}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <>
                  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-gray-500">Owner</dt>
                      <dd className="font-medium text-gray-900">{publishPreview.owner.memberName ?? publishPreview.owner.resolvedOwner ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Category</dt>
                      <dd className="font-medium text-gray-900">{publishPreview.investmentCategory ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Institution</dt>
                      <dd className="font-medium text-gray-900">{publishPreview.institution ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Certified value ({publishPreview.sourceCurrency})</dt>
                      <dd className="font-medium text-gray-900">{formatMoney(publishPreview.certifiedValue, publishPreview.sourceCurrency)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">As of</dt>
                      <dd className="font-medium text-gray-900">{publishPreview.valuationAsOfDate ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Target register</dt>
                      <dd className="font-medium text-gray-900">{publishPreview.targetRegister}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Cost base</dt>
                      <dd className="font-medium text-gray-900">
                        {publishPreview.costBaseValue != null ? formatMoney(publishPreview.costBaseValue, publishPreview.sourceCurrency) : `Unknown (${publishPreview.costBaseStatus})`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Household currency</dt>
                      <dd className="font-medium text-gray-900">
                        {publishPreview.baseCurrency.available ? formatMoney(publishPreview.baseCurrency.amount, publishPreview.baseCurrency.currencyCode) : `Unavailable — ${publishPreview.baseCurrency.reason}`}
                      </dd>
                    </div>
                  </dl>

                  {publishPreview.alreadyPublished && (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      This position already has an active publication. Use Refresh instead of a first-time publish.
                    </div>
                  )}

                  {publishPreview.duplicateCandidates.length > 0 && !publishPreview.alreadyPublished && (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
                      <p className="font-medium text-amber-900">Possible duplicate of an existing manual investment</p>
                      <div className="mt-2 space-y-1">
                        <label className="flex items-center gap-2">
                          <input type="radio" name="publishChoice" checked={publishChoice === 'new'} onChange={() => setPublishChoice('new')} />
                          <span>This is a new, separate investment — publish as new.</span>
                        </label>
                        {publishPreview.duplicateCandidates.map((c) => (
                          <label key={c.investmentId} className="flex items-center gap-2">
                            <input type="radio" name="publishChoice" checked={publishChoice === c.investmentId} onChange={() => setPublishChoice(c.investmentId)} />
                            <span>
                              This is the same investment as my existing &ldquo;{c.existingInstitution ?? 'manual'}&rdquo; row ({formatMoney(c.existingValue, c.existingCurrency)}) — link and supersede it.
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {publishPreview.financialImpact && (
                    <div className="rounded border border-gray-200 bg-white px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Net-worth impact</p>
                      <p className="mt-1 text-gray-800">
                        {publishChoice !== 'new'
                          ? `Existing manual value ${formatMoney(publishPreview.duplicateCandidates.find((c) => c.investmentId === publishChoice)?.existingValue ?? 0, publishPreview.sourceCurrency)} superseded by certified value ${formatMoney(publishPreview.certifiedValue, publishPreview.sourceCurrency)} — net change ${formatMoney((publishPreview.certifiedValue ?? 0) - (publishPreview.duplicateCandidates.find((c) => c.investmentId === publishChoice)?.existingValue ?? 0), publishPreview.sourceCurrency)}.`
                          : `New position adds ${formatMoney(publishPreview.certifiedValue, publishPreview.sourceCurrency)} to net worth.`}
                      </p>
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    <button onClick={closePublishPreview} className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
                      Cancel
                    </button>
                    <button
                      onClick={confirmPublish}
                      disabled={publishBusy || !!publishPreview.alreadyPublished}
                      className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {publishBusy ? 'Publishing…' : 'Confirm & Publish'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export { TRUTH_STATUS_LABEL };
