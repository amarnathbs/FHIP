'use client';

// Resources Bulk Upload -- preview + apply + result, shared by both types. The preview is built from the
// SERVER-staged rows; "Create drafts" sends only the run id. Nothing is created until the person confirms.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { formatDateShort } from '@/lib/engines/date';
import { CONTENT_TYPE_LABELS, type ImportContentType, type ImportIssue, type NormalisedImportPayload } from '@/lib/resources/import/types';
import { JURISDICTION_LABELS, COMPLIANCE_LABELS, formatAdminDateTime } from '@/lib/resources/admin/labels';
import type { ResourceJurisdiction, ComplianceClassification } from '@/lib/resources/types';

export interface PreviewRun {
  id: string;
  content_type: ImportContentType;
  file_name: string;
  template_version: string | null;
  status: string;
  row_count: number;
  valid_count: number;
  warning_count: number;
  error_count: number;
  created_post_count: number;
  failure_code: string | null;
  failure_message_safe: string | null;
  file_issues: ImportIssue[];
  created_at: string;
  applied_at: string | null;
  expires_at: string;
}

export interface PreviewRow {
  row_number: number;
  title: string | null;
  slug: string | null;
  display: {
    title?: string;
    jurisdiction?: string | null;
    compliance_classification?: string | null;
    primary_category?: string | null;
  };
  validation_errors: ImportIssue[];
  validation_warnings: ImportIssue[];
  result_post_id: string | null;
  result_status: string;
}

const PAGE = 25;

function dayFirst(iso: string | null | undefined, jurisdiction?: string | null): string {
  if (!iso) return 'Not set';
  return formatDateShort(iso.slice(0, 10), jurisdiction === 'india' ? 'INR' : 'AUD');
}

const DUPLICATE_CODES = new Set(['DUPLICATE_SLUG_IN_FILE', 'DUPLICATE_EXTERNAL_ID_IN_FILE', 'EXISTING_CONTENT_CONFLICT']);

function RowStatus({ row }: { row: PreviewRow }) {
  if (row.result_status === 'created') return <span className="rounded border border-positive/40 bg-positive/10 px-2 py-0.5 text-xs font-semibold text-positive">Created (draft)</span>;
  if (row.validation_errors.length > 0) return <span className="rounded border border-risk/40 bg-risk/10 px-2 py-0.5 text-xs font-semibold text-risk">Error</span>;
  if (row.validation_warnings.length > 0) return <span className="rounded border border-attention/40 bg-attention/10 px-2 py-0.5 text-xs font-semibold text-attention">Ready, with notes</span>;
  return <span className="rounded border border-positive/40 bg-positive/10 px-2 py-0.5 text-xs font-semibold text-positive">Ready</span>;
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-line text-sm text-ink">{children}</dd>
    </div>
  );
}

type Blk = { id: string; type: string; data: Record<string, unknown> };

function bodyPreview(blocks: Blk[]): string {
  return blocks
    .map((b) => {
      const d = b.data ?? {};
      if (b.type === 'heading') return `${'#'.repeat(Number(d.level) || 2)} ${String(d.text ?? '')}`;
      if (b.type === 'bulleted_list') return ((d.items as string[]) ?? []).map((i) => `- ${i}`).join('\n');
      if (b.type === 'numbered_list') return ((d.items as string[]) ?? []).map((i, n) => `${n + 1}. ${i}`).join('\n');
      if (b.type === 'key_takeaways') return `Key takeaways:\n${((d.items as string[]) ?? []).map((i) => `- ${i}`).join('\n')}`;
      if (b.type === 'callout') return `Quick answer: ${String(d.text ?? '')}`;
      if (b.type === 'example') return `Example: ${String(d.text ?? '')}`;
      return String(d.text ?? '');
    })
    .join('\n\n');
}

function RowDetail({ runId, rowNumber, type, applied, errors, warnings }: { runId: string; rowNumber: number; type: ImportContentType; applied: boolean; errors: ImportIssue[]; warnings: ImportIssue[] }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; payload: NormalisedImportPayload | null; display: Record<string, unknown> | null }>({ loading: true, error: null, payload: null, display: null });
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/resources/import/runs/${runId}/rows/${rowNumber}`)
      .then(async (r) => ({ ok: r.ok, json: await r.json().catch(() => ({})) }))
      .then(({ ok, json }) => {
        if (!live) return;
        if (!ok) setState({ loading: false, error: json?.error ?? 'Could not load this row.', payload: null, display: null });
        else setState({ loading: false, error: null, payload: (json.data.row.normalized_payload ?? null) as NormalisedImportPayload | null, display: json.data.row.display ?? null });
      })
      .catch(() => live && setState({ loading: false, error: 'Could not load this row.', payload: null, display: null }));
    return () => {
      live = false;
    };
  }, [runId, rowNumber]);

  const issueList = (
    <>
      {errors.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-risk">Errors (these block the import)</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
            {errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-xs">{e.code}</span>
                {e.field ? <span className="text-muted"> ({e.field})</span> : null}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-attention">Notes</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
            {warnings.map((e, i) => (
              <li key={i}>
                <span className="font-mono text-xs">{e.code}</span>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );

  if (state.loading) return <p role="status" className="p-3 text-sm text-muted">Loading row details...</p>;
  if (state.error) return <p role="alert" className="p-3 text-sm text-risk">{state.error}</p>;
  const p = state.payload;
  if (!p || Object.keys(p).length === 0) {
    return (
      <div className="space-y-3 p-3">
        {issueList}
        <p className="text-sm text-muted">{applied ? 'This import was applied and the staged content was cleared. Open the draft to see the content.' : 'No staged content for this row.'}</p>
      </div>
    );
  }
  const blocks = (p.content_blocks ?? []) as Blk[];
  const first = (t: string) => blocks.find((b) => b.type === t);
  const j = p.jurisdiction;
  const dsp = (state.display ?? {}) as { primary_category?: string | null; author?: string | null; tags?: string[]; primary_cta?: string | null; secondary_cta?: string | null };
  return (
    <div className="space-y-3 p-3">
      {issueList}
      <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Block label="Title">{p.title}</Block>
        <Block label="Slug">{p.slug}{p.slug_generated ? ' (generated from the title)' : ''}</Block>
        <Block label="Excerpt">{p.excerpt}</Block>
        {type === 'article' ? (
          <>
            <Block label="Quick answer">{String(first('callout')?.data.text ?? 'None')}</Block>
            <Block label="Key takeaways">{(((first('key_takeaways')?.data.items as string[]) ?? []).map((i) => `- ${i}`).join('\n')) || 'None'}</Block>
            <Block label="Example">{String(first('example')?.data.text ?? 'None')}</Block>
            <Block label="Author">{dsp.author ?? 'Not set (needed before review)'}</Block>
            <Block label="Freshness">{p.freshness_type === 'time_sensitive' ? 'Time-sensitive' : 'Evergreen'}</Block>
          </>
        ) : (
          <>
            <Block label="Event date">{dayFirst(p.event_date, j)}</Block>
            <Block label="Affected audience">{p.affected_audience ?? 'Not set'}</Block>
          </>
        )}
        <Block label="Review date">{dayFirst(p.next_review_at, j)}</Block>
        <Block label="Expiry date">{dayFirst(p.expires_at, j)}</Block>
        <Block label="Primary category">{dsp.primary_category ?? 'Not set (needed before review)'}</Block>
        <Block label="Tags">{(dsp.tags ?? []).join(', ') || 'None'}</Block>
        <Block label="Call to action">{[dsp.primary_cta, dsp.secondary_cta].filter(Boolean).join(' and ') || 'None'}</Block>
        <Block label="SEO">{[p.seo_title, p.seo_description].filter(Boolean).join(' | ') || 'Not set (the normal fallback applies)'}</Block>
      </dl>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{type === 'article' ? 'Article body, as it will be stored' : 'The five sections, as they will be stored'}</p>
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-compact border border-line bg-gray-50 p-3 text-xs text-ink">{bodyPreview(blocks)}</pre>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Sources ({p.sources.length})</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
          {p.sources.map((s, i) => (
            <li key={i}>
              {s.source_name}
              {s.document_title ? `, ${s.document_title}` : ''}
              {s.url ? <span className="break-all text-muted"> ({s.url})</span> : <span className="text-muted"> (no link)</span>}
              {s.publication_date ? <span className="text-muted">, published {dayFirst(s.publication_date, j)}</span> : null}
            </li>
          ))}
          {p.sources.length === 0 && <li className="list-none text-muted">None</li>}
        </ul>
      </div>
    </div>
  );
}

export function ImportPreview({ run: initialRun, rows: initialRows, editBase, listHref }: { run: PreviewRun; rows: PreviewRow[]; editBase: 'content' | 'money-updates'; listHref: string }) {
  const [run, setRun] = useState(initialRun);
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<{ created: number; postIds: string[]; already: boolean } | null>(null);
  const applyBtn = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const label = CONTENT_TYPE_LABELS[run.content_type];

  useEffect(() => {
    if (applyError && errorRef.current) errorRef.current.focus();
  }, [applyError]);

  const filtered = useMemo(() => {
    if (filter === 'errors') return rows.filter((r) => r.validation_errors.length > 0);
    if (filter === 'warnings') return rows.filter((r) => r.validation_warnings.length > 0 && r.validation_errors.length === 0);
    return rows;
  }, [rows, filter]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages);
  const visible = filtered.slice((cur - 1) * PAGE, cur * PAGE);
  const duplicates = rows.filter((r) => r.validation_errors.some((e) => DUPLICATE_CODES.has(e.code))).length;
  const ready = run.status === 'ready' && run.error_count === 0 && run.row_count > 0;
  const noun = run.row_count === 1 ? label.singular : label.plural;

  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/admin/resources/import/runs/${run.id}`);
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setRun(json.data.run);
      setRows(json.data.rows);
    }
  }, [run.id]);

  async function apply() {
    setConfirm(false);
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch(`/api/admin/resources/import/runs/${run.id}/apply`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setApplyError({ code: json?.code ?? 'APPLY_FAILED', message: json?.error ?? 'The import could not be completed. Nothing was created.' });
        await refresh();
        return;
      }
      setResult({ created: json.data.created, postIds: json.data.postIds ?? [], already: json.data.alreadyApplied === true });
      await refresh();
    } catch {
      setApplyError({ code: 'APPLY_FAILED', message: 'Could not reach the server. Nothing was created. Check your connection and try again.' });
    } finally {
      setApplying(false);
    }
  }

  const createdRows = rows.filter((r) => r.result_post_id);
  const firstPost = result?.postIds?.[0] ?? createdRows[0]?.result_post_id ?? null;
  const applied = run.status === 'applied';

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirm}
        title={`Create ${run.row_count} ${noun} as private Drafts?`}
        message="Nothing will be published or scheduled. Normal Resources review and approval is still required."
        confirmLabel={`Create ${run.row_count} ${noun}`}
        cancelLabel="Not yet"
        destructive={false}
        initialFocus="cancel"
        onConfirm={apply}
        onCancel={() => setConfirm(false)}
      />

      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">Resources</Link> &gt;{' '}
        <Link href="/admin/resources/import" className="hover:text-trust hover:underline">Bulk Upload</Link> &gt; <span className="text-ink">{applied ? 'Import result' : 'Preview'}</span>
      </nav>

      <header>
        <h1 className="text-2xl font-semibold text-ink">{applied ? `${label.plural} imported` : `Preview: ${label.plural}`}</h1>
        <p className="mt-1 text-sm text-muted">
          {applied ? 'The items below were created as private drafts. Nothing was published, scheduled or approved.' : 'Nothing has been created yet. Check the rows, then create the drafts.'}
        </p>
      </header>

      {applied && (
        <section aria-live="polite" className="rounded-card border border-positive/40 bg-positive/5 p-4" aria-labelledby="res-h">
          <h2 id="res-h" className="text-lg font-semibold text-ink">
            {run.created_post_count} {run.created_post_count === 1 ? label.singular : label.plural} created, 0 failed
          </h2>
          {result?.already && <p className="mt-1 text-sm text-muted">This import had already been applied; nothing new was created.</p>}
          <p className="mt-1 text-sm text-ink">Every item is a private draft. Open it in the normal editor to review, add an author or category if needed, and send it through the usual workflow.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link href={listHref} className="inline-flex min-h-11 items-center rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">View imported drafts</Link>
            {firstPost && (
              <Link href={`/admin/resources/${editBase}/${firstPost}/edit`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-gray-50">Open first draft</Link>
            )}
            <Link href="/admin/resources/import/history" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-gray-50">View import history</Link>
          </div>
        </section>
      )}

      {applyError && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-card border border-risk/40 bg-risk/5 p-4 text-sm text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-risk">
          <p className="font-semibold text-risk">{applyError.message}</p>
          <p className="mt-1 text-xs text-muted">Code: {applyError.code}. No {label.singular.toLowerCase()} was created.</p>
          {(applyError.code === 'STALE_PREVIEW' || applyError.code === 'IMPORT_NOT_READY' || applyError.code === 'FILE_ALREADY_APPLIED') && (
            <p className="mt-2">
              <Link className="font-semibold text-trust underline" href={`/admin/resources/import/upload?type=${run.content_type}`}>Upload the file again</Link>
            </p>
          )}
        </div>
      )}

      <section aria-labelledby="sum-h" className="rounded-card border border-line bg-white p-4">
        <h2 id="sum-h" className="sr-only">Import summary</h2>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
          <div><dt className="text-xs text-muted">Type</dt><dd className="text-sm font-semibold text-ink">{label.singular}</dd></div>
          <div className="col-span-2"><dt className="text-xs text-muted">File</dt><dd className="break-all text-sm font-semibold text-ink">{run.file_name}</dd></div>
          <div><dt className="text-xs text-muted">Template version</dt><dd className="text-sm font-semibold text-ink">{run.template_version ?? 'Unknown'}</dd></div>
          <div><dt className="text-xs text-muted">Rows</dt><dd className="text-sm font-semibold text-ink">{run.row_count}</dd></div>
          <div><dt className="text-xs text-muted">Ready</dt><dd className="text-sm font-semibold text-positive">{run.valid_count}</dd></div>
          <div><dt className="text-xs text-muted">With notes</dt><dd className="text-sm font-semibold text-attention">{run.warning_count}</dd></div>
          <div><dt className="text-xs text-muted">With errors</dt><dd className="text-sm font-semibold text-risk">{run.error_count}</dd></div>
          <div><dt className="text-xs text-muted">Duplicates</dt><dd className="text-sm font-semibold text-ink">{duplicates}</dd></div>
          <div className="col-span-2 md:col-span-3"><dt className="text-xs text-muted">Uploaded</dt><dd className="text-sm font-semibold text-ink">{formatAdminDateTime(run.created_at)}</dd></div>
        </dl>
      </section>

      {run.file_issues.length > 0 && (
        <div role="alert" className="rounded-card border border-risk/40 bg-risk/5 p-4">
          <p className="text-sm font-semibold text-risk">This file could not be used.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
            {run.file_issues.map((i, n) => (
              <li key={n}><span className="font-mono text-xs">{i.code}</span> {i.message}</li>
            ))}
          </ul>
        </div>
      )}

      {!applied && run.error_count > 0 && (
        <div role="alert" className="rounded-card border border-risk/40 bg-risk/5 p-4 text-sm text-ink">
          <p className="font-semibold text-risk">
            {run.error_count} of {run.row_count} {run.row_count === 1 ? 'row has' : 'rows have'} errors. Creating drafts is blocked and nothing was created.
          </p>
          <p className="mt-1">Fix the rows in your file and upload it again. All rows must pass before any draft is created.</p>
        </div>
      )}

      {!applied && run.status === 'stale' && (
        <div role="alert" className="rounded-card border border-risk/40 bg-risk/5 p-4 text-sm text-ink">
          <p className="font-semibold text-risk">This preview is out of date.</p>
          <p className="mt-1">{run.failure_message_safe ?? 'Something changed after the preview was prepared.'} Nothing was created.</p>
          <p className="mt-2"><Link className="font-semibold text-trust underline" href={`/admin/resources/import/upload?type=${run.content_type}`}>Upload the file again</Link></p>
        </div>
      )}

      {run.status === 'expired' && (
        <div role="alert" className="rounded-card border border-line bg-gray-50 p-4 text-sm text-ink">This preview has expired and its staged rows were removed. Upload the file again.</div>
      )}

      {rows.length > 0 && (
        <section aria-labelledby="rows-h" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="rows-h" className="text-lg font-semibold text-ink">Rows</h2>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm text-muted" htmlFor="row-filter">Show</label>
              <select id="row-filter" value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(1); }} className="min-h-11 rounded border border-line bg-white px-2 py-1.5 text-sm text-ink">
                <option value="all">All rows ({rows.length})</option>
                <option value="errors">Rows with errors ({rows.filter((r) => r.validation_errors.length > 0).length})</option>
                <option value="warnings">Rows with notes only ({rows.filter((r) => r.validation_warnings.length > 0 && r.validation_errors.length === 0).length})</option>
              </select>
              <a className="inline-flex min-h-11 items-center rounded-full border border-line px-4 py-2 text-sm font-semibold text-trust hover:bg-gray-50" href={`/api/admin/resources/import/runs/${run.id}/results`}>
                Download validation results (.csv)
              </a>
            </div>
          </div>
          <p role="status" aria-live="polite" className="text-xs text-muted">Showing {visible.length} of {filtered.length} rows.</p>

          <div className="overflow-x-auto rounded-card border border-line bg-white">
            <table className="w-full min-w-[820px] text-left text-sm">
              <caption className="sr-only">Rows of the import with their validation status</caption>
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">Row</th>
                  <th scope="col" className="px-3 py-2">Title</th>
                  <th scope="col" className="px-3 py-2">Type</th>
                  <th scope="col" className="px-3 py-2">Jurisdiction</th>
                  <th scope="col" className="px-3 py-2">Compliance</th>
                  <th scope="col" className="px-3 py-2">Category</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2">Issues</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const isOpen = open.has(r.row_number);
                  const detailId = `row-detail-${r.row_number}`;
                  const j = r.display.jurisdiction as ResourceJurisdiction | undefined;
                  const c = r.display.compliance_classification as ComplianceClassification | undefined;
                  return (
                    <Fragment key={r.row_number}>
                      <tr className="border-t border-line align-top">
                        <td className="px-3 py-2 tabular-nums">{r.row_number}</td>
                        <td className="px-3 py-2">
                          <button type="button" aria-expanded={isOpen} aria-controls={detailId} onClick={() => toggle(r.row_number)} className="min-h-11 text-left font-semibold text-trust hover:underline">
                            <span aria-hidden="true">{isOpen ? '▾ ' : '▸ '}</span>
                            {r.title || '(no title)'}
                            <span className="sr-only">{isOpen ? ', hide details' : ', show details'}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2">{label.singular}</td>
                        <td className="px-3 py-2">{j ? JURISDICTION_LABELS[j] ?? j : 'Not set'}</td>
                        <td className="px-3 py-2">{c ? COMPLIANCE_LABELS[c] ?? c : 'Not set'}</td>
                        <td className="px-3 py-2">{r.display.primary_category ?? 'Not set'}</td>
                        <td className="px-3 py-2"><RowStatus row={r} /></td>
                        <td className="px-3 py-2 text-xs text-ink">
                          {r.validation_errors.length > 0 ? `${r.validation_errors.length} error${r.validation_errors.length === 1 ? '' : 's'}` : ''}
                          {r.validation_errors.length > 0 && r.validation_warnings.length > 0 ? ', ' : ''}
                          {r.validation_warnings.length > 0 ? `${r.validation_warnings.length} note${r.validation_warnings.length === 1 ? '' : 's'}` : ''}
                          {r.validation_errors.length === 0 && r.validation_warnings.length === 0 ? 'None' : ''}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr id={detailId} className="border-t border-line bg-gray-50/60">
                          <td colSpan={8}>
                            <RowDetail runId={run.id} rowNumber={r.row_number} type={run.content_type} applied={applied} errors={r.validation_errors} warnings={r.validation_warnings} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <button type="button" disabled={cur <= 1} onClick={() => setPage(cur - 1)} className="min-h-11 rounded-full border border-line px-4 py-2 font-semibold text-ink disabled:opacity-50">Previous</button>
              <span className="text-muted">Page {cur} of {pages}</span>
              <button type="button" disabled={cur >= pages} onClick={() => setPage(cur + 1)} className="min-h-11 rounded-full border border-line px-4 py-2 font-semibold text-ink disabled:opacity-50">Next</button>
            </div>
          )}
        </section>
      )}

      {!applied && (
        <div className="sticky bottom-0 -mx-4 border-t border-line bg-app/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <button ref={applyBtn} type="button" disabled={!ready || applying} onClick={() => setConfirm(true)} className="min-h-11 rounded-full bg-trust px-5 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50" aria-describedby="apply-hint">
              {applying ? 'Creating drafts...' : `Create ${run.row_count} ${noun} as private drafts`}
            </button>
            <Link href={`/admin/resources/import/upload?type=${run.content_type}`} className="min-h-11 inline-flex items-center rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-gray-50">
              Upload a different file
            </Link>
            <p id="apply-hint" className="text-xs text-muted">
              {ready ? 'Nothing is created until you confirm.' : run.error_count > 0 ? 'Disabled: every row must pass before any draft is created.' : 'Disabled: this import cannot be applied.'}
            </p>
          </div>
          <p role="status" aria-live="polite" className="sr-only">{applying ? 'Creating drafts' : ''}</p>
        </div>
      )}
    </div>
  );
}
