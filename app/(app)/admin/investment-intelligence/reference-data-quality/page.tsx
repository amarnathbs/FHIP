import { requireReferenceDataAdminPage } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';
import ReferenceDataQualityClient from '@/components/admin/ReferenceDataQualityClient';

// PC6/N.11 — the reference-market-data quality surface.
//
// Admin Architecture Standard §4 layer 3: the page-layer guard runs BEFORE any
// render, and a caller without the capability is redirected rather than shown
// an empty dashboard. Layers 1, 2 and 4 are migration 0155's RLS predicate,
// the API route's requireReferenceDataAdmin(), and lib/admin/adminNav.ts.
export default async function ReferenceDataQualityPage() {
  await requireReferenceDataAdminPage();
  return <ReferenceDataQualityClient />;
}
