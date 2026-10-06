import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireReferenceDataAdminPage } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';
import ReferenceDataQualityClient from '@/components/admin/ReferenceDataQualityClient';

// PC6/N.11 — the reference-market-data quality surface.
//
// Admin Architecture Standard §4 layer 3: the page-layer guard runs BEFORE any
// render, and a caller without the capability is redirected rather than shown
// an empty dashboard. Layers 1, 2 and 4 are migration 0155's RLS predicate,
// the API route's requireReferenceDataAdmin(), and lib/admin/adminNav.ts.
async function ReferenceDataQualityPageContent() {
  await requireReferenceDataAdminPage();
  return <ReferenceDataQualityClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function ReferenceDataQualityPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <ReferenceDataQualityPageContent />
    </>
  );
}
