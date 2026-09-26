'use client';

/**
 * Investments tab -- imported broker statements (canonical-upload WP-12,
 * INV-G9 / INV-G1, PO D-05 / D-11).
 *
 * Two things the user could not see before:
 *  1. "Imported, not yet in Net Worth": holdings applied from a statement but
 *     not yet added to Net Worth. The figure comes from the canonical
 *     Investments read model (the same selector Net Worth uses), so it can
 *     never disagree with what is or is not counted. Each statement with such
 *     holdings offers "Add to Net Worth", which opens the import panel's
 *     explicit confirm step.
 *  2. Import history: every AU statement with its dates, what was added, what
 *     was kept as evidence only and WHY, rows that could not be read, and the
 *     broker-cash line (shown, never counted).
 *
 * Talks to one API route; renders nothing at all for a user with no imports.
 */

import { useEffect, useState } from 'react';

interface ImportedStatement {
  statementId: string;
  documentId: string | null;
  institutionName: string | null;
  statementType: string;
  statementDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  importedAt: string;
  approvalStatus: string;
  reconciliationStatus: string;
  cashBalance: number | null;
  closingPortfolioValue: number | null;
  warnings: { code: string; count: number; rowsDropped: boolean }[];
  counts: { holdings: number; transactions: number; applied: number; skipped: number; waiting: number };
  skipped: { line: string; reason: string }[];
  holdings: { name: string; asOfDate: string | null; value: number | null; currencyCode: string; applyStatus: string; inNetWorth: boolean }[];
}

interface UnpublishedBucket {
  label: string;
  count: number;
  total: number;
  reporting_currency: string;
  holdings: { name: string; as_of_date: string; value: number; currency_code: string }[];
}

const money = (v: number | null | undefined, currency = 'AUD') =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(v);

const STATEMENT_TYPE_LABEL: Record<string, string> = {
  investment_transaction_csv: 'Transaction history',
  portfolio_csv: 'Portfolio / holdings',
};

export function ImportedInvestmentStatements({ refreshKey, onAddToNetWorth }: { refreshKey?: number; onAddToNetWorth: (documentId: string) => void }) {
  const [statements, setStatements] = useState<ImportedStatement[] | null>(null);
  const [unpublished, setUnpublished] = useState<UnpublishedBucket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/investments/imported-statements')
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? 'Imported statements could not be loaded.');
          return;
        }
        setStatements((json.data?.statements as ImportedStatement[]) ?? []);
        setUnpublished((json.data?.unpublished as UnpublishedBucket | null) ?? null);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError('Imported statements could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) return <p className="text-sm text-muted">{error}</p>;
  if (!statements || (statements.length === 0 && (!unpublished || unpublished.count === 0))) return null;

  const withUnpublished = statements.filter((s) => s.documentId && s.holdings.some((h) => h.applyStatus === 'applied' && !h.inNetWorth));

  return (
    <section aria-labelledby="imported-statements-heading" className="space-y-3 rounded border border-gray-200 p-4">
      <h2 id="imported-statements-heading" className="text-base font-semibold text-trust">
        Imported statements
      </h2>

      {unpublished && unpublished.count > 0 && (
        <div className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          <p className="font-medium">
            {unpublished.label}: {unpublished.count} holding{unpublished.count === 1 ? '' : 's'}, {money(unpublished.total, unpublished.reporting_currency)}
          </p>
          <p>These were imported from a statement but are not counted in your Investments total or Net Worth until you add them.</p>
          <ul className="mt-1 list-disc pl-5">
            {unpublished.holdings.slice(0, 10).map((h, i) => (
              <li key={`${h.name}-${i}`}>
                {h.name} — {money(h.value, h.currency_code)} as at {h.as_of_date}
              </li>
            ))}
          </ul>
          {withUnpublished.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {withUnpublished.map((s) => (
                <button key={s.statementId} type="button" onClick={() => onAddToNetWorth(s.documentId as string)} className="rounded bg-trust px-3 py-1 text-xs font-medium text-white">
                  Add to Net Worth — {s.institutionName ?? 'statement'} {s.statementDate ?? s.periodEnd ?? ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-sm text-trust underline">
        {open ? 'Hide' : 'Show'} import history ({statements.length})
      </button>

      {open && (
        <ul className="space-y-3 text-sm">
          {statements.map((s) => {
            const dropped = s.warnings.filter((w) => w.rowsDropped).reduce((n, w) => n + w.count, 0);
            return (
              <li key={s.statementId} className="rounded border border-gray-100 p-3">
                <p className="font-medium">
                  {s.institutionName ?? 'Broker statement'} — {STATEMENT_TYPE_LABEL[s.statementType] ?? s.statementType}
                </p>
                <p className="text-muted">
                  Imported from a broker statement on {s.importedAt.slice(0, 10)}
                  {s.statementDate ? ` · statement date ${s.statementDate}` : ''}
                  {s.periodStart || s.periodEnd ? ` · period ${s.periodStart ?? '?'} to ${s.periodEnd ?? '?'}` : ''}
                </p>
                <p>
                  {s.approvalStatus === 'approved' ? 'Approved' : 'Awaiting your review'} · {s.counts.holdings} holding(s), {s.counts.transactions} transaction(s) · {s.counts.applied} added,{' '}
                  {s.counts.skipped} kept as evidence only{s.counts.waiting > 0 ? `, ${s.counts.waiting} waiting` : ''}
                </p>
                {dropped > 0 && <p className="text-amber-900">{dropped} row(s) could not be read and were not saved.</p>}
                {s.cashBalance !== null && (
                  <p className="text-muted">Broker cash {money(s.cashBalance)} — shown only; broker cash isn&apos;t tracked in your Investments or Net Worth yet.</p>
                )}
                {s.holdings.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {s.holdings.map((h, i) => (
                      <li key={`${h.name}-${i}`}>
                        {h.name} — {money(h.value, h.currencyCode)}
                        {h.asOfDate ? ` as at ${h.asOfDate}` : ''} ·{' '}
                        {h.applyStatus !== 'applied' ? (h.applyStatus === 'skipped' ? 'not added' : 'not yet applied') : h.inNetWorth ? 'in your Net Worth' : 'imported, not yet in Net Worth'}
                      </li>
                    ))}
                  </ul>
                )}
                {s.skipped.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-muted">Why {s.skipped.length} line(s) were kept as evidence only</summary>
                    <ul className="mt-1 list-disc pl-5 text-xs">
                      {s.skipped.map((k, i) => (
                        <li key={`${k.line}-${i}`}>
                          {k.line}: {k.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
