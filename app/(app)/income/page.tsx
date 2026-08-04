'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { incomeGridConfig } from '@/lib/grid/configs';

export default function IncomePage() {
  return <FinancialDataGrid config={incomeGridConfig} />;
}
