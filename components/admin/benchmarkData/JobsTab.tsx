'use client';

// Jobs: recent import jobs (own flags only - another administrator's identity
// is never returned or shown), a detail section with counts and issues, and the
// publish / cancel / rollback actions the caller's capabilities allow.
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { BenchmarkCapabilityFlags, ImportJobDetail, ImportJobSummary } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { apiCall, failureOf, useLoad, useUnmountSignal } from './api';
import {
  MIN_CORRECTION_REASON,
  ROLLBACK_EXPLAINER,
  apiPaths,
  asArray,
  asJobPreview,
  formatCount,
  formatDateTime,
  jobActions,
  jobStatusChip,
  mutationFromJob,
  noteProblem,
  shortDigest,
} from './benchmarkDataUiLogic';
import { PreviewPanel, PublishSection } from './PublishParts';
import { Btn, Chip, EmptyState, ErrorPanel, LoadingPanel, Notice, Panel, ScrollTable, Td, TextAreaField, Th } from './ui';

export function JobDetail({ id, caps, onChanged, say }: { id: string; caps: BenchmarkCapabilityFlags; onChanged: () => void; say: (kind: 'success' | 'failure', msg: string) => void }) {
  const { state, reload } = useLoad<ImportJobDetail>(apiPaths.job(id), 'load this import job');
  const signal = useUnmountSignal();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') return <LoadingPanel what="the job" />;
  if (state.status === 'error') return <ErrorPanel failure={state.failure} what="this job" onRetry={reload} />;
  const d = state.data;
  const job = d.job;
  const a = jobActions(job, caps);
  const preview = asJobPreview(d.preview);
  const chip = jobStatusChip(job.status);

  async function act(path: string, json: unknown, doneMsg: string, failMsg: string) {
    setBusy(true);
    const r = await apiCall(path, { method: 'POST', json, signal: signal() });
    if (r.aborted) return;
    setBusy(false);
    if (r.ok) {
      say('success', doneMsg);
      onChanged();
      reload();
    } else say('failure', failureOf(r, failMsg).message);
  }

  const reasonProblem = noteProblem(reason, MIN_CORRECTION_REASON, 'The rollback reason');

  return (
    <Panel title={`Job ${job.id.slice(0, 8)}: ${job.fileName}`} actions={<Chip label={chip.label} tone={chip.tone} title={chip.hint} />} description={chip.hint}>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-muted">Mode: </dt><dd className="inline text-ink">{job.mode === 'correction' ? 'Correction' : 'New history'}</dd></div>
        <div><dt className="inline text-muted">Benchmarks: </dt><dd className="inline text-ink">{job.benchmarkKeys.join(', ')}</dd></div>
        <div><dt className="inline text-muted">Staged: </dt><dd className="inline text-ink">{formatDateTime(job.stagedAt)}{job.stagedByMe ? ' (by you)' : ''}</dd></div>
        <div><dt className="inline text-muted">Published: </dt><dd className="inline text-ink">{job.publishedAt ? `${formatDateTime(job.publishedAt)}${job.publishedByMe ? ' (by you)' : ''}${job.selfPublished ? ', self-published' : ''}` : 'not published'}</dd></div>
        <div><dt className="inline text-muted">Rows: </dt><dd className="inline text-ink">{formatCount(job.rowsTotal)} total; {formatCount(job.rowsNew)} new, {formatCount(job.rowsRevive)} revived, {formatCount(job.rowsIdentical)} identical, {formatCount(job.rowsCorrection)} corrections</dd></div>
        <div><dt className="inline text-muted">Errors and warnings: </dt><dd className="inline text-ink">{formatCount(job.hardErrorTotal)} errors, {formatCount(job.warningCount)} warnings</dd></div>
        <div><dt className="inline text-muted">File checksum: </dt><dd className="inline font-mono text-xs text-ink">{shortDigest(job.fileSha256)}</dd></div>
        <div><dt className="inline text-muted">Entitlement check: </dt><dd className="inline text-ink">{job.eligible === null ? 'not recorded' : job.eligible ? 'permitted' : 'not permitted'}</dd></div>
        {job.reason ? <div className="sm:col-span-2"><dt className="inline text-muted">Reason: </dt><dd className="inline text-ink">{job.reason}</dd></div> : null}
        {job.errorCode ? <div className="sm:col-span-2"><dt className="inline text-muted">Failure code: </dt><dd className="inline text-ink">{job.errorCode}</dd></div> : null}
      </dl>

      {a.canDownloadErrors ? <p className="mt-3 text-sm"><a className="font-semibold text-trust underline" href={apiPaths.jobErrors(job.id)}>Download all validation errors (CSV)</a></p> : null}

      {d.errors.length > 0 ? (
        <div className="mt-3">
          <ScrollTable label="Validation issues for this job" minWidth="min-w-[560px]">
            <thead><tr><Th num>Row</Th><Th>Kind</Th><Th>What is wrong</Th></tr></thead>
            <tbody>
              {d.errors.slice(0, 100).map((e, i) => (
                <tr key={i}><Td num>{e.rowNumber ?? 'file'}</Td><Td>{e.severity === 'error' ? 'Error' : 'Warning'}</Td><Td>{e.message}</Td></tr>
              ))}
            </tbody>
          </ScrollTable>
          {d.errorsStored > 100 ? <p className="mt-1 text-xs text-muted">The first 100 issues are shown; download the CSV for all of them.</p> : null}
        </div>
      ) : null}

      {preview ? <div className="mt-4"><PreviewPanel preview={preview} jobId={job.id} /></div> : <p className="mt-3 text-sm text-muted">No stored preview is available for this job.</p>}

      {job.status === 'stale' || job.status === 'expired' ? <div className="mt-3"><Notice tone="warn" title="Upload the file again">This job can no longer be published. Start a new upload with the same file.</Notice></div> : null}

      {job.status === 'validated' ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">Publish</h3>
          <div className="mt-2">
            <PublishSection jobId={job.id} mode={job.mode} caps={caps} fileSha256={job.fileSha256} stagingDigest={d.stagingDigest} mutation={mutationFromJob(job)} benchmarks={job.benchmarkKeys} hardErrorCount={job.hardErrorTotal} blockers={preview?.blockers ?? []} eligible={job.eligible} requiredAcks={job.requiredAcks} stagedByMe={job.stagedByMe} onPublished={() => { onChanged(); reload(); }} onRestart={() => say('failure', 'Start a new upload on the Upload tab with the same file.')} />
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {a.canCancel ? <Btn kind="secondary" busy={busy} onClick={() => setConfirmCancel(true)}>Cancel this import</Btn> : null}
      </div>

      {a.canRollback ? (
        <div className="mt-4 space-y-2 rounded-compact border border-line p-3">
          <h3 className="text-sm font-semibold text-ink">Roll back this publication</h3>
          <p className="text-sm text-muted">{ROLLBACK_EXPLAINER}</p>
          <TextAreaField label="Reason for the rollback" required value={reason} onChange={setReason} hint="At least 20 characters. It is recorded permanently." error={reason.length > 0 ? reasonProblem : null} />
          <Btn kind="danger" disabled={reasonProblem !== null} busy={busy} onClick={() => setConfirmRollback(true)}>Roll back this publication</Btn>
        </div>
      ) : job.status === 'published' ? (
        <p className="mt-3 text-sm text-muted">{caps.correct ? '' : 'Rolling back needs the correction permission, which you do not have.'}</p>
      ) : null}

      <ConfirmDialog open={confirmCancel} title="Cancel this import?" message="The staged copy of the file's rows is discarded. Nothing that was published is touched." confirmLabel="Cancel the import" cancelLabel="Keep it" onCancel={() => setConfirmCancel(false)} onConfirm={() => { setConfirmCancel(false); void act(apiPaths.jobCancel(job.id), {}, 'The import was cancelled.', 'cancel this import'); }} />
      <ConfirmDialog open={confirmRollback} title="Roll back this publication?" message={ROLLBACK_EXPLAINER} confirmLabel="Roll back" onCancel={() => setConfirmRollback(false)} onConfirm={() => { setConfirmRollback(false); void act(apiPaths.jobRollback(job.id), { reason: reason.trim() }, 'The publication was rolled back. History is kept.', 'roll back this import'); }} />
    </Panel>
  );
}

export default function JobsTab({ caps, refreshKey, onChanged, say }: { caps: BenchmarkCapabilityFlags; refreshKey: number; onChanged: () => void; say: (kind: 'success' | 'failure', msg: string) => void }) {
  const { state, reload } = useLoad<ImportJobSummary[]>(`${apiPaths.jobs()}?r=${refreshKey}`, 'load the import jobs');
  const [selected, setSelected] = useState<string | null>(null);
  if (state.status === 'loading') return <LoadingPanel what="the import jobs" />;
  if (state.status === 'error') return <ErrorPanel failure={state.failure} what="the import jobs" onRetry={reload} />;
  const jobs = asArray<ImportJobSummary>(state.data);
  return (
    <div className="space-y-4">
      <Panel title="Recent import jobs" description="Newest first. Only your own jobs are marked 'by you'; other administrators are never identified.">
        {jobs.length === 0 ? (
          <EmptyState title="No import has been staged yet">Start on the Upload tab. Staging checks a file; nothing is published until a publisher approves it.</EmptyState>
        ) : (
          <ScrollTable label="Recent import jobs" minWidth="min-w-[860px]">
            <thead>
              <tr><Th>Status</Th><Th>Mode</Th><Th>File</Th><Th>Benchmarks</Th><Th num>Rows</Th><Th num>New</Th><Th num>Corrections</Th><Th>Staged</Th><Th>Published</Th><Th>Details</Th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const c = jobStatusChip(j.status);
                return (
                  <tr key={j.id}>
                    <Td><Chip label={c.label} tone={c.tone} title={c.hint} /></Td>
                    <Td>{j.mode === 'correction' ? 'Correction' : 'New history'}</Td>
                    <Td className="max-w-[14rem] truncate">{j.fileName}</Td>
                    <Td>{j.benchmarkKeys.join(', ')}</Td>
                    <Td num>{formatCount(j.rowsTotal)}</Td>
                    <Td num>{formatCount(j.rowsNew + j.rowsRevive)}</Td>
                    <Td num>{formatCount(j.rowsCorrection)}</Td>
                    <Td>{formatDateTime(j.stagedAt)}{j.stagedByMe ? ' (by you)' : ''}</Td>
                    <Td>{j.publishedAt ? `${formatDateTime(j.publishedAt)}${j.publishedByMe ? ' (by you)' : ''}${j.selfPublished ? ', self-published' : ''}` : 'no'}</Td>
                    <Td><Btn kind="secondary" onClick={() => setSelected(j.id)}>{`Open job ${j.id.slice(0, 8)}`}</Btn></Td>
                  </tr>
                );
              })}
            </tbody>
          </ScrollTable>
        )}
      </Panel>
      {selected ? <JobDetail key={selected} id={selected} caps={caps} onChanged={() => { onChanged(); reload(); }} say={say} /> : null}
    </div>
  );
}
