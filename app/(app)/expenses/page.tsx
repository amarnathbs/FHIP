'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { expenseGridConfig } from '@/lib/grid/configs';
import { BankStatementImportPanel } from '@/components/expenses/BankStatementImportPanel';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';

// LR-3 (2026-09-08): Expenses tab layout, mirroring the Income page's
// existing "Import from Payslip" pattern (app/(app)/income/page.tsx) — a
// header offering the two entry points into Expenses (manual entry via the
// existing grid below, unchanged, and "Import bank statement") above the
// existing Expense Items experience. Approved/uploaded transactions do not
// land back in this grid directly; they flow into Monthly Surplus/Net Worth
// via dashboard.ts reading approved fdh_transactions (see
// lib/engines/dashboard.ts's LR-3 section) once reviewed and approved at
// /financial-data-hub/review.
export default function ExpensesPage() {
  const [showImport, setShowImport] = useState(false);
  // G4 closure item 2: the same write-availability gate the grid's own
  // internal controls use — this button lives outside the grid component.
  const { available: writeAvailable, resolved: writeResolved } = useModuleWriteAvailability('EXPENSES');
  const importDisabled = writeResolved && !writeAvailable;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Expenses</h1>
        <p className="mt-1 text-sm text-muted">Manage your household expenses.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            aria-expanded={showImport}
            disabled={importDisabled}
            title={importDisabled ? "Importing isn't available for your country yet" : undefined}
            className="rounded border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Import bank statement
          </button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Upload a bank or credit card statement (PDF or CSV) and FHIP will extract your transactions for you to review
          and approve before they count toward your Monthly Surplus.
        </p>
      </div>

      {showImport && <BankStatementImportPanel onClose={() => setShowImport(false)} />}

      <hr className="border-gray-200" />

      <FinancialDataGrid config={expenseGridConfig} moduleKey="EXPENSES" />
    </div>
  );
}
