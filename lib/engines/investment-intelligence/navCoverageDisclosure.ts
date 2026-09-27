// NAV 1 — PO decision #5.6 (2026-09-27): "Add disclosure of unrecoverable
// periods wherever performance/XIRR/rolling-returns are computed and
// rendered for an affected scheme."
//
// DELIBERATELY NOT built inside analyticsOrchestrator.ts's runAnalytics().
// That function is a certified, pure engine (PC4/R4/R11 have all
// independently verified it); this is a purely ADDITIVE, informational
// disclosure that has nothing to do with how a metric is calculated — the
// scheme's XIRR/TWR/rolling-return figures are computed exactly as before,
// from whatever NAV rows currently exist (ii_nav_source_coverage_gaps,
// migration 0219, only ever records a gap ALREADY confirmed unrecoverable
// FROM SOURCE if ever deleted — it says nothing about today's stored data
// being missing). So this is applied as a post-processing enrichment step
// in the API route, after runAnalytics() has already produced a real
// result, using the SAME `annotations: DataQualityAnnotation[]` field the
// engine already exposes per scheme and per portfolio for every other kind
// of data-quality disclosure — the existing UI (PerformanceClient.tsx's
// <AnnotationList items={s.annotations} />) renders it with zero UI changes
// needed.
//
// This function is PURE: given the analytics result and a map of
// instrument -> open coverage gaps (fetched by the caller), it returns a
// NEW result object with the extra annotations appended. It never mutates
// its input, and never touches investorXirr/navReturns/activeReturn or any
// other computed value.

import type { AnalyticsResultSet } from './analyticsOrchestrator';
import type { DataQualityAnnotation, DataQualityFlag } from './dataQuality';

/** New flag, additive to the existing spec-section-66 vocabulary — see dataQuality.ts for why this is a separate flag from NAV_HISTORY_INCOMPLETE. */
export const UNRECOVERABLE_HISTORY_FLAG: DataQualityFlag = 'UNRECOVERABLE_HISTORY_PERIOD';

export interface CoverageGapSummary {
  gapFrom: string;
  gapTo: string;
  reasonCode: string;
}

function describeGap(instrumentName: string, gap: CoverageGapSummary): string {
  const reason =
    gap.reasonCode === 'fund_house_transition'
      ? 'a change in the scheme\'s sponsoring fund house means the earlier records are not served by the standard data sources'
      : 'the earlier records are not served by any approved data source';
  return (
    `NAV history for ${instrumentName} from ${gap.gapFrom} to ${gap.gapTo} is stored and used in this calculation, but has been confirmed ` +
    `unrecoverable from AMFI or TIGZIG if it were ever lost — ${reason}. This does not affect the figures shown today; it means this period ` +
    `could not be restored or independently re-verified if it were ever deleted or corrupted.`
  );
}

/**
 * Returns a NEW AnalyticsResultSet with an UNRECOVERABLE_HISTORY_PERIOD
 * annotation appended to every scheme (and, if any of its schemes are
 * affected, every portfolio currency block) that has at least one open
 * coverage gap. Schemes/portfolios with no gap are returned unchanged
 * (same object reference) so this is cheap to call on every request.
 */
export function attachUnrecoverableHistoryDisclosure(
  results: AnalyticsResultSet,
  gapsByInstrumentId: Record<string, CoverageGapSummary[]>
): AnalyticsResultSet {
  const affectedIds = Object.keys(gapsByInstrumentId).filter((id) => gapsByInstrumentId[id]?.length > 0);
  if (affectedIds.length === 0) return results;

  const affectedCurrencies = new Set<string>();

  const schemes = results.schemes.map((scheme) => {
    const gaps = gapsByInstrumentId[scheme.instrumentId];
    if (!gaps || gaps.length === 0) return scheme;
    affectedCurrencies.add(scheme.currencyCode);
    const newAnnotations: DataQualityAnnotation[] = gaps.map((gap) => ({
      flag: UNRECOVERABLE_HISTORY_FLAG,
      detail: describeGap(scheme.instrumentName, gap),
    }));
    return { ...scheme, annotations: [...scheme.annotations, ...newAnnotations] };
  });

  const portfolios =
    affectedCurrencies.size === 0
      ? results.portfolios
      : results.portfolios.map((p) => {
          if (!affectedCurrencies.has(p.currencyCode)) return p;
          const count = affectedIds.filter((id) => schemes.some((s) => s.instrumentId === id && s.currencyCode === p.currencyCode)).length;
          return {
            ...p,
            annotations: [
              ...p.annotations,
              {
                flag: UNRECOVERABLE_HISTORY_FLAG,
                detail: `${count} holding(s) in this currency include NAV history confirmed unrecoverable if it were ever lost. See each affected scheme's detail for the exact date range.`,
              },
            ],
          };
        });

  return { ...results, schemes, portfolios };
}
