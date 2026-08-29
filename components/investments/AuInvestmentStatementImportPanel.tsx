'use client';

/**
 * FDH-11 — Australia Investment Statement Intelligence: the Investments-tab
 * statement import journey (spec sections 2, 15-25, 43-46, 63-65, 76, 108).
 *
 * Upload -> Review evidence -> Match account -> Match securities -> Bank
 * match -> Approve evidence -> Current vs statement -> explicit Apply.
 * Every step before the final Apply click is INERT — nothing here mutates
 * canonical Investment Intelligence until the user presses "Apply" (spec
 * section 63).
 *
 * WHY THIS FILE, NOT A NEW TOP-LEVEL DESTINATION. Product architecture (spec
 * section 76): FDH-11 lives entirely behind the Investments tab, exactly
 * like FDH-9/FDH-10 live behind Income/Liabilities
 * (`components/income/PayslipImportPanel.tsx`,
 * `components/liabilities/LiabilityImportPanel.tsx`, whose structure this
 * file deliberately mirrors). This component talks to the FDH-backed API
 * surface purely over `fetch()`.
 */

import { useState } from 'react';

type Phase = 'form' | 'uploading' | 'unable_to_read' | 'duplicate' | 'review' | 'matching' | 'comparing' | 'applied' | 'error';

interface Statement {
  id: string;
  statement_type: string;
  institution_name: string | null;
  masked_account_identifier: string | null;
  base_currency: string;
  opening_portfolio_value: number | null;
  closing_portfolio_value: number | null;
  cash_balance: number | null;
  reconciliation_status: 'reconciled' | 'variance' | 'insufficient_data';
  approval_status: 'pending' | 'approved';
  canonical_account_id: string | null;
}
interface Position {
  id: string;
  security_name_raw: string;
  ticker_raw: string | null;
  isin: string | null;
  quantity: string;
  security_match_status: string;
  matched_instrument_id: string | null;
}
interface Activity {
  id: string;
  activity_type: string;
  trade_date: string | null;
  amount: string;
  security_match_status: string;
  bank_match_status: string;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const reconciliationLabel: Record<string, string> = {
  reconciled: 'Reconciled — the statement adds up',
  variance: 'Needs review — a gap was found between the statement and canonical holdings',
  insufficient_data: 'Insufficient information to check this statement',
};

export function AuInvestmentStatementImportPanel({ onClose, onApplied }: { onClose: () => void; onApplied?: () => void }) {
  const [phase, setPhase] = useState<Phase>('form');
  const [csvKind, setCsvKind] = useState<'transaction' | 'portfolio'>('transaction');
  const [institutionName, setInstitutionName] = useState('');
  const [maskedAccountIdentifier, setMaskedAccountIdentifier] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<{ applied_count: number } | null>(null);

  function reset() {
    setPhase('form');
    setFile(null);
    setDocumentId(null);
    setMessage(null);
    setStatement(null);
    setPositions([]);
    setActivities([]);
  }

  async function loadReview(docId: string) {
    const res = await fetch(`/api/financial-data-hub/investment-statement/${docId}`);
    const { ok, json } = await readJson(res);
    if (!ok) {
      setMessage(json.error ?? 'We could not load this statement.');
      setPhase('error');
      return;
    }
    setStatement(json.data.statement as Statement);
    setPositions((json.data.positions as Position[]) ?? []);
    setActivities((json.data.activities as Activity[]) ?? []);
    setPhase('review');
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    try {
      const params = new URLSearchParams({ csv_kind: csvKind, currency_code: 'AUD' });
      if (institutionName) params.set('institution_name', institutionName);
      if (maskedAccountIdentifier) params.set('masked_account_identifier', maskedAccountIdentifier);

      const res = await fetch(`/api/financial-data-hub/investment-statement/upload?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      });
      const { ok, json } = await readJson(res);
      if (!ok) {
        setMessage(json.error ?? 'We could not process this statement.');
        setPhase('unable_to_read');
        return;
      }
      if (!json.data.statement_id) {
        setMessage(json.data.error_message ?? 'We could not read this statement.');
        setPhase('unable_to_read');
        return;
      }
      setDocumentId(json.data.document_id as string);
      if (json.data.duplicate) {
        setMessage('This statement has already been uploaded. Showing the evidence already on file.');
        await loadReview(json.data.document_id as string);
        setPhase('duplicate');
        return;
      }
      await loadReview(json.data.document_id as string);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleMatchAll() {
    if (!documentId) return;
    setBusy(true);
    setPhase('matching');
    try {
      await fetch(`/api/financial-data-hub/investment-statement/${documentId}/account-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', account_type: 'broker', currency_code: statement?.base_currency ?? 'AUD' }),
      });
      for (const row of positions) {
        if (row.security_match_status === 'not_attempted') {
          await fetch(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'fdh_investment_statement_positions', row_id: row.id }),
          });
        }
      }
      for (const row of activities) {
        if (row.security_match_status === 'not_attempted') {
          await fetch(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'fdh_investment_statement_activities', row_id: row.id }),
          });
        }
      }
      await fetch(`/api/financial-data-hub/investment-statement/${documentId}/bank-match`, { method: 'POST' });
      await loadReview(documentId);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/approve`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'Could not approve this statement evidence.');
      await loadReview(documentId);
      setPhase('comparing');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/apply`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'The change could not be saved.');
      setApplyResult({ applied_count: json.data.applied_count });
      setPhase('applied');
      onApplied?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  const unresolvedCount = [...positions, ...activities].filter((r) => r.security_match_status !== 'matched').length;

  return (
    <div role="region" aria-label="Import an Australian investment statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import Australian Investment Statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close statement import">
          Close
        </button>
      </div>

      {phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a transaction-history or portfolio-holdings CSV and FHIP will extract the details for you to review before
            anything is added to your Investments.
          </p>
          <p className="text-xs text-muted">
            FHIP currently reads two generic Australian CSV layouts (a transaction-history export and a portfolio/holdings
            export with standard column headers). Broker-specific exports or PDF statements outside these layouts are not
            yet supported — you can still add the investment manually below instead.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Statement contains</span>
              <select className="w-full rounded border border-gray-300 px-3 py-2" value={csvKind} onChange={(e) => setCsvKind(e.target.value as 'transaction' | 'portfolio')}>
                <option value="transaction">Transaction history</option>
                <option value="portfolio">Portfolio / holdings</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Broker / institution</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Account (masked, e.g. ****1234)</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={maskedAccountIdentifier} onChange={(e) => setMaskedAccountIdentifier(e.target.value)} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement file (CSV)</span>
            <input type="file" accept="text/csv,.csv" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" onClick={handleUpload} disabled={!file || busy} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
            Upload statement
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'matching') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' ? 'Uploading and reading your statement…' : 'Matching accounts, securities and bank evidence…'}
        </p>
      )}

      {phase === 'unable_to_read' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <p className="text-sm text-muted">You can try a different file, or add this investment manually instead.</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {(phase === 'review' || phase === 'duplicate' || phase === 'comparing') && statement && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Statement review</h3>
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Institution</dt>
            <dd>{statement.institution_name ?? 'Not identified'}</dd>
            <dt className="text-muted">Account (masked)</dt>
            <dd>{statement.masked_account_identifier ?? 'Not provided'}</dd>
            <dt className="text-muted">Investment account</dt>
            <dd>{statement.canonical_account_id ? 'Matched to an existing account' : 'Not yet matched'}</dd>
          </dl>
          <p className="text-sm" role="status">
            <span className="font-medium">Reconciliation: </span>
            {reconciliationLabel[statement.reconciliation_status]}
          </p>

          {positions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">Holdings on this statement ({positions.length})</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {positions.map((p) => (
                  <li key={p.id} className="flex justify-between border-b border-gray-100 py-1">
                    <span>{p.security_name_raw} — {p.quantity} units</span>
                    <span className="text-muted">{p.security_match_status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {activities.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">Transactions on this statement ({activities.length})</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {activities.map((a) => (
                  <li key={a.id} className="flex justify-between border-b border-gray-100 py-1">
                    <span>{a.trade_date ?? '—'} — {a.activity_type} {a.amount}</span>
                    <span className="text-muted">{a.security_match_status} / {a.bank_match_status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {statement.approval_status !== 'approved' && (
            <div className="flex gap-3">
              <button type="button" onClick={handleMatchAll} disabled={busy} className="rounded border border-trust px-3 py-1 text-sm text-trust">
                Match accounts &amp; securities
              </button>
              <button type="button" onClick={handleApprove} disabled={busy || unresolvedCount > 0} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
                Approve evidence
              </button>
              {unresolvedCount > 0 && <span className="self-center text-xs text-muted">{unresolvedCount} item(s) still need a confirmed match — review required.</span>}
            </div>
          )}

          {statement.approval_status === 'approved' && (
            <div className="space-y-2">
              <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">This statement evidence has been approved. Canonical Investment Intelligence is still unchanged.</p>
              <button type="button" onClick={handleApply} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Apply to Investment Intelligence
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'applied' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {applyResult ? `${applyResult.applied_count} item(s) applied to your Investment Intelligence portfolio.` : 'Applied.'}
          </p>
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Done</button>
        </div>
      )}
    </div>
  );
}
