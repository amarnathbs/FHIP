'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { BankBalanceProposal } from '@/components/assets/BankBalanceProposal';
import { assetGridConfig } from '@/lib/grid/configs';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';

export default function AssetsPage() {
  // WP-15 (PO D-04): an approved bank statement's closing balance is offered
  // above the grid; after the user adds it, the grid re-reads so the new (or
  // updated) cash asset appears with its "Imported from bank statement" badge.
  const [refreshKey, setRefreshKey] = useState(0);
  const { available, resolved } = useModuleWriteAvailability('ASSETS');
  return (
    <FinancialDataGrid
      key={`assets-${refreshKey}`}
      config={assetGridConfig}
      moduleKey="ASSETS"
      beforeGrid={<BankBalanceProposal disabled={resolved && !available} onApplied={() => setRefreshKey((k) => k + 1)} />}
    />
  );
}
