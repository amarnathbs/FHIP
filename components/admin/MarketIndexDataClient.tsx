'use client';

import { useEffect, useState } from 'react';
import { MARKET_INDEX_KEY_LIST, MARKET_INDEX_LABELS, type MarketIndexKey } from '@/lib/config/investment-intelligence/marketIndexConfig';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';

// Market Index Data admin screen. Two sections: upload (preview first, then an
// attested commit) and status (latest close per index, upload ledger, the
// daily-feed switch state). Everything shown comes from the capability-gated
// API; nothing here decides authorisation.
//
// RESULT STATES (Admin Standard section 8): "never loaded" and "stale" are
// shown as such, never as a zero. A 401/403/5xx is shown as an error, never
// as an empty list.

interface StatusPayload {
  state: 'ok' | 'unavailable';
  reason?: string;
  attestationText: string;
  indices?: Array<{ key: MarketIndexKey; label: string; freshness: { state: string; detail: string }; latestClose: number | null; firstDate: string | null; rowCount: number }>;
  recentBatches?: Array<{ id: string; benchmark_key: string; source_kind: string; file_name: string | null; row_count_submitted: number; rows_inserted: number; rows_identical_skipped: number; date_from: string | null; date_to: string | null; created_at: string; uploadedByMe: boolean }>;
  dailyFeed?: { jobEnabled: boolean; environmentEnabled: boolean; effectivelyEnabled: boolean; disabledReason: string | null; lastSuccessAt: string | null; consecutiveFailures: number; termsWarning: string };
}

interface Preview {
  fileSha256: string;
  parserLayout: string;
  totalDataRows: number;
  acceptedRows: number;
  weekendHeldBack: number;
  rejectedRows: number;
  rejectedSample: Array<{ rowNumber: number; reason: string; code: string }>;
  identicalDuplicatesCollapsed: number;
  otherIndexRowsIgnored: number;
  largeMoves: Array<{ date: string; previousDate: string; changeFraction: number }>;
  dateFrom: string | null;
  dateTo: string | null;
  min: number | null;
  max: number | null;
  firstRows: Array<{ date: string; close: number }>;
  lastRows: Array<{ date: string; close: number }>;
  willInsert: number;
  identicalToPublished: number;
  conflictCount: number;
  conflicts: Array<{ date: string; existing: number; incoming: number }>;
  blockers: string[];
  warnings: string[];
  canCommit: boolean;
}

export default function MarketIndexDataClient() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [indexKey, setIndexKey] = useState<MarketIndexKey>(MARKET_INDEX_KEY_LIST[0]);
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [includeWeekendRows, setIncludeWeekendRows] = useState(false);
  const [skipConflicts, setSkipConflicts] = useState(false);
  const [attested, setAttested] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function loadStatus() {
    try {
      const r = await fetch('/api/admin/investment-intelligence/market-index-data');
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

  async function post(action: 'preview' | 'commit') {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch('/api/admin/investment-intelligence/market-index-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          indexKey,
          fileName,
          csvText,
          includeWeekendRows,
          skipConflicts,
          attested,
          attestationText: status?.attestationText,
          expectedSha256: preview?.fileSha256,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMessage({ kind: 'error', text: `${r.status}: ${j.error ?? 'Request failed'}` });
        return;
      }
      if (action === 'preview') {
        setPreview(j.data as Preview);
      } else {
        const d = j.data as { status: string; inserted?: number; identical?: number };
        setMessage({
          kind: 'ok',
          text:
            d.status === 'noop'
              ? `Nothing to write: every row is already published (${d.identical} identical).`
              : `${d.status === 'already_committed' ? 'This file was already committed. ' : ''}Committed: ${d.inserted ?? 0} row(s) written, ${d.identical ?? 0} identical row(s) skipped.`,
        });
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

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Market Index Data</h1>
      <p style={{ opacity: 0.8, marginTop: '0.25rem' }}>
        Historical daily closing values of the Nifty 50 and the BSE Sensex (price index close, not total return). They are shown in the header of the India Mutual Fund Investment Report and are not used for any fund-versus-benchmark comparison.
      </p>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Status</h2>
        {statusError && (
          <p role="alert" style={{ color: '#b91c1c' }}>
            {statusError}
          </p>
        )}
        {status?.state === 'unavailable' && (
          <p>
            <strong>Unavailable.</strong> {status.reason}
          </p>
        )}
        {status?.state === 'ok' && (
          <>
            <table style={{ width: '100%', marginTop: '0.5rem' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Index</th>
                  <th className={NUM_HEADER_CLASS}>Rows</th>
                  <th>From</th>
                  <th className={NUM_HEADER_CLASS}>Latest close</th>
                  <th>Freshness</th>
                </tr>
              </thead>
              <tbody>
                {status.indices?.map((i) => (
                  <tr key={i.key}>
                    <td>{MARKET_INDEX_LABELS[i.key] ?? i.label}</td>
                    <td className={NUM_CELL_CLASS}>{i.rowCount}</td>
                    <td>{i.firstDate ?? 'never loaded'}</td>
                    <td className={NUM_CELL_CLASS}>{i.latestClose === null ? 'n/a' : i.latestClose.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td>
                      {i.freshness.state === 'never_ingested' ? 'never loaded' : i.freshness.state}: {i.freshness.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {status.dailyFeed && (
              <div style={{ marginTop: '1rem', padding: '0.75rem', border: '1px solid #d4d4d8', borderRadius: 6 }}>
                <strong>Daily feed: {status.dailyFeed.effectivelyEnabled ? 'ON' : 'OFF'}</strong>
                <p style={{ margin: '0.25rem 0' }}>
                  Switches: database job {status.dailyFeed.jobEnabled ? 'on' : 'off'}; environment {status.dailyFeed.environmentEnabled ? 'on' : 'off'}. Both ship off.
                  {status.dailyFeed.consecutiveFailures > 0 ? ` ${status.dailyFeed.consecutiveFailures} consecutive failure(s).` : ''}
                </p>
                <p style={{ margin: 0, color: '#92400e' }}>{status.dailyFeed.termsWarning}</p>
              </div>
            )}
          </>
        )}
      </section>

      {status?.state === 'ok' && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Upload historical closes</h2>
          <p style={{ opacity: 0.8 }}>
            Accepted layouts: the niftyindices.com historical export (Index Name, Date, Open, High, Low, Close), the NSE daily index file (Closing Index Value), the BSE archive (Date, Open, High, Low, Close), or two columns date,close. Dates are day-first (02-01-2024, 02 Jan 2024, 02-January-2024) or yyyy-mm-dd. Maximum 5 MB / 20,000 rows. You always preview before anything is written.
          </p>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            Index{' '}
            <select
              value={indexKey}
              onChange={(e) => {
                setIndexKey(e.target.value as MarketIndexKey);
                setPreview(null);
              }}
            >
              {MARKET_INDEX_KEY_LIST.map((k) => (
                <option key={k} value={k}>
                  {MARKET_INDEX_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            CSV file <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
          </label>
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              checked={includeWeekendRows}
              onChange={(e) => {
                setIncludeWeekendRows(e.target.checked);
                setPreview(null);
              }}
            />{' '}
            Include Saturday/Sunday rows (only for genuine special sessions)
          </label>
          <label style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={skipConflicts}
              onChange={(e) => {
                setSkipConflicts(e.target.checked);
                setPreview(null);
              }}
            />{' '}
            Skip dates that already hold a different published value (they are never overwritten)
          </label>
          <button type="button" disabled={busy || !csvText} onClick={() => void post('preview')} style={{ marginTop: '0.75rem' }}>
            Preview (writes nothing)
          </button>

          {preview && (
            <div style={{ marginTop: '1rem' }} data-testid="market-index-preview">
              <p>
                <strong>{preview.acceptedRows}</strong> usable weekday row(s) from {preview.dateFrom} to {preview.dateTo} (layout: {preview.parserLayout}); values {preview.min?.toLocaleString('en-IN')} to {preview.max?.toLocaleString('en-IN')}. Will write{' '}
                <strong>{preview.willInsert}</strong> new row(s); {preview.identicalToPublished} already published with the same value; {preview.conflictCount} conflict(s); {preview.rejectedRows} rejected; {preview.weekendHeldBack} weekend row(s) held back.
              </p>
              <p>First rows: {preview.firstRows.map((r) => `${r.date} ${r.close}`).join(' | ')}</p>
              <p>Last rows: {preview.lastRows.map((r) => `${r.date} ${r.close}`).join(' | ')}</p>
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
                        Row {r.rowNumber} [{r.code}]: {r.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {preview.largeMoves.length > 0 && (
                <details>
                  <summary>Day-over-day moves above 10% ({preview.largeMoves.length})</summary>
                  <ul>
                    {preview.largeMoves.map((m, i) => (
                      <li key={i}>
                        {m.previousDate} to {m.date}: {(m.changeFraction * 100).toFixed(1)}%
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
                        {c.date}: published {c.existing}, file {c.incoming}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <label style={{ display: 'block', marginTop: '0.75rem' }}>
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> {status.attestationText}
              </label>
              <button type="button" disabled={busy || !preview.canCommit || !attested} onClick={() => void post('commit')} style={{ marginTop: '0.5rem' }}>
                Commit {preview.willInsert} row(s)
              </button>
              <p style={{ opacity: 0.7, fontSize: '0.85rem' }}>Your account, the file hash, the row count and this attestation are recorded permanently and cannot be edited.</p>
            </div>
          )}
          {message && (
            <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ marginTop: '0.75rem', color: message.kind === 'error' ? '#b91c1c' : '#166534' }}>
              {message.text}
            </p>
          )}
        </section>
      )}

      {status?.state === 'ok' && status.recentBatches && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 600 }}>Recent uploads and feed runs</h2>
          {status.recentBatches.length === 0 ? (
            <p>No upload or feed run has been recorded yet.</p>
          ) : (
            <table style={{ width: '100%' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>When</th>
                  <th>Index</th>
                  <th>Source</th>
                  <th>File</th>
                  <th className={NUM_HEADER_CLASS}>Written</th>
                  <th className={NUM_HEADER_CLASS}>Identical</th>
                  <th>Range</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {status.recentBatches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.created_at.slice(0, 16).replace('T', ' ')}</td>
                    <td>{b.benchmark_key}</td>
                    <td>{b.source_kind}</td>
                    <td>{b.file_name ?? ''}</td>
                    <td className={NUM_CELL_CLASS}>{b.rows_inserted}</td>
                    <td className={NUM_CELL_CLASS}>{b.rows_identical_skipped}</td>
                    <td>
                      {b.date_from} to {b.date_to}
                    </td>
                    <td>{b.source_kind === 'daily_feed' ? 'feed' : b.uploadedByMe ? 'you' : 'another admin'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
