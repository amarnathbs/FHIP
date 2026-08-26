'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { liabilityGridConfig } from '@/lib/grid/configs';
import { LiabilityImportPanel } from '@/components/liabilities/LiabilityImportPanel';

// Liabilities tab layout (FDH-10 spec section 2): a header offering the two
// entry points into Liabilities — manual entry (the existing grid below,
// unchanged and fully first-class per spec section 27's "the import option
// supplements manual entry, never replaces it") and "Import Statement" —
// above the existing Liabilities grid. FDH-10 is deliberately NOT a new
// top-level destination (spec section 2): everything statement-related is
// reached from here, mirroring the exact pattern FDH-9 established for
// Income (see app/(app)/income/page.tsx).
export default function LiabilitiesPage() {
  const [showImport, setShowImport] = useState(false);
  const [gridKey, setGridKey] = useState(0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Liabilities</h1>
        <p className="mt-1 text-sm text-muted">Manage your household&apos;s debts and liabilities.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            aria-expanded={showImport}
            className="rounded border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5"
          >
            Import Statement
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Upload a credit card or loan statement and FHIP will extract the details for you to review before updating your
          Liabilities information.
        </p>
      </div>

      {showImport && (
        <LiabilityImportPanel
          onClose={() => setShowImport(false)}
          onApplied={() => setGridKey((k) => k + 1)}
        />
      )}

      <hr className="border-gray-200" />

      <FinancialDataGrid key={gridKey} config={liabilityGridConfig} />
    </div>
  );
}
