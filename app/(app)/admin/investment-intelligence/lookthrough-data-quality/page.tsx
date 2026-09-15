import { requireLookthroughDataAdminPage } from '@/lib/services/investment-intelligence/pc7/lookthroughDataAdmin';
import LookthroughDataQualityClient from '@/components/admin/LookthroughDataQualityClient';

// PC7/O.9 — the Underlying Fund Holdings quality surface.
//
// Admin Architecture Standard §4 layer 3: the page-layer guard runs BEFORE any
// render, and a caller without the capability is redirected rather than shown
// an empty dashboard. Layers 1, 2 and 4 are migration 0157's
// is_pc7_lookthrough_data_admin() RLS predicate, the API route's
// requireLookthroughDataAdmin(), and lib/admin/adminNav.ts.
export default async function LookthroughDataQualityPage() {
  await requireLookthroughDataAdminPage();
  return <LookthroughDataQualityClient />;
}
