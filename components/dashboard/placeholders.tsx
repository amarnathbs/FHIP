import Link from 'next/link';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';

export function FutureModulesSection() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Link href="/financial-twin" className="block rounded-card border bg-white p-4 hover:border-trust">
        <p className="font-medium text-trust">Financial Twin™</p>
        <p className="mt-1 text-sm text-gray-500">
          Compare your savings rate, net worth, debt and retirement balance against a similar peer profile and an indicative healthy
          planning range.
        </p>
      </Link>
      <LockedFeatureCard
        title="AI Financial Insights"
        description="Automatically generated observations, warnings, and opportunities based on your data. Arrives with Module 10 (AI Coach)."
      />
      <LockedFeatureCard
        title="Action Centre"
        description="Prioritised, ranked recommendations with estimated benefit and one-click actions. Arrives with Module 10 (AI Coach)."
      />
      <LockedFeatureCard
        title="Full Household Forecast"
        description="1/3/5/10-year household-wide projections across net worth, cash flow, investments and debt, with adjustable assumptions. Individual goals already have their own forecasts on the Financial Goals page — this is the broader household-level view, arriving with a future forecasting update."
      />
      <Link href="/reports" className="block rounded-card border bg-white p-4 hover:border-trust">
        <p className="font-medium text-trust">Reports</p>
        <p className="mt-1 text-sm text-gray-500">
          Generate a monthly financial-health report, print it, or view your report history. PDF/CSV export and read-only sharing
          require a premium plan.
        </p>
      </Link>
      <LockedFeatureCard
        title="Personalisation"
        description="Reorder widgets, pin favourites, hide sections, and switch between monthly/quarterly/annual or household/individual views. Arrives with Module 11 (Settings)."
      />
    </div>
  );
}
