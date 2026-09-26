'use client';

/**
 * WP-11 (G7): "Statement history" on the Liabilities tab. For each liability
 * with imported card/loan statements: every statement, every line on it and
 * what that line BECAME in your figures (spending, a transfer from your bank,
 * cost of debt, principal, a drawdown...), the bank-payment match, and any
 * warnings the statement raised. A statement applied before activity recording
 * existed can be recorded from here, once.
 *
 * Talks to GET/POST /api/liabilities/{id}/statements only; rows are snake_case
 * exactly as the API returns them (a camelCase cast would render blank --
 * tests/unit/fdh10LiabilityLedgerUi.test.tsx holds the contract).
 */
import { useCallback, useEffect, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import { fdhPages } from '@/lib/import-bridge/fdhRoutes';
import {
  ACTIVITY_LEDGER_OUTCOME,
  ALLOCATION_LABELS,
  BLOCKER_LABELS,
  LEDGER_DISPOSITION_LABELS,
  describeExtractionWarning,
} from './liabilityLedgerCopy';

interface LiabilityOption { id: string; liability_name: string; source_type: string | null }

export interface HistoryActivityRow {
  id: string;
  activity_type: string;
  activity_date: string;
  amount: number;
  currency_code: string;
  description_raw: string | null;
  bank_match_status: string;
  ledger_disposition: string | null;
  ledger: {
    transaction_id: string;
    credit_debit: 'credit' | 'debit';
    economic_transaction_type: string;
    amount: number;
    allocations: { economic_transaction_type: string; amount: number }[];
    settlement_link_status: 'confirmed' | 'pending' | null;
  } | null;
}

export interface HistoryStatementRow {
  id: string;
  statement_type: string;
  institution_name: string | null;
  masked_identifier: string | null;
  statement_period_start: string | null;
  statement_period_end: string | null;
  currency_code: string;
  drawdowns_total: number | null;
  ledger_status: string;
  ledger_rejected_reason: string | null;
  extraction_warnings: { code: string; row?: number; detail?: string }[];
  can_record: boolean;
  activities: HistoryActivityRow[];
}

const money = (v: number | null | undefined, currency: string) => (v === null || v === undefined ? '—' : formatMoneyExact(v, currency));

function settlementText(a: HistoryActivityRow): string | null {
  if (a.activity_type !== 'PAYMENT' && a.activity_type !== 'PRINCIPAL') return null;
  if (a.ledger?.settlement_link_status === 'confirmed') return 'Matched to your bank payment';
  if (a.bank_match_status === 'multiple_candidates') return 'Several possible bank payments — not yet chosen';
  return 'No bank payment found yet — it will be matched when that bank statement is approved';
}

/** One statement's lines and what each became. Exported for its render test. */
export function StatementHistoryTable({ statement }: { statement: HistoryStatementRow }) {
  const c = statement.currency_code;
  return (
    <div className="space-y-2">
      {statement.ledger_status === 'rejected' && (
        <p className="rounded bg-gray-50 px-3 py-2 text-sm">You rejected this statement, so none of its lines are counted.</p>
      )}
      {statement.drawdowns_total !== null && statement.drawdowns_total > 0 && (
        <p className="text-sm">Drawdowns this period: {money(statement.drawdowns_total, c)} <span className="text-xs text-muted">(money borrowed — never income)</span></p>
      )}
      {statement.extraction_warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900" aria-label="Notes from reading this statement">
          {statement.extraction_warnings.map((w, i) => <li key={`${w.code}-${i}`}>{describeExtractionWarning(w)}</li>)}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <caption className="sr-only">Statement lines and how each is counted</caption>
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th scope="col" className="py-1 pr-2">Date</th>
              <th scope="col" className="py-1 pr-2">Line</th>
              <th scope="col" className="py-1 pr-2 text-right">Amount</th>
              <th scope="col" className="py-1">How it counts</th>
            </tr>
          </thead>
          <tbody>
            {statement.activities.map((a) => {
              const outcome = ACTIVITY_LEDGER_OUTCOME[a.activity_type] ?? { label: a.activity_type, counts: 'Not counted' };
              const disposition = a.ledger_disposition && a.ledger_disposition !== 'ledger_row' ? LEDGER_DISPOSITION_LABELS[a.ledger_disposition] : null;
              const settlement = settlementText(a);
              return (
                <tr key={a.id} className="border-b border-gray-100 align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{a.activity_date}</td>
                  <td className="py-1 pr-2">
                    <span className="font-medium">{outcome.label}</span>
                    {a.description_raw && <span className="block text-xs text-muted">{a.description_raw}</span>}
                  </td>
                  <td className="py-1 pr-2 text-right whitespace-nowrap">{money(a.amount, a.currency_code)}</td>
                  <td className="py-1">
                    {disposition ?? (a.ledger ? outcome.counts : statement.ledger_status === 'not_applied' ? 'Not recorded yet' : outcome.counts)}
                    {a.ledger && a.ledger.allocations.length > 0 && (
                      <ul className="mt-1 text-xs text-muted">
                        {a.ledger.allocations.map((al, i) => (
                          <li key={i}>{ALLOCATION_LABELS[al.economic_transaction_type] ?? al.economic_transaction_type}: {money(al.amount, a.currency_code)}</li>
                        ))}
                      </ul>
                    )}
                    {settlement && a.ledger && <span className="block text-xs text-muted">{settlement}</span>}
                  </td>
                </tr>
              );
            })}
            {statement.activities.length === 0 && (
              <tr><td colSpan={4} className="py-2 text-muted">No lines were read from this statement.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LiabilityStatementHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [options, setOptions] = useState<LiabilityOption[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [statements, setStatements] = useState<HistoryStatementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** A statement whose recording is waiting for the user to accept that its
   * unrecognised lines are not counted. */
  const [ackFor, setAckFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/liabilities')
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json) => {
        if (cancelled) return;
        const rows = ((json.data ?? []) as LiabilityOption[]).filter((l) => l.source_type === 'liability_statement_import');
        setOptions(rows);
        setSelected((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? ''));
      })
      .catch(() => { if (!cancelled) setOptions([]); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const load = useCallback(async (id: string) => {
    setError(null);
    setStatements(null);
    const res = await fetch(`/api/liabilities/${encodeURIComponent(id)}/statements`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setError(json.error ?? 'Statement history is unavailable right now.'); return; }
    setStatements((json.data?.statements ?? []) as HistoryStatementRow[]);
  }, []);

  useEffect(() => { if (selected) void load(selected); }, [selected, load, refreshKey]);

  async function record(statementId: string, acknowledge = false) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/liabilities/${encodeURIComponent(selected)}/statements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement_id: statementId, acknowledge_unclassified: acknowledge }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const blockers = (json.blockers ?? []) as { reason: string }[];
        const reasons = blockers.map((b) => BLOCKER_LABELS[b.reason] ?? b.reason);
        setNotice([json.error ?? 'This statement could not be recorded.', ...new Set(reasons)].join(' '));
        setAckFor(blockers.length > 0 && blockers.every((b) => b.reason === 'unclassified_line') ? statementId : null);
        return;
      }
      setAckFor(null);
      setNotice(`Recorded ${json.data?.ledger?.transactionsCreated ?? 0} line(s) from this statement.`);
      await load(selected);
    } finally {
      setBusy(false);
    }
  }

  if (options === null) return null;
  if (options.length === 0) return null;

  return (
    <section aria-labelledby="liability-statement-history" className="space-y-3 rounded border border-gray-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="liability-statement-history" className="text-lg font-semibold text-trust">Statement history</h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Liability</span>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
            {options.map((o) => <option key={o.id} value={o.id}>{o.liability_name}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted">Imported from credit card and loan statements. Each line shows how it counts in your figures.</p>
      {notice && <p className="rounded bg-amber-50 px-3 py-2 text-sm" role="status">{notice}</p>}
      {error && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
      {statements !== null && statements.length === 0 && <p className="text-sm text-muted">No statements have been imported for this liability yet.</p>}
      {statements?.map((s) => (
        <details key={s.id} className="rounded border border-gray-100 p-3" open={statements.length === 1}>
          <summary className="cursor-pointer text-sm font-medium">
            {s.institution_name ?? 'Statement'} {s.masked_identifier ? `(${s.masked_identifier})` : ''} —{' '}
            {s.statement_period_start && s.statement_period_end ? `${s.statement_period_start} to ${s.statement_period_end}` : 'period not shown'}
            {' · '}{s.activities.length} line(s)
          </summary>
          <div className="mt-2 space-y-2">
            {s.can_record && (
              <div className="rounded bg-blue-50 px-3 py-2 text-sm">
                <p>This statement was applied before its lines were recorded in your figures.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={busy} onClick={() => void record(s.id)} className="rounded bg-trust px-3 py-1 text-white disabled:opacity-50">
                    Record this statement&apos;s activity
                  </button>
                  {ackFor === s.id && (
                    <button type="button" disabled={busy} onClick={() => void record(s.id, true)} className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50">
                      Record it, leaving the unrecognised lines uncounted
                    </button>
                  )}
                </div>
              </div>
            )}
            <StatementHistoryTable statement={s} />
            {s.ledger_status === 'applied' && (
              <a className="text-xs underline" href={fdhPages.activityTransactions()}>See these lines in Financial Activity</a>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}
