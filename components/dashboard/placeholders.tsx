import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';

// Only genuinely not-yet-built features belong here. Financial Twin and
// Reports used to be listed too, but both have been live for a while and
// already have their own sidebar entries (Twin / Benchmark, Reports) —
// repeating them under "Coming up next" read as if they weren't done yet.
export function FutureModulesSection() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
      <LockedFeatureCard
        title="Personalisation"
        description="Reorder widgets, pin favourites, hide sections, and switch between monthly/quarterly/annual or household/individual views. Arrives with Module 11 (Settings)."
      />
    </div>
  );
}
