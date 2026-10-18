import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { ResilienceComponentResult } from '@/lib/engines/resilience';
import { essentialHomeLoanNote } from '@/lib/engines/essentialHousing';

export function EmergencyFundDetail({
  component,
  currency,
}: {
  component: ResilienceComponentResult | undefined;
  currency: 'AUD' | 'INR';
}) {
  if (!component || component.treatment !== 'scored') return null;
  const v = component.currentValue as {
    accessibleResources?: number;
    committed90d?: number;
    essentialMonths?: number;
    coreSurvivalMonths?: number | null;
    essentialHomeLoanMonthly?: number;
  };
  // PO rule 17-10-2026: say what the months are measured against when essentials include the home loan repayment.
  const homeLoanNote =
    (v.essentialHomeLoanMonthly ?? 0) > 0
      ? essentialHomeLoanNote({ status: 'counted', monthly: v.essentialHomeLoanMonthly ?? 0, lines: [], rentMonthly: 0, recognisedLoanCount: 1, loansWithoutRepayment: 0 }, currency)
      : null;
  return (
    <SectionCard
      title="Emergency Fund Detail"
      description="Accessible resources exclude cash already committed to known upcoming outflows."
      explain={{ targetCode: 'RESILIENCE_EMERGENCY_FUND', accessibleLabel: 'Explain your emergency fund coverage' }}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Accessible cash" value={formatMoney(v.accessibleResources ?? 0, currency)} />
        <Stat label="Committed (90 days)" value={formatMoney(v.committed90d ?? 0, currency)} />
        <Stat label="Essential-expense coverage" value={`${(v.essentialMonths ?? 0).toFixed(1)} months`} />
        <Stat
          label="Core-survival coverage"
          value={v.coreSurvivalMonths !== null && v.coreSurvivalMonths !== undefined ? `${v.coreSurvivalMonths.toFixed(1)} months` : '—'}
        />
      </div>
      {homeLoanNote && (
        <p className="mt-3 text-xs text-muted" role="note" data-testid="resilience-essential-home-loan-note">
          {homeLoanNote}
        </p>
      )}
    </SectionCard>
  );
}
