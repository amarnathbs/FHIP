'use client';

import { PageBackLink } from '@/components/navigation/PageBackLink';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { investmentGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';
import { AuInvestmentStatementImportPanel } from '@/components/investments/AuInvestmentStatementImportPanel';
import { ImportedInvestmentStatements } from '@/components/investments/ImportedInvestmentStatements';
import { PublishedFundValuations } from '@/components/investments/PublishedFundValuations';
import { useFinancialImportAccess } from '@/lib/entitlements/useFinancialImportAccess';
import { ImportLockedLink } from '@/components/entitlements/ImportLockedLink';

// FDH-11 spec sections 2, 76-83: the Investments hub offers three entry
// points — Add Investment Manually (the existing grid below, unchanged and
// fully first-class per spec section 82), Import Australian Investment
// Statement (FDH-11, new), and India Investments (the existing Investment
// Intelligence module — reused, not rebuilt, per spec section 4/76's "the
// India option must go to the existing India Investment capability").
// FDH-11 is deliberately NOT a new top-level destination, mirroring the
// exact pattern FDH-9/FDH-10 established for Income/Liabilities.
//
// Canonical-upload WP-12 (INV-G1/INV-G9, PO D-05): imported broker
// statements are now visible here -- the "Imported, not yet in Net Worth"
// bucket and the import history -- and "Add to Net Worth" reopens the import
// panel at its explicit confirm step for that statement.
function InvestmentsPageContent() {
  const [showAuImport, setShowAuImport] = useState(false);
  const [resumeDocumentId, setResumeDocumentId] = useState<string | null>(null);
  const [gridKey, setGridKey] = useState(0);
  const auImportToggleRef = useRef<HTMLButtonElement>(null);

  // Premium Upload Entitlement (14-10-2026): presentation only (the server re-checks every upload). Manual entry is untouched.
  const { access: importAccess } = useFinancialImportAccess();

  function closeAuImport() {
    setShowAuImport(false);
    setResumeDocumentId(null);
    setGridKey((k) => k + 1);
    auImportToggleRef.current?.focus();
  }

  // Document2 (4) F16 (20-10-2026) — PAGE ORDER. The PO: the tabs and the status/declaration controls belong at the top and the long
  // imported-statement content below. The order is: tabs (Investments | Retirement), title, the import / India actions, an Australian
  // import form when opened, the status / declaration controls ("I don't have any investments", "I've added everything relevant to me")
  // and "+ Add an item", the saved investments and totals, and only then the long imported-statement content (the "Imported, not yet
  // in Net Worth" list, the import history and the published fund valuations). The grid renders the tabs, the single title and the
  // controls; the long content is passed to its afterGrid slot.
  return (
    <FinancialDataGrid
      key={gridKey}
      config={investmentGridConfig}
      subNav={<InvestmentsSubNav />}
      moduleKey="INVESTMENTS"
      beforeGrid={
        <>
          <div className="flex flex-wrap items-center gap-3">
            {importAccess?.state === 'premium_required' ? (
              <ImportLockedLink domain="investments" label="Import Australian Investment Statement" />
            ) : (
              <button
                ref={auImportToggleRef}
                type="button"
                onClick={() => {
                  setResumeDocumentId(null);
                  setShowAuImport((v) => !v);
                }}
                aria-expanded={showAuImport}
                className="rounded border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5"
              >
                Import Australian Investment Statement
              </button>
            )}
            <Link
              href="/investment-intelligence"
              className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-trust hover:bg-gray-50"
            >
              India Investments
            </Link>
          </div>
          {showAuImport && (
            <AuInvestmentStatementImportPanel
              key={resumeDocumentId ?? 'new'}
              onClose={closeAuImport}
              onApplied={() => setGridKey((k) => k + 1)}
              resumeDocumentId={resumeDocumentId}
            />
          )}
        </>
      }
      afterGrid={
        <>
          <hr className="border-gray-200" />
          <ImportedInvestmentStatements
            refreshKey={gridKey}
            onAddToNetWorth={(documentId) => {
              setResumeDocumentId(documentId);
              setShowAuImport(true);
            }}
          />
          <PublishedFundValuations refreshKey={gridKey} />
        </>
      }
    />
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function InvestmentsPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <InvestmentsPageContent />
    </>
  );
}
