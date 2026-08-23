import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadXrayDataset, persistR5Results } from '@/lib/services/investment-intelligence/r5Repository';
import { runXrayAnalytics, summariseXrayDataQuality } from '@/lib/engines/investment-intelligence/xray/xrayOrchestrator';
import { XRAY_ENGINE_VERSION } from '@/lib/engines/investment-intelligence/r5Versioning';
import { TOP_HOLDINGS_ALLOWED_N } from '@/lib/config/investment-intelligence/xrayThresholds';

// R5 — Portfolio X-Ray for the authenticated user.
//
// LOOK-THROUGH IS ATTRIBUTION, NOT ADDITIONAL WEALTH. This route is strictly
// read-only: it never writes to investments/assets/retirement_accounts/
// liabilities/income/expenses, never touches R3's publication lifecycle, and
// the exposures it returns always sum back to the portfolio's own value.
//
// PARAMETER-SPOOFING DEFENCE (spec sections 96-97): identity comes solely
// from `user.id`. `asOf` narrows the analysis date (and is capped server-side
// to real data), and `top` selects a display size from a fixed allow-list.
// The client can supply NO fund-holding weight, NAV, benchmark, or
// classification value — every authoritative input is resolved server-side.
//
// NO FABRICATED ANALYTICS: when coverage is zero the response carries
// `available: false` plus an explicit reason, and the analytic payloads are
// omitted entirely rather than returned as zeros. A UI rendering this
// response cannot draw an all-zero chart that looks like a real portfolio.

export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(request.url);
  const asOfRaw = url.searchParams.get('asOf');
  if (asOfRaw && !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
    return bad('Invalid date parameter: expected YYYY-MM-DD.');
  }
  const topRaw = url.searchParams.get('top');
  let topN: number = 10;
  if (topRaw !== null) {
    const parsed = Number(topRaw);
    if (!(TOP_HOLDINGS_ALLOWED_N as readonly number[]).includes(parsed)) {
      return bad(`Invalid top parameter: allowed values are ${TOP_HOLDINGS_ALLOWED_N.join(', ')}.`);
    }
    topN = parsed;
  }

  try {
    const supabase = await createClient();
    const { dataset, warnings, empty } = await loadXrayDataset(supabase, user.id, { asOfDate: asOfRaw ?? undefined });

    if (empty || !dataset) {
      return ok({
        empty: true,
        warnings,
        message: 'No mutual-fund or ETF positions are available yet, so a portfolio X-Ray cannot be produced.',
      });
    }

    const result = runXrayAnalytics(dataset, { topN });
    const dataQuality = summariseXrayDataQuality(result);
    const available = result.lookThrough.status === 'ok';

    if (available) {
      await persistR5Results(user.id, [
        {
          scopeType: 'portfolio',
          scopeId: user.id,
          metricKey: 'xray_lookthrough',
          metricVersion: result.subVersions.lookThrough,
          engineVersion: XRAY_ENGINE_VERSION,
          dataAsOfDate: result.asOfDate,
          portfolioAsOfDate: result.portfolioAsOfDate,
          holdingsAsOfDate: result.holdingsAsOfDate,
          holdingsSnapshotIds: result.snapshotIdsUsed,
          classificationVersion: result.classificationVersion,
          inputSnapshotVersion: result.inputSnapshotVersion,
          coverage: result.lookThrough.effectiveCoverage,
          qualityStatus: result.lookThrough.qualityStatuses.join(','),
          resultValue: {
            topHoldings: result.topHoldings.map((h) => ({ canonicalId: h.canonicalId, name: h.displayName, weight: h.effectiveWeight, schemeCount: h.schemeCount })),
            coverage: result.lookThrough.effectiveCoverage,
          },
        },
      ]);
    }

    return ok({
      empty: false,
      // The single most important field in this response: a consumer must
      // render the unavailable state, not zeros, when this is false.
      available,
      warnings,
      asOfDate: result.asOfDate,
      portfolioAsOfDate: result.portfolioAsOfDate,
      holdingsAsOfDate: result.holdingsAsOfDate,
      oldestHoldingsDate: result.oldestHoldingsDate,
      engineVersion: result.engineVersion,
      classificationVersion: result.classificationVersion,
      inputSnapshotVersion: result.inputSnapshotVersion,
      dataQuality,
      currencyCode: result.lookThrough.currencyCode,
      totalPortfolioValue: result.lookThrough.totalPortfolioValue,
      // Scheme-level analyses remain valid even with zero look-through
      // coverage, because they need no holdings disclosure at all.
      schemeConcentration: result.schemeConcentration,
      amcConcentration: result.amcConcentration,
      fundManagerConcentration: result.fundManagerConcentration,
      // Look-through-dependent analyses are omitted entirely when unavailable.
      ...(available
        ? {
            topHoldings: result.topHoldings.map((h) => ({
              canonicalId: h.canonicalId,
              name: h.displayName,
              effectiveWeight: h.effectiveWeight,
              effectiveValue: h.effectiveValue,
              schemeCount: h.schemeCount,
              contributingFunds: h.contributingFunds.map((f) => ({ fundName: f.fundName, portfolioWeight: f.portfolioWeight, holdingWeightInFund: f.holdingWeightInFund, contribution: f.contribution })),
              sectorCode: h.sectorCode,
              marketCapClass: h.marketCapClass,
            })),
            securityConcentration: result.securityConcentration,
            sectorExposure: result.sectorExposure,
            industryExposure: result.industryExposure,
            marketCapExposure: result.marketCapExposure,
            preservedBuckets: {
              cashWeight: result.lookThrough.cashWeight,
              derivativeWeight: result.lookThrough.derivativeWeight,
              otherWeight: result.lookThrough.otherWeight,
              unresolvedWeight: result.lookThrough.unresolvedWeight,
              noSnapshotWeight: result.lookThrough.noSnapshotWeight,
              undisclosedRemainderWeight: result.lookThrough.undisclosedRemainderWeight,
            },
            // Debt widgets appear ONLY when genuine debt holdings exist.
            debt: result.debt.applicable ? result.debt : { applicable: false },
          }
        : {
            unavailableReason:
              result.lookThrough.detail ??
              'Fund holdings disclosures are not available for this portfolio, so underlying-exposure analysis cannot be produced.',
          }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Portfolio X-Ray could not be calculated: ${message}`, 500);
  }
}
