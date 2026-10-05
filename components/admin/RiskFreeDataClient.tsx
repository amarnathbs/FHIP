'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';
import { FileField } from '@/components/admin/FileField';
import { ActionMessage, Btn, CheckField, DateField, Notice, Panel, ScrollTable, SelectField, Td, TextField, Th } from '@/components/admin/benchmarkData/ui';
import { checkCorrection, checkVerifiedThrough, describeFailure, MIN_REASON_CHARS } from '@/components/admin/riskFreeFormLogic';

// Risk-free Rate Data admin screen (NAV2). Everything shown comes from the capability-gated API; nothing here decides
// authorisation. A panel the caller's capabilities do not cover arrives as `not_permitted` and is described as such,
// never rendered as an empty list. Dates are day-first: shown dd-mm-yyyy and TYPED as DD-MM-YYYY, and turned into the ISO value the
// API expects only when a request is sent (riskFreeFormLogic.ts). A 401/403/5xx is shown as an error, never as empty.
//
// Look and behaviour come from the shared admin kit (benchmarkData/ui.tsx): real buttons (Btn), bordered fields, visible focus
// rings, 44px touch targets, phone-width layout. The result of every button is shown directly under that button (ActionMessage:
// role alert / status, scrolled into view and focused), and also repeated in the banner at the top of the page.

type Panelled<T> = { state: 'ok'; data: T } | { state: 'unavailable'; reason: string } | { state: 'not_permitted' };
type Row = Record<string, unknown>;
type Msg = { kind: 'ok' | 'error'; text: string };

interface SeriesStatus {
  seriesId: string;
  name: string;
  role: string;
  cadence: string;
  enabled: boolean;
  termsReviewStatus: string;
  observationCount: number;
  gapRowCount: number;
  firstObservationDate: string | null;
  freshness: { state: 'no_data' | 'fresh' | 'stale'; basis: string; lastObservationDate: string | null; verifiedThroughDate: string | null; daysSince: number | null; staleAfterDays: number };
  datasetVersion: string;
}

interface Status {
  state: 'ok' | 'unavailable';
  reason?: string;
  capabilities: { upload: boolean; switch: boolean };
  attestationText: string;
  series?: SeriesStatus[];
  weeklyRefresh?: { jobEnabled: boolean; disabledReason: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; consecutiveFailures: number };
  recentBatches: Panelled<Row[]>;
  openReviewItems: Panelled<Row[]>;
  recentCorrections: Panelled<Row[]>;
  stateLog: Panelled<Row[]>;
}

interface Preview {
  fileSha256: string;
  totalDataRows: number;
  acceptedRows: number;
  rejectedRows: number;
  rejectedSample: Array<{ line: number; date: string | null; code: string; message: string }>;
  dateFrom: string | null;
  dateTo: string | null;
  firstRows: Array<{ date: string; value_percent: number | null; kind: string }>;
  lastRows: Array<{ date: string; value_percent: number | null; kind: string }>;
  gapRows: number;
  willInsert: number;
  identicalToPublished: number;
  conflictCount: number;
  conflicts: Array<{ date: string; existing: number | null; incoming: number | null }>;
  blockers: string[];
  warnings: string[];
  canCommit: boolean;
}

const TERMS = ['po_accepted_2026-10-03', 'confirmed_in_writing', 'pending_confirmation', 'declined'] as const;
const SERIES_IDS = ['RBI_91D_TBILL_CUTOFF_YIELD', 'RBI_POLICY_REPO_RATE'] as const;
const SERIES_OPTIONS = SERIES_IDS.map((k) => ({ value: k, label: k }));
const TERMS_OPTIONS = TERMS.map((t) => ({ value: t, label: t }));
const d = (iso: unknown): string => (typeof iso === 'string' && iso ? formatDateShort(iso.slice(0, 10), 'INR') : 'never');
const dt = (iso: unknown): string => (typeof iso === 'string' && iso ? formatDateTimeShort(iso, 'INR') : 'never');
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** One numbered step of the upload card. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="rounded-compact border border-line p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-trust text-sm font-semibold text-white">
          {n}
        </span>
        <h3 className="text-sm font-semibold text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </li>
  );
}

export default function RiskFreeDataClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [seriesId, setSeriesId] = useState<(typeof SERIES_IDS)[number]>(SERIES_IDS[0]);
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [verifiedThrough, setVerifiedThrough] = useState('');
  const [firstLoad, setFirstLoad] = useState(false);
  const [attested, setAttested] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busyArea, setBusyArea] = useState<string | null>(null);
  // The result of a press lives next to the button that caused it (keyed by area) and the latest one is repeated at the top.
  const [msgs, setMsgs] = useState<Record<string, Msg | null>>({});
  const [topMsg, setTopMsg] = useState<Msg | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [corr, setCorr] = useState({ seriesId: SERIES_IDS[0] as string, date: '', newValue: '', reason: '' });
  const [corrTried, setCorrTried] = useState(false);
  const [stateForm, setStateForm] = useState<Record<string, { enabled: boolean; termsStatus: string; reason: string }>>({});

  const busy = busyArea !== null;
  const setMsg = (area: string, m: Msg | null) => {
    setMsgs((prev) => ({ ...prev, [area]: m }));
    if (m) setTopMsg(m);
  };

  async function loadStatus() {
    try {
      const r = await fetch('/api/admin/investment-intelligence/risk-free-data');
      const j = await r.json().catch(() => null);
      if (!r.ok) setStatusError(describeFailure(r.status, j, 'Could not load the page.'));
      else {
        setStatus(j.data);
        setStatusError(null);
      }
    } catch {
      setStatusError('Could not load the page. Check your connection and reload.');
    }
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await loadStatus();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(area: string, url: string, body: unknown, okText: (data: Record<string, unknown>) => string, after?: () => void) {
    setBusyArea(area);
    setMsg(area, null);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setMsg(area, { kind: 'error', text: describeFailure(r.status, j, 'This could not be saved.') });
        return null;
      }
      setMsg(area, { kind: 'ok', text: okText(j?.data ?? {}) });
      after?.();
      void loadStatus();
      return (j?.data ?? {}) as Record<string, unknown>;
    } catch {
      setMsg(area, { kind: 'error', text: 'The request did not reach the server. Check your connection and try again.' });
      return null;
    } finally {
      setBusyArea(null);
    }
  }

  const vt = checkVerifiedThrough(verifiedThrough);

  async function postUpload(action: 'preview' | 'commit') {
    const area = action === 'preview' ? 'check' : 'upload';
    setMsg(area, null);
    if (!csvText) {
      setMsg(area, { kind: 'error', text: 'Choose the CSV file first (step 1).' });
      return;
    }
    if (!vt.ok) {
      setMsg(area, { kind: 'error', text: vt.error });
      return;
    }
    setBusyArea(area);
    try {
      const r = await fetch('/api/admin/investment-intelligence/risk-free-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The typed day-first date becomes ISO only here, at the API boundary.
        body: JSON.stringify({ action, seriesId, fileName: fileName || 'upload.csv', csvText, verifiedThrough: vt.iso, firstLoad, attested, attestationText: status?.attestationText, expectedSha256: preview?.fileSha256 }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setMsg(area, { kind: 'error', text: describeFailure(r.status, j, action === 'preview' ? 'The file could not be checked.' : 'The rows could not be uploaded.') });
        return;
      }
      if (action === 'preview') {
        const p = j.data as Preview;
        setPreview(p);
        setAttested(false);
        setMsg('check', p.canCommit ? { kind: 'ok', text: `The file was checked and nothing was written. ${p.willInsert} new row(s) are ready: go to step 3.` } : { kind: 'error', text: 'The file was checked and nothing was written, but it cannot be uploaded yet. The reasons are listed below.' });
      } else {
        const o = j.data as { status: string; inserted?: number; identical?: number };
        setMsg('upload', { kind: 'ok', text: o.status === 'noop' ? `Nothing to write: every row is already published (${o.identical} identical).` : `${o.status === 'already_committed' ? 'This file was already uploaded. ' : ''}Uploaded: ${o.inserted ?? 0} row(s) written, ${o.identical ?? 0} identical row(s) skipped.` });
        setPreview(null);
        setAttested(false);
        void loadStatus();
      }
    } catch {
      setMsg(area, { kind: 'error', text: 'The request did not reach the server. Check your connection and try again.' });
    } finally {
      setBusyArea(null);
    }
  }

  async function onFile(file: File | null) {
    setPreview(null);
    setAttested(false);
    setMsg('check', null);
    setMsg('upload', null);
    if (!file) return;
    setFileName(file.name);
    setCsvText(await file.text());
  }

  const caps = status?.capabilities;
  const permNote = (p: Panelled<Row[]>, what: string) => (p.state === 'not_permitted' ? <Notice tone="neutral">{what} needs the risk-free data upload permission, which your account does not have.</Notice> : p.state === 'unavailable' ? <Notice tone="warn" title="Unavailable">{p.reason}</Notice> : null);
  const corrCheck = checkCorrection(corr);
  const showCorrErr = (k: 'date' | 'newValue' | 'reason'): string | null => {
    const e = corrCheck.errors[k];
    if (!e) return null;
    return corrTried || corr[k].trim() !== '' ? e : null;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink">Risk-free Rate Data</h1>
        <p className="mt-1 text-sm text-muted">
          The Reserve Bank of India rates behind the Sharpe ratio, Sortino ratio and Jensen&apos;s alpha in the Fund analytics report: the 91-day Treasury bill auction cut-off yield (primary) and the policy repo rate (secondary). Source: Reserve Bank of India. A published value is never edited by an upload; it is changed only by a recorded correction.
        </p>
      </header>

      {statusError && <Notice tone="bad" live="alert" title="Could not load this page">{statusError}</Notice>}
      {topMsg && (
        <div data-testid="page-top-banner">
          <Notice tone={topMsg.kind === 'error' ? 'bad' : 'ok'} title={topMsg.kind === 'error' ? 'Last action: it did not work' : 'Last action: done'}>
            {topMsg.text}
          </Notice>
        </div>
      )}
      {status?.state === 'unavailable' && (
        <Notice tone="warn" live="alert" title="Unavailable">
          {status.reason}
        </Notice>
      )}

      {status?.state === 'ok' && status.series && (
        <Panel title="Series" description="Each series, its switch, terms status and freshness">
          <ScrollTable label="Risk-free series" minWidth="min-w-[860px]">
            <thead>
              <tr>
                <Th>Series</Th>
                <Th>Role</Th>
                <Th>Switch</Th>
                <Th>Terms</Th>
                <Th num>Observations</Th>
                <Th>From</Th>
                <Th>Freshness</Th>
              </tr>
            </thead>
            <tbody>
              {status.series.map((x) => (
                <tr key={x.seriesId}>
                  <Td>{x.name}</Td>
                  <Td>{x.role}</Td>
                  <Td>{x.enabled ? 'ON' : 'OFF (ratios report the rate as unavailable)'}</Td>
                  <Td>{x.termsReviewStatus}</Td>
                  <Td num>
                    {x.observationCount}
                    {x.gapRowCount ? ` (+${x.gapRowCount} gap)` : ''}
                  </Td>
                  <Td>{d(x.firstObservationDate)}</Td>
                  <Td>
                    {x.freshness.state === 'no_data'
                      ? 'No data loaded'
                      : `${x.freshness.state === 'stale' ? 'STALE' : 'Fresh'}: ${x.freshness.daysSince} day(s) since ${x.freshness.basis === 'verification' ? 'last confirmed complete' : 'the last auction'} (${d(x.freshness.basis === 'verification' ? x.freshness.verifiedThroughDate : x.freshness.lastObservationDate)}); stale after ${x.freshness.staleAfterDays}`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          {status.weeklyRefresh && (
            <p className="mt-3 text-sm text-ink">
              <strong>Weekly RBI refresh: {status.weeklyRefresh.jobEnabled ? 'ON' : 'OFF'}.</strong> It ships off and runs as a dry run first.
              {status.weeklyRefresh.consecutiveFailures > 0 ? ` ${status.weeklyRefresh.consecutiveFailures} consecutive failure(s).` : ''} Last success: {dt(status.weeklyRefresh.lastSuccessAt)}.
              {status.weeklyRefresh.disabledReason ? ` ${status.weeklyRefresh.disabledReason}` : ''}
            </p>
          )}
        </Panel>
      )}

      {status?.state === 'ok' && caps?.upload && (
        <Panel
          title="Upload rates (CSV)"
          description="Columns: series_id, observation_date, value_percent, frequency, source_document, source_url, retrieved_on, notes (optional kind and gap_reason for an auction with no accepted bids). One series per file. You always check the file before anything is written, and an upload never changes a value that is already published."
        >
          <ol className="space-y-4">
            <Step n={1} title="Choose the file">
              <SelectField
                label="Series"
                value={seriesId}
                hidePlaceholder
                options={SERIES_OPTIONS}
                onChange={(v) => {
                  setSeriesId(v as (typeof SERIES_IDS)[number]);
                  setPreview(null);
                  setAttested(false);
                }}
              />
              <FileField label="CSV file" accept=".csv,text/csv" fileName={fileName} onFile={(f) => void onFile(f)} hint="Choose the rates file from your computer. It is read in your browser first; nothing is sent until you press a button below." />
              <DateField
                label="Verified through (optional)"
                hint="For the repo rate: the day it was last confirmed complete."
                value={verifiedThrough}
                error={verifiedThrough.trim() !== '' && !vt.ok ? vt.error : null}
                onChange={(v) => {
                  setVerifiedThrough(v);
                  setPreview(null);
                  setAttested(false);
                }}
              />
              <CheckField label="This is the first load of the historical file" checked={firstLoad} onChange={setFirstLoad} />
            </Step>

            <Step n={2} title="Check the file">
              <p className="text-sm text-muted">This reads the file and shows what would happen. It writes nothing.</p>
              <div>
                <Btn kind="secondary" busy={busyArea === 'check'} disabled={busy} onClick={() => void postUpload('preview')}>
                  Check file (writes nothing)
                </Btn>
              </div>
              <ActionMessage message={msgs.check ?? null} />
              {preview && (
                <div className="space-y-2 text-sm text-ink" data-testid="risk-free-preview">
                  <p>
                    <strong>{preview.acceptedRows}</strong> usable row(s) of {preview.totalDataRows}, from {d(preview.dateFrom)} to {d(preview.dateTo)}
                    {preview.gapRows ? ` (${preview.gapRows} gap row(s))` : ''}. Will write <strong>{preview.willInsert}</strong> new row(s); {preview.identicalToPublished} already published with the same value; {preview.conflictCount} conflict(s); {preview.rejectedRows} rejected.
                  </p>
                  <p>First rows: {preview.firstRows.map((r) => `${d(r.date)} ${r.value_percent ?? 'gap'}`).join(' | ')}</p>
                  <p>Last rows: {preview.lastRows.map((r) => `${d(r.date)} ${r.value_percent ?? 'gap'}`).join(' | ')}</p>
                  {preview.blockers.map((b, i) => (
                    <Notice key={i} tone="bad" live="alert">
                      Cannot upload: {b}
                    </Notice>
                  ))}
                  {preview.warnings.map((w, i) => (
                    <Notice key={i} tone="warn">
                      {w}
                    </Notice>
                  ))}
                  {preview.rejectedSample.length > 0 && (
                    <details>
                      <summary className="cursor-pointer font-medium">Rejected rows ({preview.rejectedRows})</summary>
                      <ul className="mt-1 list-disc pl-6">
                        {preview.rejectedSample.map((r, i) => (
                          <li key={i}>
                            Line {r.line} [{r.code}]: {r.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {preview.conflicts.length > 0 && (
                    <details>
                      <summary className="cursor-pointer font-medium">Conflicts with published values ({preview.conflictCount})</summary>
                      <ul className="mt-1 list-disc pl-6">
                        {preview.conflicts.map((c, i) => (
                          <li key={i}>
                            {d(c.date)}: published {c.existing}, file {c.incoming}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </Step>

            <Step n={3} title={preview ? `Upload ${preview.willInsert} rows` : 'Upload the rows'}>
              {!preview && <p className="text-sm text-muted">Check the file first (step 2). The upload button is switched on once the check passes and you have ticked the box.</p>}
              <CheckField label={status.attestationText} checked={attested} disabled={!preview || !preview.canCommit} onChange={setAttested} />
              <div>
                <Btn kind="primary" busy={busyArea === 'upload'} disabled={busy || !preview || !preview.canCommit || !attested} onClick={() => void postUpload('commit')}>
                  {preview ? `Upload ${preview.willInsert} rows` : 'Upload rows'}
                </Btn>
              </div>
              <p className="text-xs text-muted">Your account, the file hash, the row count and this attestation are recorded permanently and cannot be edited.</p>
              <ActionMessage message={msgs.upload ?? null} />
            </Step>
          </ol>
        </Panel>
      )}

      {status?.state === 'ok' && (
        <Panel title="Review queue">
          {permNote(status.openReviewItems, 'The review queue')}
          {status.openReviewItems.state === 'ok' &&
            (status.openReviewItems.data.length === 0 ? (
              <p className="text-sm text-muted">Nothing is waiting for review.</p>
            ) : (
              <ul className="space-y-4">
                {status.openReviewItems.data.map((it) => {
                  const id = s(it.id);
                  const area = `review:${id}`;
                  const note = notes[id] ?? '';
                  return (
                    <li key={id} className="rounded-compact border border-line p-3">
                      <p className="text-sm font-medium text-ink">
                        {s(it.series_id)} {it.observation_date ? d(it.observation_date) : ''}: {Array.isArray(it.reasons) ? (it.reasons as string[]).join(', ') : ''}
                      </p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-sm text-trust">Evidence</summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify({ candidate: it.candidate, evidence: it.evidence }, null, 2)}</pre>
                      </details>
                      <div className="mt-3 max-w-xl">
                        <TextField label={`Note (at least ${MIN_REASON_CHARS} characters)`} value={note} onChange={(v) => setNotes({ ...notes, [id]: v })} hint={note.trim().length < MIN_REASON_CHARS ? `${note.trim().length} of ${MIN_REASON_CHARS} characters so far.` : undefined} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(['accept', 'reject'] as const).map((decision) => (
                          <Btn
                            key={decision}
                            kind={decision === 'accept' ? 'primary' : 'danger'}
                            busy={busyArea === area}
                            disabled={busy || note.trim().length < MIN_REASON_CHARS}
                            onClick={() => void send(area, `/api/admin/investment-intelligence/risk-free-data/review/${id}`, { decision, note }, () => (decision === 'accept' ? 'Accepted: the value is now published.' : 'Rejected: nothing was published.'))}
                          >
                            {decision === 'accept' ? 'Accept' : 'Reject'}
                          </Btn>
                        ))}
                      </div>
                      <ActionMessage message={msgs[area] ?? null} />
                    </li>
                  );
                })}
              </ul>
            ))}
        </Panel>
      )}

      {status?.state === 'ok' && caps?.upload && (
        <Panel title="Correct one published value" description="The only way a published value changes. The old value, the new value, your account and the reason are recorded permanently, and the affected cached results are invalidated.">
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField label="Series" value={corr.seriesId} hidePlaceholder options={SERIES_OPTIONS} onChange={(v) => setCorr({ ...corr, seriesId: v })} />
            <DateField label="Date" value={corr.date} error={showCorrErr('date')} onChange={(v) => setCorr({ ...corr, date: v })} />
            <TextField label="New value (percent)" value={corr.newValue} error={showCorrErr('newValue')} onChange={(v) => setCorr({ ...corr, newValue: v })} />
          </div>
          <div className="mt-3 max-w-2xl">
            <TextField label={`Reason (at least ${MIN_REASON_CHARS} characters)`} value={corr.reason} error={showCorrErr('reason')} onChange={(v) => setCorr({ ...corr, reason: v })} />
          </div>
          <div className="mt-3">
            <Btn
              kind="primary"
              busy={busyArea === 'correction'}
              disabled={busy}
              onClick={() => {
                setCorrTried(true);
                if (!corrCheck.ok) {
                  setMsg('correction', { kind: 'error', text: `The correction was not recorded. ${Object.values(corrCheck.errors).join(' ')}` });
                  return;
                }
                // The typed day-first date becomes ISO only here, at the API boundary.
                void send('correction', '/api/admin/investment-intelligence/risk-free-data/correct', { seriesId: corr.seriesId, date: corrCheck.iso, newValue: corrCheck.value, reason: corr.reason }, (o) => `Corrected: ${s(o.previous)} to ${s(o.new)}.`, () => {
                  setCorr({ ...corr, date: '', newValue: '', reason: '' });
                  setCorrTried(false);
                });
              }}
            >
              Record correction
            </Btn>
          </div>
          <ActionMessage message={msgs.correction ?? null} />
        </Panel>
      )}

      {status?.state === 'ok' && (
        <Panel title="Switch a series on or off">
          {!caps?.switch ? (
            <Notice tone="neutral">Switching a series needs the risk-free series switch permission, which your account does not have.</Notice>
          ) : (
            <>
              <p className="text-sm text-muted">Switching a series off makes every Sharpe, Sortino and alpha figure report the risk-free rate as unavailable for every customer. No data is deleted. A reason is recorded permanently.</p>
              <div className="mt-3 space-y-4">
                {status.series?.map((x) => {
                  const f = stateForm[x.seriesId] ?? { enabled: x.enabled, termsStatus: x.termsReviewStatus, reason: '' };
                  const area = `series:${x.seriesId}`;
                  const unchanged = f.enabled === x.enabled && f.termsStatus === x.termsReviewStatus;
                  return (
                    <div key={x.seriesId} className="rounded-compact border border-line p-3">
                      <h3 className="text-sm font-semibold text-ink">{x.name}</h3>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <CheckField label="Enabled" checked={f.enabled} onChange={(v) => setStateForm({ ...stateForm, [x.seriesId]: { ...f, enabled: v } })} />
                        <SelectField label="Terms status" value={f.termsStatus} hidePlaceholder options={TERMS_OPTIONS} onChange={(v) => setStateForm({ ...stateForm, [x.seriesId]: { ...f, termsStatus: v } })} />
                      </div>
                      <div className="mt-3 max-w-2xl">
                        <TextField label={`Reason (at least ${MIN_REASON_CHARS} characters)`} value={f.reason} onChange={(v) => setStateForm({ ...stateForm, [x.seriesId]: { ...f, reason: v } })} hint={unchanged ? 'Change the switch or the terms status to enable Save.' : f.reason.trim().length < MIN_REASON_CHARS ? `${f.reason.trim().length} of ${MIN_REASON_CHARS} characters so far.` : undefined} />
                      </div>
                      <div className="mt-3">
                        <Btn
                          kind="primary"
                          busy={busyArea === area}
                          disabled={busy || f.reason.trim().length < MIN_REASON_CHARS || unchanged}
                          onClick={() => void send(area, '/api/admin/investment-intelligence/risk-free-data/series-state', { seriesId: x.seriesId, enabled: f.enabled, termsStatus: f.termsStatus, reason: f.reason }, () => 'Series state saved.', () => setStateForm({ ...stateForm, [x.seriesId]: { ...f, reason: '' } }))}
                        >
                          Save
                        </Btn>
                      </div>
                      <ActionMessage message={msgs[area] ?? null} />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Panel>
      )}

      {status?.state === 'ok' && (
        <Panel title="History">
          <h3 className="text-sm font-semibold text-ink">Uploads and refresh runs</h3>
          <div className="mt-2">
            {permNote(status.recentBatches, 'The upload history')}
            {status.recentBatches.state === 'ok' &&
              (status.recentBatches.data.length === 0 ? (
                <p className="text-sm text-muted">No upload or refresh run has been recorded yet.</p>
              ) : (
                <ScrollTable label="Uploads and refresh runs" minWidth="min-w-[820px]">
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Series</Th>
                      <Th>Source</Th>
                      <Th>File</Th>
                      <Th num>Written</Th>
                      <Th num>Identical</Th>
                      <Th>Range</Th>
                      <Th>By</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recentBatches.data.map((b) => (
                      <tr key={s(b.id)}>
                        <Td>{dt(b.created_at)}</Td>
                        <Td>{s(b.series_id)}</Td>
                        <Td>{s(b.source_kind)}</Td>
                        <Td>{s(b.file_name)}</Td>
                        <Td num>{s(b.rows_inserted)}</Td>
                        <Td num>{s(b.rows_identical_skipped)}</Td>
                        <Td>
                          {d(b.date_from)} to {d(b.date_to)}
                        </Td>
                        <Td>{b.source_kind === 'weekly_refresh' ? 'weekly job' : b.uploadedByMe ? 'you' : 'another admin'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              ))}
          </div>
          <h3 className="mt-5 text-sm font-semibold text-ink">Corrections</h3>
          <div className="mt-2">
            {permNote(status.recentCorrections, 'The correction history')}
            {status.recentCorrections.state === 'ok' &&
              (status.recentCorrections.data.length === 0 ? (
                <p className="text-sm text-muted">No value has been corrected.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-6 text-sm text-ink">
                  {status.recentCorrections.data.map((c) => (
                    <li key={s(c.id)}>
                      {dt(c.created_at)}: {s(c.series_id)} {d(c.observation_date)} changed from {s(c.previous_value_percent)} to {s(c.new_value_percent)} by {c.actedByMe ? 'you' : 'another admin'}: {s(c.reason)}
                    </li>
                  ))}
                </ul>
              ))}
          </div>
          <h3 className="mt-5 text-sm font-semibold text-ink">Switch and terms changes</h3>
          <div className="mt-2">
            {status.stateLog.state === 'ok' &&
              (status.stateLog.data.length === 0 ? (
                <p className="text-sm text-muted">No switch or terms change has been recorded.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-6 text-sm text-ink">
                  {status.stateLog.data.map((c) => (
                    <li key={s(c.id)}>
                      {dt(c.created_at)}: {s(c.series_id)} {c.previous_enabled === c.new_enabled ? '' : `${c.previous_enabled ? 'on' : 'off'} to ${c.new_enabled ? 'on' : 'off'}; `}
                      {c.previous_terms_status === c.new_terms_status ? '' : `terms ${s(c.previous_terms_status)} to ${s(c.new_terms_status)}; `}by {c.actedByMe ? 'you' : 'another admin'}: {s(c.reason)}
                    </li>
                  ))}
                </ul>
              ))}
            {status.stateLog.state === 'unavailable' && (
              <Notice tone="warn" title="Unavailable">
                {status.stateLog.reason}
              </Notice>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
