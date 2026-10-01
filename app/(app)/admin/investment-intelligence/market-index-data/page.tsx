import { requireMarketIndexAdminPage } from '@/lib/services/investment-intelligence/marketIndex/marketIndexAdmin';
import MarketIndexDataClient from '@/components/admin/MarketIndexDataClient';

// Market Index Data — historical Nifty 50 / BSE Sensex upload (price index
// close) and daily-feed status.
//
// Admin Architecture Standard section 4 layer 3: the page-layer guard runs
// BEFORE any render, and a caller without the named capability
// (can_upload_market_index_data) is redirected rather than shown an empty
// screen. Layers 1, 2 and 4 are migration 0232's predicate/RPC/RLS, the API
// route's requireMarketIndexAdmin(), and lib/admin/adminNav.ts.
export default async function MarketIndexDataPage() {
  await requireMarketIndexAdminPage();
  return <MarketIndexDataClient />;
}
