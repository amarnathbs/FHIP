import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadXrayDataset } from '@/lib/services/investment-intelligence/r5Repository';
import { runXrayAnalytics, runPairOverlap } from '@/lib/engines/investment-intelligence/xray/xrayOrchestrator';

// R5 — fund-to-fund overlap: the full pairwise matrix, or one pair's detail.
//
// PARAMETER-SPOOFING DEFENCE (spec section 97): `fundA`/`fundB` are accepted
// but are NOT trusted as data access. The dataset is loaded strictly under
// the authenticated user's own id first, and the ids are then matched against
// the funds ALREADY IN THAT DATASET. A caller naming a fund they do not hold
// — or another household's instrument — simply finds no match and receives a
// 404. There is no code path in which a request parameter widens visibility.
//
// INTERPRETATION DISCIPLINE: this route reports overlap percentages and the
// common holdings that drive them. It never classifies an overlap level as
// good or bad, and never suggests selling a fund.

export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(request.url);
  const asOfRaw = url.searchParams.get('asOf');
  if (asOfRaw && !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
    return bad('Invalid date parameter: expected YYYY-MM-DD.');
  }
  const fundA = url.searchParams.get('fundA');
  const fundB = url.searchParams.get('fundB');
  if ((fundA && !fundB) || (!fundA && fundB)) {
    return bad('Both fundA and fundB must be supplied together, or neither.');
  }

  try {
    const supabase = await createClient();
    const { dataset, warnings, empty } = await loadXrayDataset(supabase, user.id, { asOfDate: asOfRaw ?? undefined });

    if (empty || !dataset) {
      return ok({ empty: true, warnings, message: 'No mutual-fund or ETF positions are available yet, so fund overlap cannot be calculated.' });
    }

    if (fundA && fundB) {
      // Ownership check against the already-user-scoped dataset.
      const held = new Set(dataset.positions.map((p) => p.fundInstrumentId));
      if (!held.has(fundA) || !held.has(fundB)) {
        return bad('One or both of the requested funds are not held in this portfolio.', 404);
      }
      if (fundA === fundB) return bad('fundA and fundB must be different funds.');

      const pair = runPairOverlap(dataset, fundA, fundB);
      return ok({
        empty: false,
        asOfDate: dataset.asOfDate,
        portfolioAsOfDate: dataset.portfolioAsOfDate,
        warnings,
        pair: {
          status: pair.status,
          fundAId: pair.fundAId,
          fundBId: pair.fundBId,
          weightedOverlap: pair.weightedOverlap ?? null,
          commonSecurityCount: pair.commonSecurityCount ?? null,
          topCommonHoldings: pair.topCommonHoldings ?? null,
          holdingsDateA: pair.holdingsDateA ?? null,
          holdingsDateB: pair.holdingsDateB ?? null,
          comparableCoverage: pair.comparableCoverage ?? null,
          unresolvedWeightA: pair.unresolvedWeightA ?? null,
          unresolvedWeightB: pair.unresolvedWeightB ?? null,
          freshnessA: pair.freshnessA ?? null,
          freshnessB: pair.freshnessB ?? null,
          qualityWarning: pair.qualityWarning ?? null,
          reason: pair.reason ?? null,
          detail: pair.detail ?? null,
        },
      });
    }

    const result = runXrayAnalytics(dataset);
    if (!result.overlapMatrix) {
      return ok({
        empty: false,
        available: false,
        asOfDate: dataset.asOfDate,
        warnings,
        message:
          'Fund overlap needs published holdings for at least two schemes in this portfolio. Fewer than two are available, so no overlap figures are shown.',
      });
    }

    return ok({
      empty: false,
      available: true,
      asOfDate: dataset.asOfDate,
      portfolioAsOfDate: dataset.portfolioAsOfDate,
      holdingsAsOfDate: result.holdingsAsOfDate,
      oldestHoldingsDate: result.oldestHoldingsDate,
      warnings,
      engineVersion: result.engineVersion,
      matrix: {
        fundIds: result.overlapMatrix.fundIds,
        fundNames: result.overlapMatrix.fundNames,
        values: result.overlapMatrix.matrix,
        method: result.overlapMatrix.method,
      },
      pairs: result.overlapMatrix.pairs.map((p) => ({
        fundAId: p.fundAId,
        fundBId: p.fundBId,
        status: p.status,
        weightedOverlap: p.weightedOverlap ?? null,
        commonSecurityCount: p.commonSecurityCount ?? null,
        topCommonHoldings: p.topCommonHoldings?.slice(0, 5) ?? null,
        comparableCoverage: p.comparableCoverage ?? null,
        qualityWarning: p.qualityWarning ?? null,
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Fund overlap could not be calculated: ${message}`, 500);
  }
}
