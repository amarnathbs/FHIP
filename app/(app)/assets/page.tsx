'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { assetGridConfig } from '@/lib/grid/configs';

export default function AssetsPage() {
  return <FinancialDataGrid config={assetGridConfig} />;
}
