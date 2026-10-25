'use client';

import { PageBackLink } from '@/components/navigation/PageBackLink';

import { useEffect, useState } from 'react';
import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { retirementGridConfig } from '@/lib/grid/configs';
import { InvestmentsSubNav } from '@/components/investments/InvestmentsSubNav';
import { RetirementPlanningSection } from '@/components/retirement/RetirementPlanningSection';
import { RetirementContributionsPanel } from '@/components/retirement/RetirementContributionsPanel';
import { SmsfSection } from '@/components/retirement/smsf/SmsfSection';
import { EntityRegisterNotice } from '@/components/entities/EntityRegisterNotice';
import { RetirementStatementImportPanel } from '@/components/retirement/RetirementStatementImportPanel';
import { RetirementStatementHistory } from '@/components/retirement/RetirementStatementHistory';
import { useFinancialImportAccess } from '@/lib/entitlements/useFinancialImportAccess';
import { PremiumImportPill } from '@/components/entitlements/PremiumImportPill';

// Hierarchy per spec s.34: "Retirement Planning" (target ages) ->
// "Retirement Accounts" (the grid below, industry/retail super etc.) with
// SMSF surfaced as its own dedicated section — not a second, unrelated app
// area, and not just another spreadsheet row (SMSF is excluded from the grid
// itself; see retirementGridConfig.excludeMasterItemKeys).
//
// FDH-12 (spec section 146) adds the statement-import route to the same page:
//
//   Input Data -> Retirement -> [ Add/Update Manually ] OR [ Import Statement ]
//
// Document2 (4) F16/F17 (20-10-2026) — PAGE ORDER. The PO: "the user has to go down below to see the retirement option ... the status
// declaration controls should show above, the long imported-statement content below." The order is now:
//   1. tabs (Investments | Retirement), title, description;
//   2. the quick links: Update by hand below, Import statement, Imported statements;
//   3. the status / declaration controls ("I don't have any retirement savings", "I've added everything relevant to me") and "+ Add an item";
//   4. Retirement Planning (target ages) and Contributions (the separate contribution action and its history);
//   5. the saved retirement accounts and totals;
//   6. the SMSF section, then the long statement content: the import form and the imported-statement history.
// Items 3-5 are rendered by the shared grid (afterControls / afterGrid slots); nothing the page offered was removed.
//
// WP-13 (Approved Upload -> Canonical programme): the statement HISTORY stays under the import panel (GAP-RET-03): after Apply the
// statement's contributions, rollovers, earnings, fees, insurance, tax and holdings stay visible, and are never summed into Net Worth.
function RetirementPageContent() {
  // Applying a statement or recording a contribution changes canonical retirement rows, so the grid is remounted to pick them up —
  // the same refresh contract the Investments page uses for FDH-11. The history re-reads on the same key.
  const [gridKey, setGridKey] = useState(0);
  const [contributionsKey, setContributionsKey] = useState(0);
  // F17: the SMSF fund is not a row of this grid, so it is counted separately for the "I don't have any retirement savings" declaration.
  const [smsfFunds, setSmsfFunds] = useState(0);
  // Premium Upload Entitlement (14-10-2026): presentation only (the server re-checks every upload). Manual entry is untouched.
  const { access: importAccess } = useFinancialImportAccess();
  const importLocked = importAccess?.state === 'premium_required';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/smsf');
        const json = await res.json();
        if (!cancelled && res.ok && Array.isArray(json.data)) setSmsfFunds(json.data.filter((f: { is_active?: boolean }) => f.is_active !== false).length);
      } catch {
        /* the declaration then counts the grid's own rows only */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gridKey]);

  return (
    <FinancialDataGrid
      key={gridKey}
      config={retirementGridConfig}
      moduleKey="RETIREMENT"
      subNav={<InvestmentsSubNav />}
      extraActiveItems={smsfFunds}
      beforeGrid={
        <nav aria-label="Ways to update your retirement accounts" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Update your retirement accounts by hand below, or</span>
          <a
            href="#import-retirement-statement"
            className={importLocked ? 'inline-flex items-center gap-2 rounded border border-ai px-3 py-1 font-medium text-ai' : 'rounded bg-trust px-3 py-1 font-medium text-white'}
          >
            Import statement
            {importLocked && <PremiumImportPill />}
          </a>
          <a href="#imported-retirement-statements" className="rounded border border-gray-300 px-3 py-1">
            Imported statements
          </a>
        </nav>
      }
      afterControls={
        <>
          <RetirementPlanningSection />
          <EntityRegisterNotice page="retirement" />
          <div id="contributions">
            <RetirementContributionsPanel refreshKey={contributionsKey} onChanged={() => setGridKey((k) => k + 1)} />
          </div>
        </>
      }
      afterGrid={
        <>
          <SmsfSection />
          <RetirementStatementImportPanel
            onApplied={() => {
              setGridKey((k) => k + 1);
              setContributionsKey((k) => k + 1);
            }}
          />
          <RetirementStatementHistory refreshKey={gridKey} />
        </>
      }
    />
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Investments).
export default function RetirementPage() {
  return (
    <>
      <PageBackLink href="/investments" label="Investments" />
      <RetirementPageContent />
    </>
  );
}
