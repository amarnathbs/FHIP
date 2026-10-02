import { requireBenchmarkPage } from '@/lib/services/investment-intelligence/benchmarkData/guards';
import BenchmarkDataClient from '@/components/admin/BenchmarkDataClient';

// Benchmark Data (BENCH-1 Phase 2) - the ONE benchmark upload / catalogue / entitlement / mapping /
// ingestion surface. The URL is unchanged from the earlier Market Index Data page so existing links
// and navigation keep working.
//
// Admin Architecture Standard section 4 layer 3: the page-layer guard runs BEFORE any render; a caller
// holding none of the benchmark-data capabilities is redirected, never shown an empty screen. Layers 1,
// 2 and 4 are migration 0239's predicates/RPCs/RLS, requireBenchmarkCapability() in every route, and
// lib/admin/adminNav.ts.
export default async function BenchmarkDataPage() {
  await requireBenchmarkPage('view');
  return <BenchmarkDataClient />;
}
