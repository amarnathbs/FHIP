'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { incomeGridConfig } from '@/lib/grid/configs';
import { PayslipImportPanel } from '@/components/income/PayslipImportPanel';

// Income tab layout (FDH-9 spec section 22): a header offering the two entry
// points into Income — manual entry (the existing grid below, unchanged and
// fully first-class per spec section 23) and "Import from Payslip" — above
// the existing Income Sources experience. FDH-9 is deliberately NOT a new
// top-level destination (spec section 3): everything payslip-related is
// reached from here.
export default function IncomePage() {
  const [showImport, setShowImport] = useState(false);
  const [gridKey, setGridKey] = useState(0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Income</h1>
        <p className="mt-1 text-sm text-muted">Manage your household income sources.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            aria-expanded={showImport}
            className="rounded border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5"
          >
            Import from Payslip
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Upload a payslip and FHIP will extract your income details for you to review before updating your Income
          information.
        </p>
      </div>

      {showImport && (
        <PayslipImportPanel
          onClose={() => setShowImport(false)}
          onApplied={() => setGridKey((k) => k + 1)}
        />
      )}

      <hr className="border-gray-200" />

      <FinancialDataGrid key={gridKey} config={incomeGridConfig} />
    </div>
  );
}
