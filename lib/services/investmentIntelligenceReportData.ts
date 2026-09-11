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
import type { ResidencyProfileInput } from '@/lib/engines/investment-intelligence/tax/residency';
import type { TaxpayerType } from '@/lib/engines/investment-intelligence/tax/taxProfile';
import { listReviewItems } from '@/lib/services/investment-intelligence/reviewCentreData';
import type { IiReviewItem } from '@/lib/services/investment-intelligence/types';
import { createClient } from '@/lib/supabase/server';

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

// G6 Contract 9 (docs/country-programme/g6-data-contracts.md) — a
// self-declared 'resident' taxpayerType (RESIDENT_INDIVIDUAL/RESIDENT_HUF)
// is no longer trusted blindly for the tax-report's residency check. If the
// household's own country_of_residence disagrees (present and not 'IN'),
// this falls through to checkResidency()'s existing countryOfTaxResidence
// fallback (lib/engines/investment-intelligence/tax/residency.ts) instead
// of forcing residencyStatus: 'resident' — that fallback already flags NRI
// rules with an honest, country-specific note. Missing/unresolved residence
// data never overrides the self-declaration (consistent with this
// programme's "never assume on missing data" rule elsewhere, e.g.
// isDomesticRecord() in lib/services/jurisdiction.ts) — only a POSITIVE,
// confirmed mismatch does. taxProfile.taxpayerType itself is untouched:
// this only widens when the NRI disclaimer is shown, never overrides the
// user's own declared taxpayer type.
export function resolveResidencyProfileForTaxReport(
  taxpayerType: TaxpayerType | null | undefined,
  countryOfResidence: string | null
): ResidencyProfileInput {
  if (taxpayerType === 'NON_RESIDENT_INDIVIDUAL') return { residencyStatus: 'nri' };
  const declaredResident = taxpayerType === 'RESIDENT_INDIVIDUAL' || taxpayerType === 'RESIDENT_HUF';
  if (!declaredResident) return {};
  if (countryOfResidence && countryOfResidence !== 'IN') return { countryOfTaxResidence: countryOfResidence };
  return { residencyStatus: 'resident' };
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
    // G6 Contract 9 (docs/country-programme/g6-data-contracts.md) — see
    // resolveResidencyProfileForTaxReport()'s own doc comment below.
    const { data: residenceProfile } = await supabase
      .from('user_profiles')
      .select('country_of_residence')
      .eq('user_id', userId)
      .maybeSingle<{ country_of_residence: string | null }>();
    const residencyProfile = resolveResidencyProfileForTaxReport(
      taxProfile.taxpayerType,
      residenceProfile?.country_of_residence ?? null
    );
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
    // II-R10 fix (risk-based closure session, NC7 pagination proof): this
    // used to report `totalOpenCount: items.length`, which is the SIZE OF
    // THE CAPPED DISPLAY LIST (max 50), not the true number of open review
    // items — a household with, say, 1,200 real open items would have its
    // report narrative say "50 open review items", silently understating
    // the true count by over 1,150. Live-reproduced this session
    // (scripts/r10_nc7_pagination.mjs, 1,200 real ii_review_items rows).
    // A real exact count query (same table/filter listReviewItems() itself
    // reads, matching the existing count=exact pattern already used
    // elsewhere in this codebase — see benchmarkGovernance.ts,
    // financialTwinService.ts) gives the true total independent of the
    // display cap; the displayed item LIST itself is unchanged (still
    // capped at 50 for readability — a report chapter listing 1,200 items
    // would not be useful reading regardless of correctness).
    const supabase = await createClient();
    const { count } = await supabase.from('ii_review_items').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'open');
    return { openItems: items, totalOpenCount: count ?? items.length };
  } catch {
    return null;
  }
}
