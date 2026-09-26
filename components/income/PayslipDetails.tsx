'use client';

/**
 * WP-09 (GAP-07) -- Payslip details: every figure the payslip carries, grouped
 * as this pay period / paid by your employer / year to date / the payslip's
 * own lines, each with what FHIP does with it ("Used in your income entry",
 * "Evidence only — not added to your income", ...). The words come from the
 * field-disposition registry via lib/income/payslipDetails.ts.
 *
 * Pure rendering: the caller passes the payroll event and its component lines
 * exactly as the API sends them (snake_case). Reached from the payslip review
 * step (PayslipImportPanel) and from an imported Income row
 * (ImportedIncomeActuals -> GET /api/income/{id}/payslip).
 */
import { formatMoneyExact } from '@/lib/engines/money';
import { buildPayslipDetails } from '@/lib/income/payslipDetails';

function show(value: string | number | null, kind: 'money' | 'text' | 'date', currency: string): string {
  if (value === null) return 'Not shown on payslip';
  // Sanctioned exact formatting: the figure as printed on the payslip.
  if (kind === 'money') return formatMoneyExact(Number(value), currency);
  return String(value);
}

const SIDE_LABEL: Record<string, string> = {
  earning: 'Earning',
  deduction: 'Deduction',
  employer_contribution: 'Employer contribution',
  informational: 'For information',
};

export function PayslipDetails({
  event,
  components,
  heading = 'Everything on this payslip',
}: {
  event: Record<string, unknown>;
  components?: readonly Record<string, unknown>[];
  heading?: string;
}) {
  const details = buildPayslipDetails(event, components ?? []);
  return (
    <section className="space-y-4" aria-label={heading}>
      <h4 className="text-sm font-semibold">{heading}</h4>
      {details.groups.map((g) => (
        <div key={g.id} className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="py-1 text-left text-xs font-medium text-muted">{g.title}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Figure</th>
                <th scope="col">Amount</th>
                <th scope="col">What FHIP does with it</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.column} className="border-b border-gray-100" data-column={r.column}>
                  <th scope="row" className="py-1 pr-2 text-left font-normal text-muted">{r.label}</th>
                  <td className="py-1 pr-2">
                    {show(r.value, r.kind, details.currency)}
                    {r.corrected && <span className="ml-1 text-xs text-muted">(you corrected this)</span>}
                  </td>
                  <td className="py-1 text-xs text-muted">{r.value === null ? '—' : r.dispositionLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {details.components.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="py-1 text-left text-xs font-medium text-muted">The lines printed on your payslip (evidence only)</caption>
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-muted">
                <th scope="col" className="py-1 pr-2 font-normal">Line</th>
                <th scope="col" className="py-1 pr-2 font-normal">Type</th>
                <th scope="col" className="py-1 font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {details.components.map((c, i) => (
                <tr key={`${c.label}-${i}`} className="border-b border-gray-100">
                  <td className="py-1 pr-2">{c.label}</td>
                  <td className="py-1 pr-2 text-xs text-muted">
                    {SIDE_LABEL[c.side] ?? c.side}
                    {c.isYearToDate ? ' · year to date' : ''}
                  </td>
                  <td className="py-1">{formatMoneyExact(c.amount, details.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
