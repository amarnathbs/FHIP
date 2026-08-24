'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { retirementGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';
import { RetirementPlanningSection } from '@/components/retirement/RetirementPlanningSection';

export default function RetirementPage() {
  return (
    <FinancialDataGrid
      config={retirementGridConfig}
      subNav={<InvestmentsSubNav />}
      beforeGrid={<RetirementPlanningSection />}
    />
  );
}
