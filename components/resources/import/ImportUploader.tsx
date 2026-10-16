'use client';

// Resources Bulk Upload -- the shared uploader. ONE component for both content types: the page passes the
// type the person chose, and nothing in the file can change it. Client-side checks here are UX only; the server
// re-checks the file type, size, content and every value (lib/resources/import/file-security.ts).

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CONTENT_TYPE_LABELS, IMPORT_LIMITS, type ImportContentType, type ImportIssue } from '@/lib/resources/import/types';

type Stage = 'idle' | 'uploading' | 'parsing' | 'validating' | 'preparing';

const STAGE_TEXT: Record<Exclude<Stage, 'idle'>, string> = {
  uploading: 'Uploading...',
  parsing: 'Parsing...',
  validating: 'Validating...',
  preparing: 'Preparing preview...',
};

function templateHref(type: ImportContentType, format: 'xlsx' | 'csv') {
  return `/api/admin/resources/import/templates?type=${type}&format=${format}`;
}

export function ImportUploader({ type }: { type: ImportContentType }) {
  const router = useRouter();
  const label = CONTENT_TYPE_LABELS[type];
  const inputId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [clientError, setClientError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ImportIssue[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [rejectedRunId, setRejectedRunId] = useState<string | null>(null);
  // Shared ingest convention: for a workbook the operator CHOOSES the sheet (preselected, never silent).
  const sheetId = useId();
  const [sheets, setSheets] = useState<{ name: string; state: string; rowCount: number | null }[] | null>(null);
  const [sheet, setSheet] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const busy = stage !== 'idle' || inspecting;

  // The request is a single round trip; the stage wording advances on a timer so the person sees that work is
  // happening. (It is progress text, not a measurement of the server.)
  useEffect(() => {
    if (stage === 'idle') return;
    const order: Stage[] = ['uploading', 'parsing', 'validating', 'preparing'];
    const i = order.indexOf(stage);
    if (i === order.length - 1) return;
    const t = setTimeout(() => setStage(order[i + 1]), 700);
    return () => clearTimeout(t);
  }, [stage]);

  useEffect(() => {
    if ((clientError || serverError) && summaryRef.current) summaryRef.current.focus();
  }, [clientError, serverError]);

  async function inspect(f: File) {
    setInspecting(true);
    try {
      const form = new FormData();
      form.set('contentType', type);
      form.set('file', f);
      const res = await fetch('/api/admin/resources/import/inspect', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFile(null);
        setClientError(json?.error ?? 'This file could not be read.');
        return;
      }
      setFile(f);
      if (json.data?.kind === 'xlsx') {
        setSheets(json.data.sheets ?? []);
        setSheet(json.data.preselect ?? '');
      }
    } catch {
      setFile(null);
      setClientError('Could not reach the server to check the file. Try again.');
    } finally {
      setInspecting(false);
    }
  }

  function pick(f: File | null) {
    setServerIssues(null);
    setServerError(null);
    setRejectedRunId(null);
    setClientError(null);
    setSheets(null);
    setSheet('');
    if (!f) {
      setFile(null);
      return;
    }
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx')) {
      setFile(null);
      setClientError('Only .csv and .xlsx files can be uploaded. Download a template below and save your rows into it.');
      return;
    }
    if (f.size > IMPORT_LIMITS.maxFileBytes) {
      setFile(null);
      setClientError('That file is larger than 10 MB.');
      return;
    }
    if (lower.endsWith('.xlsx')) {
      setFile(null);
      void inspect(f);
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setServerIssues(null);
    setServerError(null);
    setClientError(null);
    setStage('uploading');
    try {
      const form = new FormData();
      form.set('contentType', type);
      form.set('file', file);
      if (sheets) form.set('sheetName', sheet);
      const res = await fetch('/api/admin/resources/import/runs', { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (res.status === 422 && json?.data?.runId) {
        setServerIssues((json.data.fileIssues ?? []) as ImportIssue[]);
        setServerError(json.error ?? 'This file could not be used.');
        setRejectedRunId(json.data.runId as string);
        setStage('idle');
        return;
      }
      if (!res.ok) {
        setServerError(json?.error ?? 'The upload could not be processed. Nothing was created.');
        setStage('idle');
        return;
      }
      router.push(`/admin/resources/import/runs/${json.data.runId}`);
    } catch {
      setServerError('Could not reach the server. Check your connection and try again. Nothing was created.');
      setStage('idle');
    }
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/content/new" className="hover:text-trust hover:underline">
          Create Resource
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/import" className="hover:text-trust hover:underline">
          Bulk Upload
        </Link>{' '}
        &gt; <span className="text-ink">Upload {label.plural}</span>
      </nav>

      <header>
        <h1 className="text-2xl font-semibold text-ink">Upload {label.plural}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every uploaded item becomes a <strong>private draft</strong>. Nothing is published, scheduled or approved by uploading, and the normal Resources review and approval still applies. You will see a preview and confirm before anything is created.
        </p>
      </header>

      <section aria-labelledby="tpl-h" className="rounded-card border border-line bg-white p-4">
        <h2 id="tpl-h" className="text-sm font-semibold text-ink">
          1. Get the template
        </h2>
        <p className="mt-1 text-sm text-muted">Use the {label.singular} template so the columns match exactly. Fill in one finished {label.singular.toLowerCase()} per row.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <a href={templateHref(type, 'xlsx')} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 py-2 text-sm font-semibold text-trust hover:bg-gray-50">
            Download Excel template (.xlsx)
          </a>
          <a href={templateHref(type, 'csv')} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 py-2 text-sm font-semibold text-trust hover:bg-gray-50">
            Download CSV template (.csv)
          </a>
        </div>
      </section>

      <form onSubmit={submit} className="rounded-card border border-line bg-white p-4" aria-labelledby="up-h">
        <h2 id="up-h" className="text-sm font-semibold text-ink">
          2. Choose your file
        </h2>

        {(clientError || serverError) && (
          <div ref={summaryRef} tabIndex={-1} role="alert" className="mt-3 rounded-compact border border-risk/40 bg-risk/5 p-3 text-sm text-risk outline-offset-2 focus-visible:outline-2 focus-visible:outline-risk">
            <p className="font-semibold">{clientError ?? serverError}</p>
            {serverIssues && serverIssues.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
                {serverIssues.slice(0, 8).map((i, idx) => (
                  <li key={idx}>
                    <span className="font-mono text-xs">{i.code}</span> {i.message}
                  </li>
                ))}
              </ul>
            )}
            {rejectedRunId && (
              <p className="mt-2 text-ink">
                <a className="font-semibold text-trust underline" href={`/api/admin/resources/import/runs/${rejectedRunId}/results`}>
                  Download the validation results (.csv)
                </a>
              </p>
            )}
          </div>
        )}

        <div className="mt-3">
          <label htmlFor={inputId} className="block text-sm font-medium text-ink">
            {label.singular} upload file (.xlsx or .csv, up to 10 MB and {IMPORT_LIMITS.maxRows} rows)
          </label>
          <input
            id={inputId}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            disabled={busy}
            className="mt-1 block w-full max-w-xl rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-full file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-ink"
          />
          {file && (
            <p className="mt-1 text-xs text-muted">
              Selected: <span className="text-ink">{file.name}</span> ({Math.max(1, Math.round(file.size / 1024))} KB)
            </p>
          )}
          {inspecting && (
            <p role="status" className="mt-1 text-xs text-muted">
              Checking the workbook...
            </p>
          )}
          {sheets && (
            <div className="mt-3">
              <label htmlFor={sheetId} className="block text-sm font-medium text-ink">
                Sheet to import
              </label>
              <select id={sheetId} value={sheet} onChange={(e) => setSheet(e.target.value)} className="mt-1 block min-h-11 w-full max-w-xl rounded-compact border border-line bg-white px-3 py-2 text-sm text-ink">
                <option value="">Choose a sheet...</option>
                {sheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                    {s.state !== 'visible' ? ` (${s.state})` : ''}
                    {s.rowCount !== null ? `, ${s.rowCount} rows` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">Only the sheet you choose is imported. Every other sheet is ignored, and the preview tells you which. Rows hidden in the sheet are not imported, and the preview lists them.</p>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!file || busy || (sheets !== null && !sheet)} className="min-h-11 rounded-full bg-trust px-5 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
            {busy ? STAGE_TEXT[stage as Exclude<Stage, 'idle'>] : 'Upload and preview'}
          </button>
          <Link href="/admin/resources/import" className="min-h-11 rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-gray-50 inline-flex items-center">
            Back
          </Link>
        </div>
        <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
          {busy ? STAGE_TEXT[stage as Exclude<Stage, 'idle'>] : ''}
        </p>
      </form>
    </div>
  );
}
