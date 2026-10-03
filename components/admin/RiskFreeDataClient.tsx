'use client';

import { useEffect, useState } from 'react';
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';

// Risk-free Rate Data admin screen (NAV2). Everything shown comes from the capability-gated API; nothing here decides
// authorisation. A panel the caller's capabilities do not cover arrives as `not_permitted` and is described as such,
// never rendered as an empty list. Dates are day-first (dd-mm-yyyy). A 401/403/5xx is shown as an error, never as empty.

type Panel<T> = { state: 'ok'; data: T } | { state: 'unavailable'; reason: string } | { state: 'not_permitted' };
type Row = Record<string, unknown>;

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
  recentBatches: Panel<Row[]>;
  openReviewItems: Panel<Row[]>;
  recentCorrections: Panel<Row[]>;
  stateLog: Panel<Row[]>;
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
const d = (iso: unknown): string => (typeof iso === 'string' && iso ? formatDateShort(iso.slice(0, 10), 'INR') : 'never');
const dt = (iso: unknown): string => (typeof iso === 'string' && iso ? formatDateTimeShort(iso, 'INR') : 'never');
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [corr, setCorr] = useState({ seriesId: SERIES_IDS[0] as string, date: '', newValue: '', reason: '' });
  const [stateForm, setStateForm] = useState<Record<string, { enabled: boolean; termsStatus: string; reason: string }>>({});

  async function loadStatus() {
    try {
      const r = await fetch('/api/admin/investment-intelligence/risk-free-data');
      const j = await r.json();
      if (!r.ok) setStatusError(`${r.status}: ${j.error ?? 'Could not load status'}`);
      else {
        setStatus(j.data);
        setStatusError(null);
      }
    } catch {
      setStatusError('Could not load status.');
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

  async function send(url: string, body: unknown, okText: (data: Record<string, unknown>) => string, after?: () => void) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) {
        setMessage({ kind: 'error', text: `${r.status}: ${j.error ?? j.message ?? 'Request failed'}` });
        return null;
      }
      setMessage({ kind: 'ok', text: okText(j.data ?? {}) });
      after?.();
      void loadStatus();
      return j.data as Record<string, unknown>;
    } catch {
      setMessage({ kind: 'error', text: 'Request failed.' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function postUpload(action: 'preview' | 'commit') {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch('/api/admin/investment-intelligence/risk-free-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, seriesId, fileName: fileName || 'upload.csv', csvText, verifiedThrough: verifiedThrough || null, firstLoad, attested, attestationText: status?.attestationText, expectedSha256: preview?.fileSha256 }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMessage({ kind: 'error', text: `${r.status}: ${j.error ?? 'Request failed'}` });
        return;
      }
      if (action === 'preview') setPreview(j.data as Preview);
      else {
        const o = j.data as { status: string; inserted?: number; identical?: number };
        setMessage({ kind: 'ok', text: o.status === 'noop' ? `Nothing to write: every row is already published (${o.identical} identical).` : `${o.status === 'already_committed' ? 'This file was already committed. ' : ''}Committed: ${o.inserted ?? 0} row(s) written, ${o.identical ?? 0} identical row(s) skipped.` });
        setPreview(null);
        setAttested(false);
        void loadStatus();
      }
    } catch {
      setMessage({ kind: 'error', text: 'Request failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | null) {
    setPreview(null);
    setMessage(null);
    if (!file) return;
    setFileName(file.name);
    setCsvText(await file.text());
  }

  const caps = status?.capabilities;
  const permNote = (p: Panel<Row[]>, what: string) => (p.state === 'not_permitted' ? <p>{what} needs the risk-free data upload permission, which your account does not have.</p> : p.state === 'unavailable' ? <p><strong>Unavailable.</strong> {p.reason}</p> : null);

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Risk-free Rate Data</h1>
      <p style={{ opacity: 0.8, marginTop: '0.25rem' }}>
        The Reserve Bank of India rates behind the Sharpe ratio, Sortino ratio and Jensen&apos;s alpha in the Fund analytics report: the 91-day Treasury bill auction cut-off yield (primary) and the policy repo rate (secondary). Source: Reserve Bank of India. A published value is never edited by an upload; it is changed only by a recorded correction.
      </p>

      {statusError && (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {statusError}
        </p>
      )}
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#b91c1c' : '#166534' }}>
          {message.text}
        </p>
      )}
      {status?.state === 'unavailable' && (
        <p>
          <strong>Unavailable.</strong> {status.reason}
        </p>
      )}

      {status?.state === 'ok' && status.series && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Series</h2>
          <table style={{ width: '100%', marginTop: '0.5rem' }}>
            <caption style={{ textAlign: 'left', opacity: 0.7 }}>Each series, its switch, terms status and freshness</caption>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th scope="col">Series</th>
                <th scope="col">Role</th>
                <th scope="col">Switch</th>
                <th scope="col">Terms</th>
                <th scope="col" className={NUM_HEADER_CLASS}>Observations</th>
                <th scope="col">From</th>
                <th scope="col">Freshness</th>
              </tr>
            </thead>
            <tbody>
              {status.series.map((x) => (
                <tr key={x.seriesId}>
                  <td>{x.name}</td>
                  <td>{x.role}</td>
                  <td>{x.enabled ? 'ON' : 'OFF (ratios report the rate as unavailable)'}</td>
                  <td>{x.termsReviewStatus}</td>
                  <td className={NUM_CELL_CLASS}>
                    {x.observationCount}
                    {x.gapRowCount ? ` (+${x.gapRowCount} gap)` : ''}
                  </td>
                  <td>{d(x.firstObservationDate)}</td>
                  <td>
                    {x.freshness.state === 'no_data'
                      ? 'No data loaded'
                      : `${x.freshness.state === 'stale' ? 'STALE' : 'Fresh'}: ${x.freshness.daysSince} day(s) since ${x.freshness.basis === 'verification' ? 'last confirmed complete' : 'the last auction'} (${d(x.freshness.basis === 'verification' ? x.freshness.verifiedThroughDate : x.freshness.lastObservationDate)}); stale after ${x.freshness.staleAfterDays}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {status.weeklyRefresh && (
            <p style={{ marginTop: '0.75rem' }}>
              <strong>Weekly RBI refresh: {status.weeklyRefresh.jobEnabled ? 'ON' : 'OFF'}.</strong> It ships off and runs as a dry run first.
              {status.weeklyRefresh.consecutiveFailures > 0 ? ` ${status.weeklyRefresh.consecutiveFailures} consecutive failure(s).` : ''} Last success: {dt(status.weeklyRefresh.lastSuccessAt)}.
              {status.weeklyRefresh.disabledReason ? ` ${status.weeklyRefresh.disabledReason}` : ''}
            </p>
          )}
        </section>
      )}

      {status?.state === 'ok' && caps?.upload && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Upload rates (CSV)</h2>
          <p style={{ opacity: 0.8 }}>
            Columns: series_id, observation_date, value_percent, frequency, source_document, source_url, retrieved_on, notes (optional kind and gap_reason for an auction with no accepted bids). One series per file. You always preview before anything is written, and an upload never changes a value that is already published.
          </p>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            Series{' '}
            <select
              value={seriesId}
              onChange={(e) => {
                setSeriesId(e.target.value as (typeof SERIES_IDS)[number]);
                setPreview(null);
              }}
            >
              {SERIES_IDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            CSV file <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
          </label>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            Verified through (yyyy-mm-dd, for the repo rate: the day it was last confirmed complete){' '}
            <input
              value={verifiedThrough}
              placeholder="yyyy-mm-dd"
              onChange={(e) => {
                setVerifiedThrough(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={firstLoad} onChange={(e) => setFirstLoad(e.target.checked)} /> This is the first load of the historical file
          </label>
          <button type="button" disabled={busy || !csvText} onClick={() => void postUpload('preview')} style={{ marginTop: '0.75rem' }}>
            Preview (writes nothing)
          </button>

          {preview && (
            <div style={{ marginTop: '1rem' }} data-testid="risk-free-preview">
              <p>
                <strong>{preview.acceptedRows}</strong> usable row(s) of {preview.totalDataRows}, from {d(preview.dateFrom)} to {d(preview.dateTo)}
                {preview.gapRows ? ` (${preview.gapRows} gap row(s))` : ''}. Will write <strong>{preview.willInsert}</strong> new row(s); {preview.identicalToPublished} already published with the same value; {preview.conflictCount} conflict(s); {preview.rejectedRows} rejected.
              </p>
              <p>First rows: {preview.firstRows.map((r) => `${d(r.date)} ${r.value_percent ?? 'gap'}`).join(' | ')}</p>
              <p>Last rows: {preview.lastRows.map((r) => `${d(r.date)} ${r.value_percent ?? 'gap'}`).join(' | ')}</p>
              {preview.blockers.map((b, i) => (
                <p key={i} role="alert" style={{ color: '#b91c1c' }}>
                  Cannot commit: {b}
                </p>
              ))}
              {preview.warnings.map((w, i) => (
                <p key={i} style={{ color: '#92400e' }}>
                  {w}
                </p>
              ))}
              {preview.rejectedSample.length > 0 && (
                <details>
                  <summary>Rejected rows ({preview.rejectedRows})</summary>
                  <ul>
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
                  <summary>Conflicts with published values ({preview.conflictCount})</summary>
                  <ul>
                    {preview.conflicts.map((c, i) => (
                      <li key={i}>
                        {d(c.date)}: published {c.existing}, file {c.incoming}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <label style={{ display: 'block', marginTop: '0.75rem' }}>
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> {status.attestationText}
              </label>
              <button type="button" disabled={busy || !preview.canCommit || !attested} onClick={() => void postUpload('commit')} style={{ marginTop: '0.5rem' }}>
                Commit {preview.willInsert} row(s)
              </button>
              <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>Your account, the file hash, the row count and this attestation are recorded permanently and cannot be edited.</p>
            </div>
          )}
        </section>
      )}

      {status?.state === 'ok' && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Review queue</h2>
          {permNote(status.openReviewItems, 'The review queue')}
          {status.openReviewItems.state === 'ok' &&
            (status.openReviewItems.data.length === 0 ? (
              <p>Nothing is waiting for review.</p>
            ) : (
              <ul>
                {status.openReviewItems.data.map((it) => {
                  const id = s(it.id);
                  return (
                    <li key={id} style={{ marginBottom: '0.75rem' }}>
                      {s(it.series_id)} {it.observation_date ? d(it.observation_date) : ''}: {Array.isArray(it.reasons) ? (it.reasons as string[]).join(', ') : ''}
                      <details>
                        <summary>Evidence</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>{JSON.stringify({ candidate: it.candidate, evidence: it.evidence }, null, 2)}</pre>
                      </details>
                      <label>
                        Note (at least 20 characters){' '}
                        <input value={notes[id] ?? ''} onChange={(e) => setNotes({ ...notes, [id]: e.target.value })} style={{ width: '24rem' }} />
                      </label>{' '}
                      {(['accept', 'reject'] as const).map((decision) => (
                        <button key={decision} type="button" disabled={busy || (notes[id] ?? '').trim().length < 20} onClick={() => void send(`/api/admin/investment-intelligence/risk-free-data/review/${id}`, { decision, note: notes[id] }, () => (decision === 'accept' ? 'Accepted: the value is now published.' : 'Rejected: nothing was published.'))}>
                          {decision === 'accept' ? 'Accept' : 'Reject'}
                        </button>
                      ))}
                    </li>
                  );
                })}
              </ul>
            ))}
        </section>
      )}

      {status?.state === 'ok' && caps?.upload && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Correct one published value</h2>
          <p style={{ opacity: 0.8 }}>The only way a published value changes. The old value, the new value, your account and the reason are recorded permanently, and the affected cached results are invalidated.</p>
          <label>
            Series{' '}
            <select value={corr.seriesId} onChange={(e) => setCorr({ ...corr, seriesId: e.target.value })}>
              {SERIES_IDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Date (yyyy-mm-dd) <input value={corr.date} onChange={(e) => setCorr({ ...corr, date: e.target.value })} placeholder="yyyy-mm-dd" />
          </label>{' '}
          <label>
            New value (percent) <input value={corr.newValue} onChange={(e) => setCorr({ ...corr, newValue: e.target.value })} inputMode="decimal" />
          </label>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            Reason (at least 20 characters) <input value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} style={{ width: '32rem' }} />
          </label>
          <button
            type="button"
            style={{ marginTop: '0.5rem' }}
            disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(corr.date) || !(Number(corr.newValue) >= 0) || corr.newValue.trim() === '' || corr.reason.trim().length < 20}
            onClick={() => void send('/api/admin/investment-intelligence/risk-free-data/correct', { seriesId: corr.seriesId, date: corr.date, newValue: Number(corr.newValue), reason: corr.reason }, (o) => `Corrected: ${s(o.previous)} to ${s(o.new)}.`, () => setCorr({ ...corr, date: '', newValue: '', reason: '' }))}
          >
            Record correction
          </button>
        </section>
      )}

      {status?.state === 'ok' && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Switch a series on or off</h2>
          {!caps?.switch ? (
            <p>Switching a series needs the risk-free series switch permission, which your account does not have.</p>
          ) : (
            <>
              <p style={{ opacity: 0.8 }}>Switching a series off makes every Sharpe, Sortino and alpha figure report the risk-free rate as unavailable for every customer. No data is deleted. A reason is recorded permanently.</p>
              {status.series?.map((x) => {
                const f = stateForm[x.seriesId] ?? { enabled: x.enabled, termsStatus: x.termsReviewStatus, reason: '' };
                return (
                  <div key={x.seriesId} style={{ marginTop: '0.75rem' }}>
                    <strong>{x.name}</strong>{' '}
                    <label>
                      <input type="checkbox" checked={f.enabled} onChange={(e) => setStateForm({ ...stateForm, [x.seriesId]: { ...f, enabled: e.target.checked } })} /> Enabled
                    </label>{' '}
                    <label>
                      Terms status{' '}
                      <select value={f.termsStatus} onChange={(e) => setStateForm({ ...stateForm, [x.seriesId]: { ...f, termsStatus: e.target.value } })}>
                        {TERMS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: 'block', marginTop: '0.25rem' }}>
                      Reason (at least 20 characters) <input value={f.reason} onChange={(e) => setStateForm({ ...stateForm, [x.seriesId]: { ...f, reason: e.target.value } })} style={{ width: '32rem' }} />
                    </label>
                    <button
                      type="button"
                      disabled={busy || f.reason.trim().length < 20 || (f.enabled === x.enabled && f.termsStatus === x.termsReviewStatus)}
                      onClick={() => void send('/api/admin/investment-intelligence/risk-free-data/series-state', { seriesId: x.seriesId, enabled: f.enabled, termsStatus: f.termsStatus, reason: f.reason }, () => 'Series state saved.', () => setStateForm({ ...stateForm, [x.seriesId]: { ...f, reason: '' } }))}
                    >
                      Save
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </section>
      )}

      {status?.state === 'ok' && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>History</h2>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 600 }}>Uploads and refresh runs</h3>
          {permNote(status.recentBatches, 'The upload history')}
          {status.recentBatches.state === 'ok' &&
            (status.recentBatches.data.length === 0 ? (
              <p>No upload or refresh run has been recorded yet.</p>
            ) : (
              <table style={{ width: '100%' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    <th scope="col">When</th>
                    <th scope="col">Series</th>
                    <th scope="col">Source</th>
                    <th scope="col">File</th>
                    <th scope="col" className={NUM_HEADER_CLASS}>Written</th>
                    <th scope="col" className={NUM_HEADER_CLASS}>Identical</th>
                    <th scope="col">Range</th>
                    <th scope="col">By</th>
                  </tr>
                </thead>
                <tbody>
                  {status.recentBatches.data.map((b) => (
                    <tr key={s(b.id)}>
                      <td>{dt(b.created_at)}</td>
                      <td>{s(b.series_id)}</td>
                      <td>{s(b.source_kind)}</td>
                      <td>{s(b.file_name)}</td>
                      <td className={NUM_CELL_CLASS}>{s(b.rows_inserted)}</td>
                      <td className={NUM_CELL_CLASS}>{s(b.rows_identical_skipped)}</td>
                      <td>
                        {d(b.date_from)} to {d(b.date_to)}
                      </td>
                      <td>{b.source_kind === 'weekly_refresh' ? 'weekly job' : b.uploadedByMe ? 'you' : 'another admin'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginTop: '1rem' }}>Corrections</h3>
          {permNote(status.recentCorrections, 'The correction history')}
          {status.recentCorrections.state === 'ok' &&
            (status.recentCorrections.data.length === 0 ? (
              <p>No value has been corrected.</p>
            ) : (
              <ul>
                {status.recentCorrections.data.map((c) => (
                  <li key={s(c.id)}>
                    {dt(c.created_at)}: {s(c.series_id)} {d(c.observation_date)} changed from {s(c.previous_value_percent)} to {s(c.new_value_percent)} by {c.actedByMe ? 'you' : 'another admin'}: {s(c.reason)}
                  </li>
                ))}
              </ul>
            ))}
          <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginTop: '1rem' }}>Switch and terms changes</h3>
          {status.stateLog.state === 'ok' &&
            (status.stateLog.data.length === 0 ? (
              <p>No switch or terms change has been recorded.</p>
            ) : (
              <ul>
                {status.stateLog.data.map((c) => (
                  <li key={s(c.id)}>
                    {dt(c.created_at)}: {s(c.series_id)} {c.previous_enabled === c.new_enabled ? '' : `${c.previous_enabled ? 'on' : 'off'} to ${c.new_enabled ? 'on' : 'off'}; `}
                    {c.previous_terms_status === c.new_terms_status ? '' : `terms ${s(c.previous_terms_status)} to ${s(c.new_terms_status)}; `}by {c.actedByMe ? 'you' : 'another admin'}: {s(c.reason)}
                  </li>
                ))}
              </ul>
            ))}
          {status.stateLog.state === 'unavailable' && (
            <p>
              <strong>Unavailable.</strong> {status.stateLog.reason}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
