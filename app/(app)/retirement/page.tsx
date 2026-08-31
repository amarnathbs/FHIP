'use client';

import { useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { retirementGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';
import { RetirementPlanningSection } from '@/components/retirement/RetirementPlanningSection';
import { SmsfSection } from '@/components/retirement/smsf/SmsfSection';
import { RetirementStatementImportPanel } from '@/components/retirement/RetirementStatementImportPanel';

// Hierarchy per spec s.34: "Retirement Planning" (target ages) ->
// "Retirement Accounts" (the grid below, industry/retail super etc.) with
// SMSF surfaced as its own dedicated section in between — not a second,
// unrelated app area, and not just another spreadsheet row (SMSF is
// excluded from the grid itself; see retirementGridConfig.
// excludeMasterItemKeys).
//
// FDH-12 (spec section 146) adds the statement-import route to the same page,
// so the user's choice is the one the brief describes:
//
//   Input Data -> Retirement -> [ Add/Update Manually ] OR [ Import Statement ]
//
// "Add/Update Manually" is the EXISTING grid and planning section, unchanged —
// FDH-12 removes no affordance. The import panel sits directly above the grid
// so both routes to the same data are visible together, and BELOW the SMSF
// section so the SMSF boundary reads correctly: a self-managed fund is managed
// there, and an SMSF statement uploaded here is routed back to it rather than
// imported as ordinary super (spec sections 10-11).
export default function RetirementPage() {
  // Applying a statement changes canonical retirement rows, so the grid is
  // remounted to pick them up — the same refresh contract the Investments page
  // uses for FDH-11.
  const [gridKey, setGridKey] = useState(0);

  return (
    <FinancialDataGrid
      key={gridKey}
      config={retirementGridConfig}
      subNav={<InvestmentsSubNav />}
      beforeGrid={
        <>
          <RetirementPlanningSection />
          <SmsfSection />
          <RetirementStatementImportPanel onApplied={() => setGridKey((k) => k + 1)} />
        </>
      }
    />
  );
}
