'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { insuranceGridConfig } from '@/lib/grid/configs';

export default function InsurancePage() {
  return <FinancialDataGrid config={insuranceGridConfig} />;
}
