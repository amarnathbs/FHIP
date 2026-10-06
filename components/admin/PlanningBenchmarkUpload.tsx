'use client';

// Planning Benchmarks - staged upload (finding F5). Download a template, upload the filled file, read the
// check result and the preview against today's live figures, then (only with the separate activate
// permission) Activate. Nothing is live until Activate. Every decision shown here comes from the
// capability-gated API; nothing in this file decides authorisation (Admin Standard section 4, layer 4).
//
// RESULT STATES (Standard section 8/13): loading, a 403 (no permission), a 503 (feature not installed or
// unavailable) and an empty history are all different things on screen. A failure is never shown as an
// empty list.
//
// Dates: every date a person reads is day-first (dd/mm/yyyy). Dates inside the files are machine data.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { actionFailureMessage, failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import { formatDayFirstDateTime } from '@/lib/planning-benchmarks/dayFirst';
import { KIND_LABEL, UPLOAD_KINDS, XLSX_DATA_SHEET, type UploadKind } from '@/lib/planning-benchmarks/uploadSchema';

interface KindInfo {
  kind: UploadKind;
  label: string;
  purpose: string;
  templateVersion: string;
}
interface BatchRow {
  id: string;
  kind: UploadKind;
  dataset_name: string;
  dataset_version: string;
  file_name: string;
  status: 'staged' | 'activated' | 'discarded';
  row_count: number;
  counts: Record<string, number>;
  staged_at: string;
  expires_at: string;
  activated_at: string | null;
  self_activated: boolean;
  discarded_at: string | null;
  stagedByMe: boolean;
}
interface StatusPayload {
  state: 'ok' | 'unavailable';
  reason?: string;
  capabilities?: { upload: boolean; activate: boolean };
  limits?: { maxBytes: number; maxRows: number };
  kinds?: KindInfo[];
  rules?: string[];
  batches?: BatchRow[];
}
interface Issue {
  severity: 'error' | 'warning';
  code: string;
  rowNumber: number | null;
  column: string | null;
  message: string;
}
type StageResult =
  | { status: 'rejected'; stage: string; problems: Array<{ code: string; message: string }>; issues: Issue[]; errorCount: number; warningCount: number; issuesTruncated: boolean }
  | { status: 'needs_sheet'; sheets: Array<{ name: string; state: string; rowCount: number | null }>; problems: Array<{ message: string }> }
  | { status: 'staged' | 'already_staged'; batchId: string; counts: Record<string, number> | null; warnings: Issue[]; warningCount: number };
interface PreviewRow {
  row_no: number;
  classification: 'new' | 'changed' | 'unchanged' | 'conflict';
  detail: string | null;
  metric_code: string | null;
  cohort_code: string | null;
  statistic_type: string | null;
  band_label: string | null;
  band_tier: string | null;
  new_value: string | null;
  new_lower: string | null;
  new_upper: string | null;
  live_value: string | null;
  live_lower: string | null;
  live_upper: string | null;
  cohort_tier: string | null;
  cohort_description: string | null;
}
interface Preview {
  batch: {
    id: string;
    kind: UploadKind;
    dataset_name: string;
    dataset_version: string;
    file_name: string;
    file_sha256: string;
    status: 'staged' | 'activated' | 'discarded';
    row_count: number;
    counts: Record<string, number>;
    staging_digest: string;
    staged_by_me: boolean;
    staged_at: string;
    expires_at: string;
    result: Record<string, number | string> | null;
  };
  readiness_errors: string[];
  blockers: string[];
  rows: PreviewRow[];
  rows_truncated: boolean;
  removed: Array<{ metric_code: string; band_label: string; band_tier: number; lower: string | null; upper: string | null }>;
  capabilities: { upload: boolean; activate: boolean };
}

const CLASS_LABEL: Record<PreviewRow['classification'], string> = {
  new: 'New',
  changed: 'Replaces a live figure',
  unchanged: 'Same as live (left alone)',
  conflict: 'Conflict',
};
const STATUS_LABEL: Record<BatchRow['status'], string> = { staged: 'Staged (not live)', activated: 'Activated (live)', discarded: 'Discarded' };

function num(v: string | null): string {
  if (v === null || v === undefined) return 'none';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 4 }) : v;
}

export function PlanningBenchmarkUpload() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [renderedAtMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<UploadKind>('values');
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [sheets, setSheets] = useState<Array<{ name: string; state: string; rowCount: number | null }> | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stageResult, setStageResult] = useState<StageResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState<'all' | PreviewRow['classification']>('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selfAck, setSelfAck] = useState(false);
  const [discardReason, setDiscardReason] = useState('');
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/benchmarks/upload');
      const json = await readJsonSafely(res);
      if (!res.ok) {
        setFailure(failureFromResponse(res.status, json, 'the planning benchmark upload area'));
        setStatus(null);
        return;
      }
      setFailure(null);
      setStatus((json?.data as StatusPayload) ?? null);
    } catch (e) {
      setFailure(failureFromThrown(e, 'the planning benchmark upload area'));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadStatus(), 0);
    return () => clearTimeout(t);
  }, [loadStatus]);

  const loadPreview = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/admin/benchmarks/upload/${id}`);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'open this preview'));
        return;
      }
      setPreview(json?.data as Preview);
      setFilter('all');
      setSelfAck(false);
      setDiscardReason('');
    } catch {
      reportFailure('Could not reach the server, so the preview was not loaded.');
    }
  }, [reportFailure]);

  async function submit(chosenSheet?: string) {
    if (!file) return;
    setBusy(true);
    clearOutcome();
    setPreview(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('params', JSON.stringify({ kind, ...(chosenSheet ? { sheetName: chosenSheet } : {}), includeHiddenRows: includeHidden }));
      const res = await fetch('/api/admin/benchmarks/upload', { method: 'POST', body: form });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'stage this file'));
        setStageResult(null);
        return;
      }
      const r = json?.data as StageResult;
      setStageResult(r);
      if (r.status === 'needs_sheet') {
        setSheets(r.sheets);
        setSheetName(r.sheets.find((s) => s.name === XLSX_DATA_SHEET)?.name ?? '');
      } else {
        setSheets(null);
      }
      if (r.status === 'staged' || r.status === 'already_staged') {
        reportSuccess(r.status === 'staged' ? 'The file passed every check and is staged. Nothing is live yet. Review the preview below.' : 'This exact file is already staged. Its preview is shown below.');
        await loadPreview(r.batchId);
        await loadStatus();
      }
    } catch {
      reportFailure('Could not reach the server, so nothing was staged.');
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!preview) return;
    setBusy(true);
    clearOutcome();
    try {
      const res = await fetch(`/api/admin/benchmarks/upload/${preview.batch.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          expectedSha256: preview.batch.file_sha256,
          expectedDigest: preview.batch.staging_digest,
          expectedCounts: preview.batch.counts,
          selfActivationAck: selfAck,
        }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'activate this upload'));
        await loadPreview(preview.batch.id);
        return;
      }
      reportSuccess('Activated. The figures are now live for every FHIP user and the change is recorded in the Update / audit log tab.');
      await loadPreview(preview.batch.id);
      await loadStatus();
    } catch {
      reportFailure('Could not reach the server, so nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!preview) return;
    setBusy(true);
    clearOutcome();
    try {
      const res = await fetch(`/api/admin/benchmarks/upload/${preview.batch.id}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: discardReason.trim() || null }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'discard this upload'));
        return;
      }
      reportSuccess('Discarded. Nothing was ever live, so no live figure changed.');
      setPreview(null);
      setStageResult(null);
      await loadStatus();
    } catch {
      reportFailure('Could not reach the server, so nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !status) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-muted">
        Loading the upload area…
      </p>
    );
  }
  if (failure) {
    return (
      <div role={failure.retryable ? 'alert' : 'status'} className={`rounded-card border p-4 text-sm ${failure.retryable ? 'border-risk/40 bg-risk/5' : 'border-line bg-white'}`}>
        <p className={`font-semibold ${failure.retryable ? 'text-risk' : 'text-ink'}`}>{failure.title}</p>
        <p className="mt-1 text-muted">{failure.message}</p>
        {failure.retryable && (
          <button type="button" onClick={() => void loadStatus()} className="mt-3 min-h-11 rounded border border-risk/30 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/10">
            Retry
          </button>
        )}
      </div>
    );
  }
  if (!status) return null;
  if (status.state === 'unavailable') {
    return (
      <div role="status" className="rounded-card border border-attention/40 bg-attention/5 p-4 text-sm">
        <p className="font-semibold text-ink">The upload feature is not installed on this database yet.</p>
        <p className="mt-1 text-muted">{status.reason}</p>
      </div>
    );
  }

  const caps = status.capabilities ?? { upload: false, activate: false };
  const maxMb = (status.limits?.maxBytes ?? 0) / 1024 / 1024;
  const shownRows = preview ? preview.rows.filter((r) => filter === 'all' || r.classification === filter) : [];
  const canActivate = !!preview && caps.activate && preview.batch.status === 'staged' && preview.blockers.length === 0 && (!preview.batch.staged_by_me || selfAck);
  const canDiscard = !!preview && preview.batch.status === 'staged' && (caps.activate || (caps.upload && preview.batch.staged_by_me));
  const c = preview?.batch.counts ?? {};

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmOpen}
        title="Activate this upload?"
        message={
          preview
            ? `"${preview.batch.dataset_name}" ${preview.batch.dataset_version}: the figures in ${preview.batch.file_name} will go live for every FHIP user now. ${c.new ?? 0} will be added, ${c.changed ?? 0} existing figure(s) will be replaced (kept as history), ${c.unchanged ?? 0} are the same and left alone${c.removed ? `, and ${c.removed} band(s) not in the file will be taken out of service` : ''}. To change them afterwards you upload a corrected file.`
            : ''
        }
        confirmLabel="Activate and make live"
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={() => {
          setConfirmOpen(false);
          void activate();
        }}
        onCancel={() => setConfirmOpen(false)}
      />

      <AdminActionStatus outcome={outcome} />

      <section aria-labelledby="pb-up-templates" className="rounded-card border border-line bg-white p-4">
        <h2 id="pb-up-templates" className="text-base font-semibold text-ink">
          1. Download a template
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Benchmark figures are published once a year or less often, as spreadsheets or PDFs. There is no automatic feed: download the template, fill it from the publisher&apos;s file, and upload it here. One file loads one dataset and one kind of data. The header is always row 1.
        </p>
        <ul className="mt-3 space-y-2">
          {(status.kinds ?? []).map((k) => (
            <li key={k.kind} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="min-w-48 font-medium text-ink">{k.label}</span>
              <a className="min-h-11 content-center text-trust underline" href={`/api/admin/benchmarks/upload/templates/${k.kind}?format=csv`} download>
                CSV template
              </a>
              <a className="min-h-11 content-center text-trust underline" href={`/api/admin/benchmarks/upload/templates/${k.kind}?format=xlsx`} download>
                Excel template
              </a>
              <span className="text-xs text-muted">{k.purpose}</span>
            </li>
          ))}
        </ul>
        <details className="mt-3 text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-medium text-trust">Rules for the file</summary>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            {(status.rules ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      </section>

      <section aria-labelledby="pb-up-upload" className="rounded-card border border-line bg-white p-4">
        <h2 id="pb-up-upload" className="text-base font-semibold text-ink">
          2. Upload and check
        </h2>
        {!caps.upload ? (
          <p role="status" className="mt-2 text-sm text-muted">
            You can see staged uploads, but you do not hold the permission to upload a file. Ask a Super Admin if you need it.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <label className="block text-sm">
              <span className="font-medium text-ink">Kind of data</span>
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as UploadKind);
                  setStageResult(null);
                  setSheets(null);
                }}
                className="mt-1 block min-h-11 w-full max-w-sm rounded border border-line bg-white px-2"
              >
                {UPLOAD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-ink">File (.csv or .xlsx, at most {maxMb} MB and {status.limits?.maxRows.toLocaleString('en-IN')} rows)</span>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setStageResult(null);
                  setSheets(null);
                  setPreview(null);
                }}
                className="mt-1 block min-h-11 w-full max-w-lg text-sm"
              />
            </label>
            {sheets && (
              <div className="rounded border border-attention/40 bg-attention/5 p-3 text-sm">
                <p className="font-medium text-ink">This workbook has more than one sheet. Choose the sheet to process.</p>
                <label className="mt-2 block">
                  <span className="text-ink">Sheet</span>
                  <select value={sheetName} onChange={(e) => setSheetName(e.target.value)} className="mt-1 block min-h-11 w-full max-w-sm rounded border border-line bg-white px-2">
                    <option value="">Choose a sheet</option>
                    {sheets.map((s) => (
                      <option key={s.name} value={s.name} disabled={s.state !== 'visible'}>
                        {s.name}
                        {s.state !== 'visible' ? ' (hidden, cannot be used)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} />
                  <span>Include rows that are hidden in the spreadsheet (they are listed and skipped by default)</span>
                </label>
                <button type="button" disabled={busy || !sheetName} onClick={() => void submit(sheetName)} className="mt-3 min-h-11 rounded bg-trust px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  Check this sheet
                </button>
              </div>
            )}
            <button type="button" disabled={busy || !file} onClick={() => void submit(sheetName || undefined)} className="min-h-11 rounded bg-trust px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Working…' : 'Check and stage the file'}
            </button>
            <p className="text-xs text-muted">Staging checks the file and stores the checked rows. Nothing becomes live.</p>
          </div>
        )}

        {stageResult?.status === 'rejected' && (
          <div role="alert" className="mt-4 rounded border border-risk/40 bg-risk/5 p-3 text-sm" data-testid="pb-rejected">
            <p className="font-semibold text-risk">The file was not staged. {stageResult.errorCount} problem(s) must be fixed first. Nothing was changed.</p>
            {stageResult.problems.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
                {stageResult.problems.map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
              </ul>
            )}
            {stageResult.issues.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">Problems found in the file</caption>
                  <thead className="text-muted">
                    <tr>
                      <th scope="col" className="px-2 py-1">Row</th>
                      <th scope="col" className="px-2 py-1">Column</th>
                      <th scope="col" className="px-2 py-1">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageResult.issues.map((i, k) => (
                      <tr key={k} className="border-t border-line align-top">
                        <td className="px-2 py-1">{i.rowNumber ?? 'file'}</td>
                        <td className="px-2 py-1">{i.column ?? ''}</td>
                        <td className="px-2 py-1">
                          {i.severity === 'warning' ? 'Warning: ' : ''}
                          {i.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {stageResult.issuesTruncated && <p className="mt-1 text-xs text-muted">Only the first {stageResult.issues.length} are shown. Fix these and check again to see the rest.</p>}
              </div>
            )}
          </div>
        )}
      </section>

      {preview && (
        <section aria-labelledby="pb-up-preview" className="rounded-card border border-line bg-white p-4" data-testid="pb-preview">
          <h2 id="pb-up-preview" className="text-base font-semibold text-ink">
            3. Preview against the live figures
          </h2>
          <p className="mt-1 text-sm text-ink">
            {KIND_LABEL[preview.batch.kind]} for <strong>{preview.batch.dataset_name}</strong> version {preview.batch.dataset_version}, from {preview.batch.file_name}. {STATUS_LABEL[preview.batch.status]}.
            Staged {formatDayFirstDateTime(preview.batch.staged_at)}
            {preview.batch.status === 'staged' ? `, expires ${formatDayFirstDateTime(preview.batch.expires_at)}` : ''}.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            {(['new', 'changed', 'unchanged', 'conflict', 'removed'] as const).map((k) => (
              <div key={k} className="rounded border border-line p-2">
                <dt className="text-xs text-muted">{k === 'new' ? 'New' : k === 'changed' ? 'Replaced' : k === 'unchanged' ? 'Same as live' : k === 'conflict' ? 'Conflicts' : 'Bands removed'}</dt>
                <dd className="text-lg font-semibold text-ink">{c[k] ?? 0}</dd>
              </div>
            ))}
          </dl>

          {preview.batch.status === 'staged' && preview.blockers.length > 0 && (
            <div role="alert" className="mt-3 rounded border border-attention/40 bg-attention/5 p-3 text-sm">
              <p className="font-semibold text-ink">This upload cannot be activated yet:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.batch.status === 'staged' && preview.blockers.length === 0 && (
            <p role="status" className="mt-3 rounded border border-positive/30 bg-positive/5 p-3 text-sm text-ink">
              Every check passed. Nothing is live yet.
            </p>
          )}
          {preview.batch.status === 'activated' && (
            <p role="status" className="mt-3 rounded border border-positive/30 bg-positive/5 p-3 text-sm text-ink">
              This upload is live. {String(preview.batch.result?.rows_inserted ?? 0)} figure(s) added and {String(preview.batch.result?.rows_end_dated ?? 0)} replaced and kept as history.
            </p>
          )}

          {preview.removed.length > 0 && (
            <div className="mt-3 text-sm">
              <p className="font-medium text-ink">Bands that will be taken out of service because the file does not restate them:</p>
              <ul className="list-disc pl-5 text-muted">
                {preview.removed.map((r, i) => (
                  <li key={i}>
                    {r.metric_code}, tier {r.band_tier} ({r.band_label}): {num(r.lower)} to {num(r.upper)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted">Show</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="min-h-11 rounded border border-line bg-white px-2">
                <option value="all">All rows</option>
                {(['new', 'changed', 'unchanged', 'conflict'] as const).map((k) => (
                  <option key={k} value={k}>
                    {CLASS_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-muted">
              {shownRows.length} row(s) shown{preview.rows_truncated ? ' (the first 1,000 only)' : ''}.
            </span>
          </div>
          <div className="relative mt-2 overflow-x-auto rounded border border-line">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Staged rows compared with the live figures</caption>
              <thead className="bg-gray-50 text-muted">
                <tr>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">Row</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">What</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">Result</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">Live now</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2">In this file</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-muted">No rows match this filter.</td>
                  </tr>
                )}
                {shownRows.map((r) => (
                  <tr key={r.row_no} className="border-t border-line align-top">
                    <td className="px-3 py-2">{r.row_no}</td>
                    <td className="px-3 py-2">
                      {preview.batch.kind === 'values' && `${r.metric_code} / ${r.statistic_type}${r.cohort_code ? ` / ${r.cohort_code}` : ' / country-wide'}`}
                      {preview.batch.kind === 'target_ranges' && `${r.metric_code} / tier ${r.band_tier} ${r.band_label}`}
                      {preview.batch.kind === 'cohorts' && `${r.cohort_code} (tier ${r.cohort_tier})`}
                    </td>
                    <td className="px-3 py-2">
                      {CLASS_LABEL[r.classification]}
                      {r.detail ? <span className="block text-muted">{r.detail}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {preview.batch.kind === 'values' && (r.live_value === null ? 'nothing' : num(r.live_value))}
                      {preview.batch.kind === 'target_ranges' && (r.live_lower === null && r.live_upper === null && r.classification === 'new' ? 'nothing' : `${num(r.live_lower)} to ${num(r.live_upper)}`)}
                      {preview.batch.kind === 'cohorts' && (r.classification === 'new' ? 'nothing' : 'exists')}
                    </td>
                    <td className="px-3 py-2">
                      {preview.batch.kind === 'values' && num(r.new_value)}
                      {preview.batch.kind === 'target_ranges' && `${num(r.new_lower)} to ${num(r.new_upper)}`}
                      {preview.batch.kind === 'cohorts' && (r.cohort_description ?? '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.batch.status === 'staged' && (
            <div className="mt-4 space-y-3">
              {caps.activate && preview.batch.staged_by_me && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={selfAck} onChange={(e) => setSelfAck(e.target.checked)} className="mt-1" />
                  <span>I staged this upload myself and I am also activating it. This is recorded on the upload.</span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                {caps.activate ? (
                  <button type="button" disabled={busy || !canActivate} onClick={() => setConfirmOpen(true)} className="min-h-11 rounded bg-trust px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
                    Activate
                  </button>
                ) : (
                  <p className="text-sm text-muted">You do not hold the permission to activate. Ask a person who does to review this staged upload.</p>
                )}
                {canDiscard && (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-sm">
                      <span className="sr-only">Reason for discarding (optional)</span>
                      <input value={discardReason} onChange={(e) => setDiscardReason(e.target.value)} maxLength={500} placeholder="Reason (optional)" className="min-h-11 rounded border border-line px-2 text-sm" />
                    </label>
                    <button type="button" disabled={busy} onClick={() => void discard()} className="min-h-11 rounded border border-line bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300 disabled:opacity-50">
                      Discard this upload
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="pb-up-history" className="rounded-card border border-line bg-white p-4">
        <h2 id="pb-up-history" className="text-base font-semibold text-ink">
          Upload history
        </h2>
        {(status.batches ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted">No upload has been staged yet.</p>
        ) : (
          <div className="relative mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Planning benchmark uploads, newest first</caption>
              <thead className="bg-gray-50 text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">When</th>
                  <th scope="col" className="px-3 py-2">Kind</th>
                  <th scope="col" className="px-3 py-2">Dataset</th>
                  <th scope="col" className="px-3 py-2">File</th>
                  <th scope="col" className="px-3 py-2">Rows</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2">By</th>
                  <th scope="col" className="px-3 py-2">Open</th>
                </tr>
              </thead>
              <tbody>
                {(status.batches ?? []).map((b) => (
                  <tr key={b.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatDayFirstDateTime(b.staged_at)}</td>
                    <td className="px-3 py-2">{KIND_LABEL[b.kind]}</td>
                    <td className="px-3 py-2">
                      {b.dataset_name} {b.dataset_version}
                    </td>
                    <td className="max-w-xs truncate px-3 py-2" title={b.file_name}>
                      {b.file_name}
                    </td>
                    <td className="px-3 py-2">{b.row_count}</td>
                    <td className="px-3 py-2">
                      {STATUS_LABEL[b.status]}
                      {b.status === 'staged' && new Date(b.expires_at).getTime() <= renderedAtMs ? ' - expired' : ''}
                      {b.status === 'activated' ? ` ${formatDayFirstDateTime(b.activated_at)}${b.self_activated ? ', self-activated' : ''}` : ''}
                    </td>
                    <td className="px-3 py-2">{b.stagedByMe ? 'you' : 'another admin'}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => void loadPreview(b.id)} aria-label={`Open the preview of ${b.file_name}`} className="min-h-11 min-w-11 rounded border border-line px-2 hover:bg-gray-50">
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
