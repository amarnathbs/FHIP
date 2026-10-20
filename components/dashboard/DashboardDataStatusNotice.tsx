import { formatMoney } from '@/lib/engines/money';
import { fmtDate } from '@/components/investment-intelligence/dateDisplay';
import type { DashboardDataStatus } from '@/lib/engines/dashboard';
import { importedNotInNetWorthActions } from '@/lib/investment-intelligence/importedNotInNetWorthLinks';

const SECTION_LABELS: Record<string, string> = {
  income: 'income',
  expenses: 'expenses',
  liabilities: 'debt repayments',
  investments: 'investments',
  retirement: 'retirement accounts',
  assets: 'assets',
  balance_sheet: 'balances',
  history: 'monthly history',
  business_entities: 'business entities',
};

/**
 * WP-03 (DC-14): says what the Dashboard figures do NOT include, so an error,
 * an unconvertible currency or an imported-but-not-confirmed holding never
 * reads as a real $0. Renders nothing when there is nothing to disclose.
 */
export function DashboardDataStatusNotice({ status, currency }: { status: DashboardDataStatus | undefined; currency: 'AUD' | 'INR' }) {
  if (!status) return null;
  const notes: string[] = [];
  if (status.unavailable.length > 0) {
    const parts = [...new Set(status.unavailable.map((u) => SECTION_LABELS[u.section] ?? u.section))];
    notes.push(`Some of your data could not be loaded right now (${parts.join(', ')}). Figures that depend on it are shown as unavailable rather than as zero.`);
  }
  if (status.unconverted.count > 0) {
    const codes = Object.keys(status.unconverted.byCurrency).join(', ');
    notes.push(`${status.unconverted.count} amount${status.unconverted.count === 1 ? '' : 's'} in ${codes} cannot be converted to ${currency} and ${status.unconverted.count === 1 ? 'is' : 'are'} left out of these totals.`);
  }
  for (const f of status.netIncomeImplausible ?? []) {
    notes.push(
      f.kind === 'net_above_gross'
        ? `${f.name}: the take-home pay is higher than the gross. Check that both are entered for the same pay period (for example both per year, or both per fortnight).`
        : `${f.name}: the take-home pay is only ${(f.netToGross * 100).toFixed(0)}% of the gross, which tax alone does not explain. Check that gross and take-home are entered for the same pay period (for example both per year, or both per fortnight); otherwise net income and your monthly surplus are understated.`,
    );
  }
  if (status.retirementContributionFrequencyUnknown > 0) {
    notes.push('Some retirement contributions have no frequency recorded, so they are not counted as a monthly amount.');
  }
  const actionsByNote = new Map<string, { href: string; label: string }[]>();
  if (status.importedNotInNetWorth) {
    const text = `${status.importedNotInNetWorth.label}: ${status.importedNotInNetWorth.count} holding${status.importedNotInNetWorth.count === 1 ? '' : 's'} worth ${formatMoney(status.importedNotInNetWorth.total, currency)}.`;
    notes.push(text);
    // Document2 (4) WP-B (F13): a direct link to where it is resolved. The note clears by itself once the holdings are published
    // (it is recomputed from the live data on every load), so there is nothing to dismiss here.
    actionsByNote.set(text, importedNotInNetWorthActions(status.importedNotInNetWorth.where));
  }
  if (status.publishedValuation && status.publishedValuation.count > 0) {
    const v = status.publishedValuation;
    const priced = v.marketNavCount + v.statementCount;
    if (priced > 0) {
      const range = v.latestAsOf ? (v.oldestAsOf && v.oldestAsOf !== v.latestAsOf ? ` dated ${fmtDate(v.oldestAsOf, currency)} to ${fmtDate(v.latestAsOf, currency)}` : ` dated ${fmtDate(v.latestAsOf, currency)}`) : '';
      const parts = [`${v.marketNavCount} at the latest NAV${range}`];
      if (v.statementCount > 0) parts.push(`${v.statementCount} at a statement value (no newer NAV on file)`);
      if (v.redeemedCount > 0) parts.push(`${v.redeemedCount} redeemed (counted as 0)`);
      notes.push(`Mutual funds in your Net Worth: ${parts.join(', ')}.${v.staleCount > 0 ? ` ${v.staleCount} ${v.staleCount === 1 ? 'is' : 'are'} valued on a NAV or statement more than a week old and may be out of date.` : ''}`);
    }
  }
  if (status.bankBalanceEvidence) {
    notes.push(`${status.bankBalanceEvidence.label}: ${formatMoney(status.bankBalanceEvidence.total, currency)}.`);
  }
  if (status.possibleDuplicateIncomeCount > 0) {
    notes.push(`${status.possibleDuplicateIncomeCount} imported income payment${status.possibleDuplicateIncomeCount === 1 ? ' looks' : 's look'} like income you already entered. Review ${status.possibleDuplicateIncomeCount === 1 ? 'it' : 'them'} so it is not counted twice.`);
  }
  if (status.costOfDebtMonthly > 0) {
    notes.push(`Cost of debt (interest and fees inside your card and loan repayments): ${formatMoney(status.costOfDebtMonthly, currency)} a month, already included in your debt repayments.`);
  }
  const assumed = status.netIncomeAssumed;
  const hasAssumed = Boolean(assumed && assumed.count > 0);
  if (notes.length === 0 && !hasAssumed) return null;
  return (
    <>
      {hasAssumed && assumed && (
        // PO decision 16-10-2026: a source with no take-home pay and no tax entered is calculated at its gross.
        // Highlighted, never buried in the muted list below.
        <section role="note" aria-label="Gross is being treated as take-home" data-testid="dashboard-net-assumed" className="rounded-card border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Gross is being treated as take-home: no tax has been deducted.</p>
          <p className="mt-1">
            {assumed.count} income source{assumed.count === 1 ? ' has' : 's have'} no take-home pay or tax entered, so {assumed.count === 1 ? 'its' : 'their'} gross is used instead:{' '}
            {assumed.sources.map((s) => `${s.name} (${formatMoney(s.grossMonthly, currency)} a month)`).join('; ')}.
            Your net income, monthly surplus or deficit, savings rate, debt-service ratio and the Cash Flow, Savings and Debt scores are calculated on that basis.
            Enter the take-home pay, or the tax, on the Income page to use your real figure.
          </p>
        </section>
      )}
      {notes.length > 0 && (
        <section aria-label="About these figures" className="rounded-card border border-line bg-white p-4 text-sm text-muted">
          <ul className="list-disc space-y-1 pl-5">
            {notes.map((n) => (
              <li key={n}>
                {n}
                {(actionsByNote.get(n) ?? []).map((a) => (
                  <a key={a.href} href={a.href} className="ml-2 font-medium text-primary hover:underline">
                    {a.label}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
