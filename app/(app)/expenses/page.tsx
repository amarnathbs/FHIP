'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { expenseGridConfig } from '@/lib/grid/configs';
import { BankStatementImportPanel } from '@/components/expenses/BankStatementImportPanel';
import { ImportedExpenseActuals } from '@/components/expenses/ImportedExpenseActuals';
import { PlannedFromActualProposal } from '@/components/expenses/PlannedFromActualProposal';
import { useModuleWriteAvailability } from '@/lib/nav/useModuleWriteAvailability';

// Expenses tab (LR-3 layout; WP-07/WP-15 planned-vs-actual model, PO D-02):
//  - the grid below is your PLANNED expenses (expense_items), entered by you
//    or updated by you from your actual averages;
//  - "Actual spending (imported)" under it shows the approved imported
//    transactions (e.g. Woolworths $200 Groceries) BESIDE the plan, read from
//    the canonical Expense read model (lib/read-models/expenses.ts). They are
//    never copied into the grid and never added to the plan;
//  - "Update your planned expenses from your actual spending" is the only way
//    an import changes the plan, and only for the items you tick and apply.
export default function ExpensesPage() {
  const [showImport, setShowImport] = useState(false);
  // Bumped after an Apply so the grid and the actuals re-read what changed.
  const [refreshKey, setRefreshKey] = useState(0);
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
          Upload a bank statement (PDF or CSV) and FHIP will extract your transactions for you to review and approve.
          Approved spending appears below as your actual spending, beside your planned expenses. For credit card or
          loan statements, use Import from the Liabilities tab.
        </p>
      </div>

      {showImport && <BankStatementImportPanel onClose={() => setShowImport(false)} />}

      <hr className="border-gray-200" />

      <FinancialDataGrid key={`grid-${refreshKey}`} config={expenseGridConfig} moduleKey="EXPENSES" />

      <PlannedFromActualProposal key={`proposal-${refreshKey}`} disabled={importDisabled} onApplied={() => setRefreshKey((k) => k + 1)} />

      <ImportedExpenseActuals refreshKey={refreshKey} />
    </div>
  );
}
