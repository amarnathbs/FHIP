'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { investmentGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';

export default function InvestmentsPage() {
  return (
    <div>
      <InvestmentsSubNav />
      <FinancialDataGrid config={investmentGridConfig} />
    </div>
  );
}
