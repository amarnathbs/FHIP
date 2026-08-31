'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { investmentGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';
import { AuInvestmentStatementImportPanel } from '@/components/investments/AuInvestmentStatementImportPanel';

// FDH-11 spec sections 2, 76-83: the Investments hub offers three entry
// points — Add Investment Manually (the existing grid below, unchanged and
// fully first-class per spec section 82), Import Australian Investment
// Statement (FDH-11, new), and India Investments (the existing Investment
// Intelligence module — reused, not rebuilt, per spec section 4/76's "the
// India option must go to the existing India Investment capability").
// FDH-11 is deliberately NOT a new top-level destination, mirroring the
// exact pattern FDH-9/FDH-10 established for Income/Liabilities.
export default function InvestmentsPage() {
  const [showAuImport, setShowAuImport] = useState(false);
  const [gridKey, setGridKey] = useState(0);
  const auImportToggleRef = useRef<HTMLButtonElement>(null);

  function closeAuImport() {
    setShowAuImport(false);
    auImportToggleRef.current?.focus();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Investments</h1>
        <p className="mt-1 text-sm text-muted">Add investments manually, import an Australian broker statement, or view your India investments.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            ref={auImportToggleRef}
            type="button"
            onClick={() => setShowAuImport((v) => !v)}
            aria-expanded={showAuImport}
            className="rounded border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5"
          >
            Import Australian Investment Statement
          </button>
          <Link
            href="/investment-intelligence"
            className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-trust hover:bg-gray-50"
          >
            India Investments
          </Link>
        </div>
      </div>

      {showAuImport && (
        <AuInvestmentStatementImportPanel onClose={closeAuImport} onApplied={() => setGridKey((k) => k + 1)} />
      )}

      <hr className="border-gray-200" />

      <FinancialDataGrid key={gridKey} config={investmentGridConfig} subNav={<InvestmentsSubNav />} />
    </div>
  );
}
