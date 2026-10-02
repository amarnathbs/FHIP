'use client';

// Preview panel (read-only) and the publish section (acknowledgements, self-
// publication confirmation, confirm dialog, result states). Used by the Upload
// flow and by the Jobs detail. The browser never decides anything here: the
// decision rules are in benchmarkDataUiLogic.ts and the server re-checks every
// condition at publication time (checksum, digest, counts, entitlement).
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { BenchmarkCapabilityFlags, JobPreview, PublishResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { apiCall, failureOf, useUnmountSignal } from './api';
import {
  ackInfo,
  apiPaths,
  buildPublishBody,
  describePublishSuccess,
  formatDate,
  formatCount,
  formatLevel,
  publishConfirmText,
  publishDecision,
  shortDigest,
  type ApiFailure,
} from './benchmarkDataUiLogic';
import { Btn, CheckField, Chip, IssueList, Notice, Panel, ScrollTable, Td, Th } from './ui';

/** Read-only preview of a staged job (counts, scope, eligibility, issues, corrections, digest). */
export function PreviewPanel({ preview, jobId }: { preview: JobPreview; jobId: string | null }) {
  const errors = preview.issues.filter((i) => i.severity === 'error').slice(0, 100);
  const warnings = preview.issues.filter((i) => i.severity === 'warning');
  return (
    <div className="space-y-4">
      <Panel title="What was read">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Benchmarks: </dt><dd className="inline font-medium text-ink">{preview.selectedBenchmarks.join(', ') || 'none'}</dd></div>
          <div><dt className="inline text-muted">Source: </dt><dd className="inline font-medium text-ink">{preview.source.owner} ({preview.source.reference})</dd></div>
          <div><dt className="inline text-muted">File: </dt><dd className="inline font-medium text-ink">{preview.source.originalFileName}</dd></div>
          <div><dt className="inline text-muted">Return type and currency: </dt><dd className="inline font-medium text-ink">{preview.params.returnVariant}, {preview.params.currencyCode}</dd></div>
          <div><dt className="inline text-muted">Total rows: </dt><dd className="inline font-medium text-ink">{formatCount(preview.counts.rowsTotal)}</dd></div>
          <div><dt className="inline text-muted">Valid rows: </dt><dd className="inline font-medium text-ink">{formatCount(preview.counts.rowsValid)}</dd></div>
          <div><dt className="inline text-muted">Invalid rows: </dt><dd className="inline font-medium text-ink">{formatCount(preview.counts.rowsInvalid)}</dd></div>
          <div><dt className="inline text-muted">File checksum: </dt><dd className="inline font-mono text-xs text-ink">{shortDigest(preview.fileSha256)}</dd></div>
          <div><dt className="inline text-muted">Staging digest: </dt><dd className="inline font-mono text-xs text-ink">{shortDigest(preview.stagingDigest)}</dd></div>
        </dl>
        {preview.disclosure.sheetProcessed ? (
          <p className="mt-2 text-sm text-ink">
            Sheet processed: <strong>{preview.disclosure.sheetProcessed}</strong>.
            {preview.disclosure.otherSheetsNotProcessed && preview.disclosure.otherSheetsNotProcessed.length > 0 ? ` Not processed: ${preview.disclosure.otherSheetsNotProcessed.join(', ')}.` : ''}
            {preview.disclosure.hiddenRowsSkipped && preview.disclosure.hiddenRowsSkipped.length > 0 ? ` Hidden rows skipped: ${preview.disclosure.hiddenRowsSkipped.slice(0, 20).join(', ')}.` : ''}
            {preview.disclosure.hiddenRowsIncluded && preview.disclosure.hiddenRowsIncluded.length > 0 ? ` Hidden rows included: ${preview.disclosure.hiddenRowsIncluded.slice(0, 20).join(', ')}.` : ''}
          </p>
        ) : null}
      </Panel>

      <Panel title="What publishing would do" description="Exactly this, for the benchmarks below. Nothing else is written, and publication is all or nothing.">
        <p className="text-sm text-ink">
          New: <strong>{formatCount(preview.mutation.new)}</strong>. Revived: <strong>{formatCount(preview.mutation.revive)}</strong>. Identical, skipped: <strong>{formatCount(preview.mutation.identical)}</strong>. Corrections: <strong>{formatCount(preview.mutation.correction)}</strong>.
        </p>
        <div className="mt-3">
          <ScrollTable label="Publication scope per benchmark" minWidth="min-w-[640px]">
            <thead>
              <tr>
                <Th>Benchmark</Th>
                <Th>Earliest date</Th>
                <Th>Latest date</Th>
                <Th num>New</Th>
                <Th num>Identical</Th>
                <Th num>Corrections</Th>
                <Th>Permission</Th>
              </tr>
            </thead>
            <tbody>
              {preview.scope.map((s) => {
                const el = preview.eligibility[s.benchmarkKey];
                return (
                  <tr key={s.benchmarkKey}>
                    <Td className="font-medium">{s.benchmarkKey}</Td>
                    <Td>{formatDate(s.earliestDate)}</Td>
                    <Td>{formatDate(s.latestDate)}</Td>
                    <Td num>{formatCount(s.newRows)}</Td>
                    <Td num>{formatCount(s.identicalRows)}</Td>
                    <Td num>{formatCount(s.correctionRows)}</Td>
                    <Td>{el?.eligible ? <Chip label="Permitted by an approved entitlement" tone="ok" /> : <Chip label="Not permitted: no approved entitlement covers this" tone="bad" />}</Td>
                  </tr>
                );
              })}
            </tbody>
          </ScrollTable>
        </div>
        {preview.scope.some((s) => s.gaps.length > 0) ? (
          <div className="mt-3 text-sm text-ink">
            <p className="font-medium">Gaps (days with no level; never filled in):</p>
            <ul className="list-disc pl-5">
              {preview.scope.flatMap((s) => s.gaps.slice(0, 20).map((g) => <li key={`${s.benchmarkKey}-${g.from}`}>{s.benchmarkKey}: {formatDate(g.from)} to {formatDate(g.to)} ({formatCount(g.weekdaysMissing)} weekday(s) missing)</li>))}
            </ul>
          </div>
        ) : null}
      </Panel>

      {preview.blockers.length > 0 ? (
        <Notice tone="bad" title="Publication is disabled" live="alert">
          <ul className="list-disc pl-5">{preview.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </Notice>
      ) : (
        <Notice tone="ok" title="No blockers">Nothing in the file or the permissions blocks publication. A user with the publish permission can still be required.</Notice>
      )}

      {preview.hardErrorCount > 0 ? (
        <Panel title={`Invalid rows (${formatCount(preview.hardErrorCount)} error${preview.hardErrorCount === 1 ? '' : 's'})`} description="Showing the first 100. Nothing can be published until every error is fixed and the file is uploaded again.">
          <ScrollTable label="Invalid rows" minWidth="min-w-[560px]">
            <thead><tr><Th num>Row</Th><Th>Reason</Th></tr></thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={i}><Td num>{e.rowNumber ?? 'file'}</Td><Td>{e.message}</Td></tr>
              ))}
            </tbody>
          </ScrollTable>
          {jobId ? <p className="mt-2 text-sm"><a className="font-semibold text-trust underline" href={apiPaths.jobErrors(jobId)}>Download all validation errors (CSV)</a></p> : null}
        </Panel>
      ) : null}

      {warnings.length > 0 ? (
        <Panel title={`Warnings (${formatCount(preview.warningCount)})`} description="Warnings do not block publication, but some need a confirmation.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {warnings.slice(0, 50).map((w, i) => <li key={i}>{w.rowNumber ? `Row ${w.rowNumber}: ` : ''}{w.message}</li>)}
          </ul>
        </Panel>
      ) : null}

      {preview.corrections.length > 0 ? (
        <Panel title="Proposed corrections" description="Stored level before and the level in the file. The old level is kept as revision history. First 50 shown.">
          <ScrollTable label="Corrections, before and after" minWidth="min-w-[480px]">
            <thead><tr><Th>Benchmark</Th><Th>Date</Th><Th num>Before</Th><Th num>After</Th></tr></thead>
            <tbody>
              {preview.corrections.slice(0, 50).map((c, i) => (
                <tr key={i}><Td>{c.benchmarkKey}</Td><Td>{formatDate(c.date)}</Td><Td num>{formatLevel(c.before)}</Td><Td num>{formatLevel(c.after)}</Td></tr>
              ))}
            </tbody>
          </ScrollTable>
        </Panel>
      ) : null}
    </div>
  );
}

export interface PublishSectionProps {
  jobId: string;
  mode: string;
  caps: BenchmarkCapabilityFlags;
  fileSha256: string;
  stagingDigest: string | null;
  mutation: { new: number; revive: number; identical: number; correction: number };
  benchmarks: string[];
  hardErrorCount: number;
  blockers: string[];
  eligible: boolean | null;
  requiredAcks: string[];
  stagedByMe: boolean;
  /** Called after a successful publication so the screens reload. */
  onPublished: (r: PublishResponse) => void;
  /** Called when the preview is stale and the operator chooses to start again. */
  onRestart?: () => void;
}

export function PublishSection(p: PublishSectionProps) {
  const [acks, setAcks] = useState<string[]>([]);
  const [selfAck, setSelfAck] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; r: PublishResponse } | { ok: false; f: ApiFailure } | null>(null);
  const signal = useUnmountSignal();

  const decision = publishDecision({
    caps: p.caps,
    mode: p.mode,
    hardErrorCount: p.hardErrorCount,
    blockers: p.blockers,
    eligible: p.eligible,
    requiredAcks: p.requiredAcks,
    acknowledged: acks,
    stagedByMe: p.stagedByMe,
    selfPublishAck: selfAck,
    hasValidatedPreview: Boolean(p.stagingDigest),
  });

  async function doPublish() {
    if (!p.stagingDigest || !decision.enabled) return;
    setConfirm(false);
    setBusy(true);
    const body = buildPublishBody({ fileSha256: p.fileSha256, stagingDigest: p.stagingDigest, mutation: p.mutation }, acks, p.requiredAcks, selfAck, p.stagedByMe);
    const r = await apiCall(apiPaths.jobPublish(p.jobId), { method: 'POST', json: body, signal: signal() });
    if (r.aborted) return;
    setBusy(false);
    if (r.ok && r.body && r.body.data) {
      const data = r.body.data as PublishResponse;
      setResult({ ok: true, r: data });
      p.onPublished(data);
    } else {
      setResult({ ok: false, f: failureOf(r, 'publish this import') });
    }
  }

  if (result?.ok) {
    const d = describePublishSuccess(result.r);
    return (
      <Notice tone="ok" title={d.headline} live="status">
        <ul className="list-disc pl-5">{d.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </Notice>
    );
  }

  return (
    <div className="space-y-3">
      {!decision.visible ? (
        <Notice tone="info" title="Publishing is not available to you">{decision.reasons[0]}</Notice>
      ) : (
        <>
          {p.requiredAcks.length > 0 ? (
            <fieldset className="rounded-compact border border-line p-3">
              <legend className="px-1 text-sm font-medium text-ink">Confirmations required before publishing</legend>
              {p.requiredAcks.map((a) => {
                const info = ackInfo(a);
                return <CheckField key={a} label={info.label} hint={info.warning} checked={acks.includes(a)} onChange={(v) => setAcks((cur) => (v ? [...cur, a] : cur.filter((x) => x !== a)))} />;
              })}
            </fieldset>
          ) : (
            <p className="text-sm text-muted">This upload needs no extra confirmations.</p>
          )}
          {p.stagedByMe ? <CheckField label="I staged this upload myself and confirm self-publication" hint="Normally a second person publishes. Self-publication is allowed only with this confirmation and is recorded." checked={selfAck} onChange={setSelfAck} /> : null}
          {!decision.enabled ? <IssueList issues={decision.reasons} tone="warn" /> : null}
          <Btn disabled={!decision.enabled} busy={busy} onClick={() => setConfirm(true)}>
            {p.mode === 'correction' ? 'Publish this correction' : 'Publish this history'}
          </Btn>
        </>
      )}
      {result && !result.ok ? (
        <Notice tone={result.f.kind === 'duplicate' ? 'warn' : 'bad'} title={result.f.kind === 'stale' ? 'The preview is out of date' : result.f.kind === 'forbidden' ? 'You are not permitted to publish this' : result.f.kind === 'duplicate' ? 'Already published' : 'Nothing was published'} live="alert">
          <p>{result.f.message}</p>
          {result.f.restart && p.onRestart ? (
            <div className="mt-2">
              <Btn kind="secondary" onClick={p.onRestart}>
                Start again with the file
              </Btn>
            </div>
          ) : null}
        </Notice>
      ) : null}
      <ConfirmDialog open={confirm} title="Publish to the benchmark series?" message={publishConfirmText(p.mutation, p.benchmarks, p.mode)} confirmLabel="Publish" destructive={false} onConfirm={() => void doPublish()} onCancel={() => setConfirm(false)} />
    </div>
  );
}
