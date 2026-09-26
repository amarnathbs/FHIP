import { formatMoney } from '@/lib/engines/money';
import type { DashboardDataStatus } from '@/lib/engines/dashboard';

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
  if (status.netIncomeUnknownComponents > 0) {
    notes.push('Take-home pay is unknown for part of your income, so that part is not counted as take-home pay.');
  }
  if (status.retirementContributionFrequencyUnknown > 0) {
    notes.push('Some retirement contributions have no frequency recorded, so they are not counted as a monthly amount.');
  }
  if (status.importedNotInNetWorth) {
    notes.push(`${status.importedNotInNetWorth.label}: ${status.importedNotInNetWorth.count} holding${status.importedNotInNetWorth.count === 1 ? '' : 's'} worth ${formatMoney(status.importedNotInNetWorth.total, currency)}.`);
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
  if (notes.length === 0) return null;
  return (
    <section aria-label="About these figures" className="rounded-card border border-line bg-white p-4 text-sm text-muted">
      <ul className="list-disc space-y-1 pl-5">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  );
}
