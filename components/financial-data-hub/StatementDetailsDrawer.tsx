'use client';

/**
 * WP-08 (EXP-G14, D-04): the statement details drawer. Shows what an imported
 * bank statement says -- period, account, reconciliation, opening and closing
 * balance (the closing balance labelled as not in Net Worth until the user
 * adds it as a cash asset, D-04), data-quality checks, the lines that could
 * not be read with their reasons, statement notes, and every line's posting
 * date, value date, bank reference and running balance.
 *
 * Renders EXACTLY the snake_case payload of
 * GET /api/financial-data-hub/documents/{id}/statement-details (type-only
 * import below; the route contract is pinned by
 * tests/unit/fdhBankApprovalIntegrity.test.ts).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import type { StatementDetails } from '@/lib/financial-data-hub/services/statementDetailsService';

function money(amount: number | null, currency: string | null): string {
  if (amount === null) return 'Not shown on the statement';
  return currency ? `${formatMoneyExact(amount, currency)} ${currency}` : String(amount);
}

const OWNER_LABEL: Record<string, string> = { self: 'You', spouse: 'Your partner', joint: 'Joint', smsf: 'Your SMSF' };

const RECON_LABEL: Record<string, string> = {
  reconciled: 'Adds up to the closing balance',
  failed: 'Does not add up to the closing balance',
  not_available: 'No balances to check against',
  pending: 'Not checked yet',
  user_accepted_exception: 'Accepted by you as an exception',
};

export function StatementDetailsDrawer({ statementId, buttonLabel = 'Statement details' }: { statementId: string; buttonLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [details, setDetails] = useState<StatementDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/financial-data-hub/documents/${encodeURIComponent(statementId)}/statement-details?page=${p}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? 'We could not load this statement.');
      setDetails(json.data as StatementDetails);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'We could not load this statement.');
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  // Loading is driven by the user's own actions (open, next / previous),
  // never by an effect, so no state is set during render or effect bodies.
  function openDrawer() {
    setOpen(true);
    setPage(1);
    void load(1);
  }
  function goTo(p: number) {
    setPage(p);
    void load(p);
  }

  useEffect(() => {
    if (open) requestAnimationFrame(() => panelRef.current?.focus());
  }, [open]);

  if (!open) {
    return (
      <button type="button" onClick={() => openDrawer()} className="rounded-compact border border-line px-3 py-1.5 text-sm font-semibold text-trust">
        {buttonLabel}
      </button>
    );
  }

  const d = details;
  const cur = d?.statement.currency ?? null;
  const pages = d ? Math.max(1, Math.ceil(d.lines.total / d.lines.page_size)) : 1;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-labelledby={headingId}
      className="space-y-4 rounded-compact border border-line bg-white p-4"
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-base font-semibold text-ink">Statement details</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-muted underline">Close statement details</button>
      </div>
      {loading && <p role="status" className="text-sm text-muted">Loading…</p>}
      {error && <p role="alert" className="text-sm text-risk">{error}</p>}
      {d && (
        <>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">File</dt><dd className="text-ink">{d.statement.file_name ?? 'Not recorded'}</dd></div>
            <div><dt className="text-muted">Period</dt><dd className="text-ink">{d.statement.period_start && d.statement.period_end ? `${d.statement.period_start} to ${d.statement.period_end}` : 'Not shown on the statement'}</dd></div>
            <div>
              <dt className="text-muted">Account</dt>
              <dd className="text-ink">
                {d.statement.account ? `${d.statement.account.display_name ?? 'Account'}${d.statement.account.masked_identifier ? ` (${d.statement.account.masked_identifier})` : ''}` : 'Not attached to an account'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Whose account</dt>
              <dd className="text-ink">{d.statement.account?.owner_role ? OWNER_LABEL[d.statement.account.owner_role] ?? d.statement.account.owner_role : 'Not recorded (counted as the household’s)'}</dd>
            </div>
            <div><dt className="text-muted">Opening balance</dt><dd className="text-ink tabular-nums">{money(d.reconciliation.opening_balance, d.reconciliation.currency ?? cur)}</dd></div>
            <div><dt className="text-muted">{d.closing_balance_label}</dt><dd className="text-ink tabular-nums">{money(d.reconciliation.closing_balance, d.reconciliation.currency ?? cur)}</dd></div>
            <div><dt className="text-muted">Balance check</dt><dd className="text-ink">{RECON_LABEL[d.reconciliation.status] ?? d.reconciliation.status}</dd></div>
            <div><dt className="text-muted">Approved by you</dt><dd className="text-ink">{d.statement.approved ? 'Yes' : 'Not yet'}</dd></div>
          </dl>

          {d.unread_lines_text && <p className="rounded-compact bg-attention/10 px-3 py-2 text-sm text-ink">{d.unread_lines_text}</p>}

          {d.notes.length > 0 && (
            <ul className="space-y-1 text-sm">
              {d.notes.map((note) => (
                <li key={note.id} className={note.severity === 'blocking' ? 'text-risk' : 'text-ink'}>{note.text}</li>
              ))}
            </ul>
          )}

          {d.quality.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-ink">Checks</h3>
              <ul className="mt-1 space-y-1 text-sm text-ink">
                {d.quality.map((q) => (
                  <li key={q.check_code}>{q.status === 'pass' ? 'OK: ' : q.status === 'not_applicable' ? 'Not checked: ' : 'Check: '}{q.text}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-ink">Lines ({d.lines.total})</h3>
            <div className="mt-2 max-h-96 overflow-auto rounded-compact border border-line">
              <table className="w-full text-xs">
                <caption className="sr-only">Every line read from this statement, with the dates, reference and running balance the statement prints</caption>
                <thead className="sticky top-0 bg-gray-50 text-left">
                  <tr>
                    <th scope="col" className="px-2 py-1">Date</th>
                    <th scope="col" className="px-2 py-1">Posted</th>
                    <th scope="col" className="px-2 py-1">Value date</th>
                    <th scope="col" className="px-2 py-1">Description</th>
                    <th scope="col" className="px-2 py-1">Reference</th>
                    <th scope="col" className="px-2 py-1 text-right">Amount</th>
                    <th scope="col" className="px-2 py-1 text-right">Balance after</th>
                    <th scope="col" className="px-2 py-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.rows.map((row) => (
                    <tr key={row.id} className="border-t border-line/60">
                      <td className="px-2 py-1 whitespace-nowrap">{row.transaction_date}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{row.posting_date ?? '—'}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{row.value_date ?? '—'}</td>
                      <td className="px-2 py-1">{row.description ?? '—'}</td>
                      <td className="px-2 py-1">{row.reference ?? '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{row.credit_debit === 'credit' ? '+' : '−'}{formatMoneyExact(row.amount, row.currency)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{row.balance_after === null ? '—' : formatMoneyExact(row.balance_after, row.currency)}</td>
                      <td className="px-2 py-1">
                        {row.dedup_status === 'user_confirmed_duplicate' || row.dedup_status === 'duplicate_confirmed'
                          ? 'Removed as a duplicate'
                          : row.approval_status === 'approved' ? 'Approved' : 'Waiting'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="mt-2 flex items-center gap-3 text-sm">
                <button type="button" disabled={page <= 1 || loading} onClick={() => goTo(Math.max(1, page - 1))} className="rounded-compact border border-line px-2 py-1 disabled:opacity-50">Previous lines</button>
                <span className="text-muted">Page {page} of {pages}</span>
                <button type="button" disabled={page >= pages || loading} onClick={() => goTo(page + 1)} className="rounded-compact border border-line px-2 py-1 disabled:opacity-50">Next lines</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
