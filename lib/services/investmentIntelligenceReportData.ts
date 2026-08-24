// II-R10 continuation — report-side loaders for the five Investment
// Intelligence chapters (Performance/R4, SIP/R5, X-Ray/R5, Tax & Cost/R6,
// Review Centre/R9).
//
// GOVERNING RULE (spec sections 4, 21, 24, 26, 32, 37, 120): R10 must not
// recalculate any authoritative II figure. Each function below calls the
// EXACT SAME dataset-loader + orchestrator pair that module's own live
// page/API route calls (verified during discovery — see
// app/api/investment-intelligence/analytics/route.ts,
// app/api/investment-intelligence/sip/route.ts,
// app/api/investment-intelligence/xray/route.ts,
// app/api/investment-intelligence/tax/summary/route.ts,
// app/api/investment-intelligence/review/route.ts). No new formula, no new
// aggregation logic is written here — this file only selects the same
// canonical inputs and calls the same canonical function every other
// consumer already calls, then returns the raw result plus safe provenance
// fields. Read-only throughout: none of these loaders persist anything
// (persistence for R4/R5/R6 belongs to those modules' own recalculate/GET
// paths, not to R10).
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics, type AnalyticsResultSet } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { loadSipDataset, loadXrayDataset, attachAttributableInflows } from '@/lib/services/investment-intelligence/r5Repository';
import { runSipAnalytics, type SipAnalyticsResult } from '@/lib/engines/investment-intelligence/sip/sipOrchestrator';
import { runXrayAnalytics, type XrayResult } from '@/lib/engines/investment-intelligence/xray/xrayOrchestrator';
import { loadTaxDataset, loadTaxProfile, toTaxProfileInput } from '@/lib/services/investment-intelligence/taxRepository';
import { runTaxSimulation, type TaxSimulationOutput } from '@/lib/engines/investment-intelligence/tax/taxOrchestrator';
import { listReviewItems } from '@/lib/services/investment-intelligence/reviewCentreData';
import type { IiReviewItem } from '@/lib/services/investment-intelligence/types';

export interface ReportPerformanceData {
  results: AnalyticsResultSet;
  warnings: { scope: string; detail: string }[];
}

export async function loadInvestmentPerformanceForReport(
  userId: string,
  supabase: SupabaseServerClient
): Promise<ReportPerformanceData | null> {
  try {
    const { dataset, warnings, empty } = await loadAnalyticsDataset(supabase, userId, {});
    if (empty || !dataset) return null;
    const results = runAnalytics(dataset);
    return { results, warnings };
  } catch {
    // Matches every II GET route's own error handling (spec section 39):
    // a failure surfaces as "not available", never as a fabricated or
    // partial result.
    return null;
  }
}

export interface ReportSipData {
  results: SipAnalyticsResult;
  warnings: { scope: string; detail: string }[];
}

export async function loadSipForReport(userId: string, supabase: SupabaseServerClient): Promise<ReportSipData | null> {
  try {
    const { dataset, warnings, empty } = await loadSipDataset(supabase, userId, {});
    if (empty || !dataset) return null;
    // Mirrors app/api/investment-intelligence/sip/route.ts's exact two-pass
    // sequence: detection must run once before inflows can be attributed to
    // concrete series, then analytics run again with inflows attached.
    const preliminary = runSipAnalytics(dataset);
    attachAttributableInflows(dataset, preliminary.analytics.map((a) => a.series.seriesKey));
    const results = runSipAnalytics(dataset);
    if (results.seriesCount === 0) return null;
    return { results, warnings };
  } catch {
    return null;
  }
}

export interface ReportXrayData {
  results: XrayResult;
  warnings: { scope: string; detail: string }[];
}

export async function loadXrayForReport(userId: string, supabase: SupabaseServerClient): Promise<ReportXrayData | null> {
  try {
    const { dataset, warnings, empty } = await loadXrayDataset(supabase, userId, {});
    if (empty || !dataset) return null;
    const results = runXrayAnalytics(dataset, { topN: 10 });
    return { results, warnings };
  } catch {
    return null;
  }
}

export interface ReportTaxData {
  results: TaxSimulationOutput;
  asOfDate: string;
  taxProfileSource: 'persisted_profile' | 'none';
}

export async function loadTaxForReport(userId: string, supabase: SupabaseServerClient): Promise<ReportTaxData | null> {
  try {
    const { dataset, empty } = await loadTaxDataset(supabase, userId, {});
    if (empty || !dataset) return null;
    const disposals = [...dataset.disposalsByInstrument.values()].flat();
    // Matches the tax/summary route's own gate — capital gains only exist
    // once something has actually been disposed.
    if (disposals.length === 0) return null;
    const acquisitions = [...dataset.acquisitionsByInstrument.values()].flat();
    const { profile: persistedProfile } = await loadTaxProfile(supabase, userId);
    const taxProfile = toTaxProfileInput(persistedProfile);
    const residencyProfile =
      taxProfile.taxpayerType === 'NON_RESIDENT_INDIVIDUAL'
        ? ({ residencyStatus: 'nri' as const })
        : taxProfile.taxpayerType === 'RESIDENT_INDIVIDUAL' || taxProfile.taxpayerType === 'RESIDENT_HUF'
          ? ({ residencyStatus: 'resident' as const })
          : {};
    const results = runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: dataset.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset.exitLoadSchedules,
      residencyProfile,
      taxProfile,
    });
    return { results, asOfDate: dataset.asOfDate, taxProfileSource: persistedProfile ? 'persisted_profile' : 'none' };
  } catch {
    return null;
  }
}

export interface ReportReviewData {
  openItems: IiReviewItem[];
  totalOpenCount: number;
}

// R9 Review Centre is genuinely persisted-and-read-back (unlike R4/R5/R6,
// which recompute live) — see reviewCentreData.ts. R10 must consume it via
// listReviewItems() only, never runReviewCentreRefresh() (spec section 32:
// "Do not rerun R9 review rules"). Already paginated with a stable
// created_at desc, id desc tie-breaker (spec section 104/107) — reused
// as-is, not reimplemented.
export async function loadReviewItemsForReport(userId: string): Promise<ReportReviewData | null> {
  try {
    const { items } = await listReviewItems(userId, { status: 'open', limit: 50 });
    if (items.length === 0) return null;
    return { openItems: items, totalOpenCount: items.length };
  } catch {
    return null;
  }
}
