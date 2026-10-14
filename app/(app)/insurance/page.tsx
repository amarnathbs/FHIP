'use client';

import { PageBackLink } from '@/components/navigation/PageBackLink';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { insuranceGridConfig } from '@/lib/grid/configs';

function InsurancePageContent() {
  return <FinancialDataGrid config={insuranceGridConfig} moduleKey="INSURANCE" />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function InsurancePage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <InsurancePageContent />
    </>
  );
}
