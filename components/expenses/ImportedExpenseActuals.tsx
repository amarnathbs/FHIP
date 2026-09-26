'use client';

/**
 * WP-07 -- "Actual (imported)" on the Expenses tab (EXP-G1 / DC-17, PO D-02,
 * D-03).
 *
 * Shows the approved imported spending (e.g. "Woolworths $200 Groceries")
 * BESIDE the planned expenses in the grid, never merged into them:
 *   - a Planned vs Actual table per canonical group, with the variance and
 *     which figure the household's combined view uses (never both);
 *   - every imported spending line once, with its "Imported from bank /
 *     credit card statement" label and a link to its statement;
 *   - the money that is NOT spending, named and never dropped (cash
 *     withdrawals, transfers, loan interest & fees inside a repayment ...).
 * Read-only. Nothing here writes to expense_items.
 */
import { useCallback, useEffect, useState } from 'react';
import { formatMoneyWhole } from '@/lib/engines/money';
import type { ImportedActualsDto, ImportedActualsOk } from '@/lib/expenses/importedActuals';

const money = (value: number, currency: string) => formatMoneyWhole(value, (currency === 'INR' ? 'INR' : 'AUD'));

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function ImportedExpenseActuals({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<ImportedActualsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState('');
  const [month, setMonth] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (group) params.set('group', group);
    if (month) params.set('month', month);
    try {
      const res = await fetch(`/api/expenses/actuals?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Request failed');
      setData(json.data as ImportedActualsDto);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load imported spending');
    }
  }, [page, group, month]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error) {
    return <section className="rounded-card border border-line bg-white p-4 text-sm text-risk">Imported spending is unavailable right now ({error}). Your planned expenses below are unaffected.</section>;
  }
  if (!data) return <section className="rounded-card border border-line bg-white p-4 text-sm text-muted">Loading imported spending…</section>;
  if (data.status === 'unavailable') {
    return (
      <section className="rounded-card border border-line bg-white p-4 text-sm text-caution" data-testid="imported-actuals-unavailable">
        Imported spending is unavailable right now — it is not zero. Your planned expenses below are unaffected.
      </section>
    );
  }
  return <ActualsBody data={data} page={page} setPage={setPage} group={group} setGroup={(g) => { setGroup(g); setPage(1); }} month={month} setMonth={(m) => { setMonth(m); setPage(1); }} />;
}

function ActualsBody({
  data, page, setPage, group, setGroup, month, setMonth,
}: {
  data: ImportedActualsOk;
  page: number;
  setPage: (p: number) => void;
  group: string;
  setGroup: (g: string) => void;
  month: string;
  setMonth: (m: string) => void;
}) {
  const cur = data.reportingCurrency;
  const windowText = `${monthLabel(data.window.months[0] ?? data.window.from.slice(0, 7))} – ${monthLabel(data.window.months[data.window.months.length - 1] ?? data.window.to.slice(0, 7))}`;
  const covered = data.window.coveredMonths.length;
  const nonZeroBuckets = data.nonSpending.filter((b) => b.count > 0);

  return (
    <section className="space-y-4 rounded-card border border-line bg-white p-4" aria-labelledby="imported-actuals-heading">
      <div>
        <h2 id="imported-actuals-heading" className="text-lg font-semibold text-ink">Actual spending (imported)</h2>
        <p className="mt-1 text-sm text-muted">
          From bank and credit card statements you approved, {windowText}.{' '}
          {covered > 0
            ? `Averaged over ${covered} fully covered month${covered === 1 ? '' : 's'}.`
            : 'No month in this period is fully covered by an approved statement yet, so nothing is averaged.'}{' '}
          Shown beside your planned expenses — never added to them.
        </p>
      </div>

      {!data.hasActual ? (
        <p className="text-sm text-muted" data-testid="imported-actuals-empty">
          No approved imported spending in this period. Import a bank statement above, review it and approve it to see your actual spending here.
        </p>
      ) : null}

      {data.groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="planned-vs-actual">
            <thead className="border-b bg-gray-50 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2 text-right">Planned / month</th>
                <th className="px-3 py-2 text-right">Actual / month</th>
                <th className="px-3 py-2 text-right">Difference</th>
                <th className="px-3 py-2">Used in your totals</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.group} className="border-b last:border-0">
                  <td className="px-3 py-2">{g.label}</td>
                  <td className="px-3 py-2 text-right">{g.plannedMonthly === null ? '—' : money(g.plannedMonthly, cur)}</td>
                  <td className="px-3 py-2 text-right">{g.actualMonthly === null ? '—' : money(g.actualMonthly, cur)}</td>
                  <td className={`px-3 py-2 text-right ${g.varianceMonthly !== null && g.varianceMonthly > 0 ? 'text-risk' : ''}`}>
                    {g.varianceMonthly === null ? '—' : `${g.varianceMonthly > 0 ? '+' : ''}${money(g.varianceMonthly, cur)}`}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{g.basis === 'actual' ? 'Actual' : g.basis === 'planned' ? 'Planned' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.hasActual && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <h3 className="text-sm font-semibold text-ink">Imported spending lines</h3>
            <label className="text-xs text-muted">
              Category{' '}
              <select value={group} onChange={(e) => setGroup(e.target.value)} className="ml-1 rounded border px-2 py-1 text-xs">
                <option value="">All</option>
                {data.lineGroups.map((g) => (
                  <option key={g.group} value={g.group}>{g.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              Month{' '}
              <select value={month} onChange={(e) => setMonth(e.target.value)} className="ml-1 rounded border px-2 py-1 text-xs">
                <option value="">All</option>
                {data.lineMonths.map((m) => (
                  <option key={m} value={m}>{monthLabel(m)}</option>
                ))}
              </select>
            </label>
            <span className="text-xs text-muted">{data.lineCount} line{data.lineCount === 1 ? '' : 's'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="imported-actual-lines">
              <thead className="border-b bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.key} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2">{l.date}</td>
                    <td className="px-3 py-2">
                      {l.description ?? '—'}
                      {l.coverage === 'partial' && <span className="ml-2 text-[11px] text-muted">(part month — shown, not averaged)</span>}
                    </td>
                    <td className="px-3 py-2">{l.categoryLabel ?? l.groupLabel}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {l.currency === cur || l.amountReporting === null ? `${l.currency} ${l.amount.toFixed(2)}` : `${money(l.amountReporting, cur)} (${l.currency} ${l.amount.toFixed(2)})`}
                      {l.amountReporting === null && <span className="block text-[11px] text-caution">not converted — left out of totals</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">{l.sourceLabel}</span>
                      {l.statementHref && (
                        <a href={l.statementHref} className="ml-2 text-[11px] text-trust underline">View statement</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pageCount > 1 && (
            <div className="flex items-center gap-3 text-xs">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-2 py-1 disabled:opacity-50">Previous</button>
              <span className="text-muted">Page {data.page} of {data.pageCount}</span>
              <button type="button" disabled={page >= data.pageCount} onClick={() => setPage(page + 1)} className="rounded border px-2 py-1 disabled:opacity-50">Next</button>
            </div>
          )}
        </div>
      )}

      {(nonZeroBuckets.length > 0 || data.refundsUnlinked.count > 0 || data.unknownPendingCount > 0 || data.unconverted.count > 0 || data.excludedDuplicates > 0) && (
        <div className="space-y-1 text-sm" data-testid="non-spending">
          <h3 className="text-sm font-semibold text-ink">Not counted as spending</h3>
          <ul className="space-y-1">
            {nonZeroBuckets.map((b) => (
              <li key={b.bucket} className="flex justify-between gap-3">
                <span>{b.label}</span>
                <span className="text-muted">{money(b.totalInWindow, cur)} · {b.count} item{b.count === 1 ? '' : 's'}</span>
              </li>
            ))}
            {data.refundsUnlinked.count > 0 && (
              <li className="flex justify-between gap-3">
                <span>Refunds not yet matched to a purchase — shown, not netted</span>
                <span className="text-muted">{money(data.refundsUnlinked.totalInWindow, cur)} · {data.refundsUnlinked.count}</span>
              </li>
            )}
            {data.unknownPendingCount > 0 && (
              <li className="text-caution">{data.unknownPendingCount} line{data.unknownPendingCount === 1 ? '' : 's'} still to review or categorise — not counted until you do</li>
            )}
            {data.excludedDuplicates > 0 && (
              <li className="text-muted">{data.excludedDuplicates} duplicate line{data.excludedDuplicates === 1 ? '' : 's'} excluded</li>
            )}
            {data.unconverted.count > 0 && (
              <li className="text-caution">
                {data.unconverted.count} line{data.unconverted.count === 1 ? '' : 's'} in {Object.keys(data.unconverted.byCurrency).join(', ')} could not be converted and are left out of totals
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
