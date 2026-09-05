'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { incomeGridConfig } from '@/lib/grid/configs';
import { PayslipImportPanel } from '@/components/income/PayslipImportPanel';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';

// Income tab layout (FDH-9 spec section 22): a header offering the two entry
// points into Income — manual entry (the existing grid below, unchanged and
// fully first-class per spec section 23) and "Import from Payslip" — above
// the existing Income Sources experience. FDH-9 is deliberately NOT a new
// top-level destination (spec section 3): everything payslip-related is
// reached from here.
export default function IncomePage() {
  const [showImport, setShowImport] = useState(false);
  const [gridKey, setGridKey] = useState(0);
  // G4 closure item 2: Payslip import creates income rows the same way the
  // grid's own "Add" flow does, so it needs the identical write-availability
  // gate — the grid guards its own internal controls, but this button lives
  // outside the grid component entirely.
  const { available: writeAvailable, resolved: writeResolved } = useModuleWriteAvailability('INCOME');
  const importDisabled = writeResolved && !writeAvailable;

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
            disabled={importDisabled}
            title={importDisabled ? "Importing isn't available for your country yet" : undefined}
            className="rounded border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
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

      <FinancialDataGrid key={gridKey} config={incomeGridConfig} moduleKey="INCOME" />
    </div>
  );
}
