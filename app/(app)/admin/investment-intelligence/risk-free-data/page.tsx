import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireRiskFreePage } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import RiskFreeDataClient from '@/components/admin/RiskFreeDataClient';

// Risk-free Rate Data (NAV2) -- the RBI rates behind Sharpe / Sortino / alpha in the Fund analytics report.
//
// Admin Architecture Standard section 4 layer 3: the page-layer guard runs BEFORE any render; a caller holding
// neither risk-free capability is redirected, never shown an empty screen. Layers 1, 2 and 4 are migration 0260's
// predicates / RPCs / RLS, requireRiskFreeCapability() in every route, and lib/admin/adminNav.ts. Which sections the
// holder sees is decided by the API (each panel reports `not_permitted` for a capability the caller lacks).
async function RiskFreeDataPageContent() {
  await requireRiskFreePage('any');
  return <RiskFreeDataClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard: Admin tools have no Admin home).
export default function RiskFreeDataPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <RiskFreeDataPageContent />
    </>
  );
}
