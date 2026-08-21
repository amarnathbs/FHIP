import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { loadXrayDataset } from '@/lib/services/investment-intelligence/r5Repository';
import { runXrayAnalytics, summariseXrayDataQuality } from '@/lib/engines/investment-intelligence/xray/xrayOrchestrator';
import { HOLDINGS_FRESHNESS_DAYS, COVERAGE_THRESHOLDS, MIXED_DATE_SPREAD_DAYS, XRAY_THRESHOLD_CONFIG_VERSION } from '@/lib/config/investment-intelligence/xrayThresholds';

// R5 — X-Ray data-quality and coverage detail.
//
// Exists as its own endpoint because coverage and freshness are NOT optional
// footnotes in R5: they are first-class results a consumer is required to
// display. This route also returns the ACTIVE THRESHOLDS and their version,
// so the meaning of "stale" or "partial" is auditable rather than folded
// invisibly into a label.

export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(request.url);
  const asOfRaw = url.searchParams.get('asOf');
  if (asOfRaw && !/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
    return bad('Invalid date parameter: expected YYYY-MM-DD.');
  }

  try {
    const supabase = await createClient();
    const { dataset, warnings, empty } = await loadXrayDataset(supabase, user.id, { asOfDate: asOfRaw ?? undefined });

    const thresholds = {
      configVersion: XRAY_THRESHOLD_CONFIG_VERSION,
      freshnessDays: HOLDINGS_FRESHNESS_DAYS,
      coverage: COVERAGE_THRESHOLDS,
      mixedDateSpreadDays: MIXED_DATE_SPREAD_DAYS,
    };

    if (empty || !dataset) {
      return ok({
        empty: true,
        warnings,
        thresholds,
        message: 'No mutual-fund or ETF positions are available yet, so there is no X-Ray coverage to report.',
      });
    }

    const result = runXrayAnalytics(dataset);
    const summary = summariseXrayDataQuality(result);

    return ok({
      empty: false,
      warnings,
      thresholds,
      dataQuality: summary,
      perFundCoverage: result.lookThrough.perFundCoverage.map((c) => ({
        fundInstrumentId: c.fundInstrumentId,
        fundName: dataset.positions.find((p) => p.fundInstrumentId === c.fundInstrumentId)?.fundName ?? c.fundInstrumentId,
        reportedHoldingsCoverage: c.reportedHoldingsCoverage,
        resolvedWeight: c.resolvedWeight,
        unresolvedWeight: c.unresolvedWeight,
        cashWeight: c.cashWeight,
        derivativeWeight: c.derivativeWeight,
        otherWeight: c.otherWeight,
        undisclosedRemainder: c.undisclosedRemainder,
        weightSumWithinRoundingTolerance: c.weightSumWithinRoundingTolerance,
      })),
      fundsWithoutHoldings: dataset.positions
        .filter((p) => !result.snapshotIdsUsed.some((id) => (dataset.snapshotsByFund.get(p.fundInstrumentId) ?? []).some((s) => s.snapshotId === id)))
        .map((p) => ({ fundInstrumentId: p.fundInstrumentId, fundName: p.fundName })),
      snapshotIdsUsed: result.snapshotIdsUsed,
      engineVersion: result.engineVersion,
      inputSnapshotVersion: result.inputSnapshotVersion,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`X-Ray data quality could not be assessed: ${message}`, 500);
  }
}
