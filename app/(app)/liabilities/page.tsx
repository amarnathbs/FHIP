'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { liabilityGridConfig } from '@/lib/grid/configs';

export default function LiabilitiesPage() {
  return <FinancialDataGrid config={liabilityGridConfig} />;
}
