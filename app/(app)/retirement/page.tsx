'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { retirementGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';

export default function RetirementPage() {
  return (
    <div>
      <InvestmentsSubNav />
      <FinancialDataGrid config={retirementGridConfig} />
    </div>
  );
}
