'use client';

/**
 * WP-09 (GAP-06 income section) -- "Actual income from bank statements" on
 * the Income tab, from the ONE canonical Income read model (selectIncome) via
 * GET /api/income/actuals.
 *
 *  - Every approved bank income credit once, with its "Imported from bank
 *    statement" label and a link to its statement. A credit that IS the pay
 *    of an Applied payslip is marked "Counted once with payslip" and never
 *    added again (GAP-01).
 *  - An unlinked credit that looks like one of the entries below carries a
 *    "possible duplicate of ..." prompt (PO D-07).
 *  - Bonus / overtime / commission from Applied payslips, as dated one-off
 *    income (PO D-06).
 *  - Income entries imported from a payslip, each with "View payslip" --
 *    every figure on that payslip and what FHIP does with it (GAP-07).
 * Read-only: nothing here writes to income_sources.
 */
import { useEffect, useState } from 'react';
import { formatMoneyWhole } from '@/lib/engines/money';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';
import type { IncomeActualsDto, IncomeActualsOk } from '@/lib/income/importedIncomeActuals';
import { PayslipDetails } from '@/components/income/PayslipDetails';

const money = (value: number, currency: string) => formatMoneyWhole(value, currency === 'INR' ? 'INR' : 'AUD');

export function ImportedIncomeActuals({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<IncomeActualsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/income/actuals')
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Request failed');
        if (!cancelled) {
          setError(null);
          setData(json.data as IncomeActualsDto);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load imported income');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) {
    return <section className="rounded-card border border-line bg-white p-4 text-sm text-risk">Imported income is unavailable right now ({error}). Your income entries below are unaffected.</section>;
  }
  if (!data) return <section className="rounded-card border border-line bg-white p-4 text-sm text-muted">Loading imported income…</section>;
  if (data.status === 'unavailable') {
    return (
      <section className="rounded-card border border-line bg-white p-4 text-sm text-caution" data-testid="income-actuals-unavailable">
        Imported income is unavailable right now — it is not zero. Your income entries below are unaffected.
      </section>
    );
  }
  return <IncomeActualsBody data={data} />;
}

/** The loaded view (exported for the render contract test). */
export function IncomeActualsBody({ data }: { data: IncomeActualsOk }) {
  const [openPayslip, setOpenPayslip] = useState<string | null>(null);
  const [payslip, setPayslip] = useState<{ payroll_event: Record<string, unknown>; components: Record<string, unknown>[] } | null>(null);
  const [payslipError, setPayslipError] = useState<string | null>(null);
  const cur = data.reportingCurrency;
  const imported = data.planned.lines.filter((l) => l.hasPayslipDetails);

  async function showPayslip(sourceId: string) {
    if (openPayslip === sourceId) {
      setOpenPayslip(null);
      return;
    }
    setOpenPayslip(sourceId);
    setPayslip(null);
    setPayslipError(null);
    try {
      const res = await fetch(`/api/income/${encodeURIComponent(sourceId)}/payslip`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load this payslip');
      setPayslip(json.data as { payroll_event: Record<string, unknown>; components: Record<string, unknown>[] });
    } catch (e) {
      setPayslipError(e instanceof Error ? e.message : 'Could not load this payslip');
    }
  }

  if (!data.actual.lines.length && !data.variablePay.lines.length && !imported.length) {
    return (
      <section className="rounded-card border border-line bg-white p-4 text-sm text-muted" data-testid="income-actuals-empty">
        No imported income yet. Approved bank statements and payslips you add will appear here, next to your income entries.
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-card border border-line bg-white p-4" aria-labelledby="income-actuals-heading" data-testid="income-actuals">
      <div>
        <h2 id="income-actuals-heading" className="text-lg font-semibold text-trust">Actual income from your imports</h2>
        <p className="mt-1 text-xs text-muted">
          {data.window.from} to {data.window.to}. Each payment is counted once: a bank deposit that is your payslip&apos;s pay is shown
          but not added again.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-muted">Income entries (monthly, gross)</dt><dd data-testid="income-planned-gross">{money(data.planned.grossMonthly, cur)}</dd></div>
        <div><dt className="text-xs text-muted">Other bank income (monthly)</dt><dd data-testid="income-actual-counted">{money(data.actual.countedMonthly, cur)}</dd></div>
        <div><dt className="text-xs text-muted">One-off pay (monthly)</dt><dd data-testid="income-variable">{money(data.variablePay.grossMonthly, cur)}</dd></div>
        <div>
          <dt className="text-xs text-muted">Household income (monthly, gross)</dt>
          <dd data-testid="income-combined-gross">{money(data.combined.grossMonthly, cur)}</dd>
          {data.combined.grossIncludesNetFloor && <dd className="text-xs text-muted">Includes bank deposits at their take-home amount (gross unknown)</dd>}
        </div>
      </dl>
      {data.combined.netMonthly === null && (
        <p className="text-xs text-muted" data-testid="income-net-unknown">Take-home pay is not known for every entry, so no net total is shown.</p>
      )}

      {data.actual.lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <caption className="py-1 text-left text-sm font-medium">Actual income from bank statements</caption>
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-muted">
                <th scope="col" className="py-1 pr-2 font-normal">Date</th>
                <th scope="col" className="py-1 pr-2 font-normal">Description</th>
                <th scope="col" className={`py-1 pr-2 font-normal ${NUM_HEADER_CLASS}`}>Amount</th>
                <th scope="col" className="py-1 font-normal">How it counts</th>
              </tr>
            </thead>
            <tbody>
              {data.actual.lines.map((l) => (
                <tr key={l.key} className="border-b border-gray-100" data-treatment={l.treatment}>
                  <td className="py-1 pr-2">{l.date}</td>
                  <td className="py-1 pr-2">
                    {l.description ?? 'Bank deposit'}
                    <span className="block text-xs text-muted">
                      {l.sourceLabel}
                      {l.statementHref && (
                        <>
                          {' · '}
                          <a className="underline" href={l.statementHref}>statement</a>
                        </>
                      )}
                    </span>
                  </td>
                  <td className={`py-1 pr-2 ${NUM_CELL_CLASS}`}>{money(l.amount, l.currency)}{l.amountReporting === null && <span className="block text-xs text-caution">not converted — not in totals</span>}</td>
                  <td className="py-1 text-xs">
                    {l.treatmentLabel}
                    {l.representedByName && <span className="block text-muted">Same money as “{l.representedByName}”</span>}
                    {l.possibleDuplicateOf.length > 0 && (
                      <span className="block text-caution">Possible duplicate of {l.possibleDuplicateOf.map((d) => `“${d.name}”`).join(', ')} — check it is not the same income</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.variablePay.lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="py-1 text-left text-sm font-medium">One-off pay from your payslips (bonus, overtime, commission)</caption>
            <tbody>
              {data.variablePay.lines.map((v) => (
                <tr key={v.payrollEventId} className="border-b border-gray-100">
                  <td className="py-1 pr-2">{v.date}</td>
                  <td className="py-1 pr-2">{v.employerName ?? v.sourceName ?? 'Payslip'}<span className="block text-xs text-muted">Imported from payslip · counted once, on its pay date</span></td>
                  <td className={`py-1 ${NUM_CELL_CLASS}`}>{money(v.grossNative, v.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {imported.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Income entries imported from a payslip</h3>
          <ul className="space-y-2">
            {imported.map((p) => (
              <li key={p.id} className="rounded border border-gray-200 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {p.name} · {money(p.grossNative, p.currency)} {p.frequency}
                    <span className="block text-xs text-muted">{p.sourceLabel}{p.owner === 'spouse' ? ' · your spouse' : ''}{p.excludedLabel ? ` · ${p.excludedLabel}` : ''}</span>
                  </span>
                  <button
                    type="button"
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                    aria-expanded={openPayslip === p.id}
                    onClick={() => showPayslip(p.id)}
                  >
                    {openPayslip === p.id ? 'Hide payslip' : 'View payslip'}
                  </button>
                </div>
                {openPayslip === p.id && (
                  <div className="mt-3">
                    {payslipError && <p className="text-xs text-risk">{payslipError}</p>}
                    {!payslipError && !payslip && <p className="text-xs text-muted">Loading payslip…</p>}
                    {payslip && <PayslipDetails event={payslip.payroll_event} components={payslip.components} heading="The payslip behind this entry" />}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
