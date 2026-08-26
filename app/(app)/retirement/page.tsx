'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { retirementGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';
import { RetirementPlanningSection } from '@/components/retirement/RetirementPlanningSection';
import { SmsfSection } from '@/components/retirement/smsf/SmsfSection';

// Hierarchy per spec s.34: "Retirement Planning" (target ages) ->
// "Retirement Accounts" (the grid below, industry/retail super etc.) with
// SMSF surfaced as its own dedicated section in between — not a second,
// unrelated app area, and not just another spreadsheet row (SMSF is
// excluded from the grid itself; see retirementGridConfig.
// excludeMasterItemKeys).
export default function RetirementPage() {
  return (
    <FinancialDataGrid
      config={retirementGridConfig}
      subNav={<InvestmentsSubNav />}
      beforeGrid={
        <>
          <RetirementPlanningSection />
          <SmsfSection />
        </>
      }
    />
  );
}
