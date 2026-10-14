'use client';

import { PageBackLink } from '@/components/navigation/PageBackLink';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { BankBalanceProposal } from '@/components/assets/BankBalanceProposal';
import { assetGridConfig } from '@/lib/grid/configs';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';

function AssetsPageContent() {
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

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function AssetsPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <AssetsPageContent />
    </>
  );
}
