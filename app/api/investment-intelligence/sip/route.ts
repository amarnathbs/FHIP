import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadSipDataset, attachAttributableInflows, persistR5Results } from '@/lib/services/investment-intelligence/r5Repository';
import { runSipAnalytics } from '@/lib/engines/investment-intelligence/sip/sipOrchestrator';
import { SIP_ENGINE_VERSION } from '@/lib/engines/investment-intelligence/r5Versioning';

// R5 — SIP series + SIP analytics for the authenticated user.
//
// This route RETRIEVES derived results. It does not re-implement a single
// formula: every number comes from the certified engines via
// runSipAnalytics(). It is strictly read-only with respect to every FHIP
// financial register — nothing here can change net worth.
//
// PARAMETER-SPOOFING DEFENCE (spec sections 96-97): the ONLY identity used is
// `user.id` from the authenticated session. There is deliberately no
// household, account, instrument, or benchmark parameter, so there is nothing
// for a caller to spoof. `asOf` is a pure date bound that can only NARROW the
// analysis; it cannot widen data visibility, and it is additionally capped
// server-side to the most recent date for which real data exists.
//
// The client may ask "calculate my SIP". It may never supply the benchmark
// id, the benchmark series, the NAV series, or any holding weight — all
// authoritative inputs are resolved server-side in r5Repository.

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
    const { dataset, warnings, empty } = await loadSipDataset(supabase, user.id, { asOfDate: asOfRaw ?? undefined });

    if (empty || !dataset) {
      return ok({
        empty: true,
        warnings,
        message: 'No investment transactions are available yet, so recurring-contribution analysis cannot be produced.',
      });
    }

    // Detection must run before inflows can be attributed to concrete series.
    const preliminary = runSipAnalytics(dataset);
    attachAttributableInflows(dataset, preliminary.analytics.map((a) => a.series.seriesKey));
    const result = runSipAnalytics(dataset);

    // Persist derived results (service-role; never from a request body).
    // A persistence failure never blocks a correct answer.
    const persistence = await persistR5Results(
      user.id,
      result.analytics.flatMap((a) => [
        {
          scopeType: 'sip_series' as const,
          scopeId: a.series.seriesKey,
          metricKey: 'sip_actual_xirr',
          metricVersion: a.subVersions.sipXirr,
          engineVersion: SIP_ENGINE_VERSION,
          dataAsOfDate: result.asOfDate,
          inputSnapshotVersion: a.inputSnapshotVersion,
          qualityStatus: a.actualXirr.status,
          qualityReason: a.actualXirr.status === 'ok' ? null : a.actualXirr.reason ?? null,
          resultValue: { rate: a.actualXirr.rate ?? null, terminalValue: a.actualXirr.terminalValue ?? null, totalContributed: a.actualXirr.totalContributed ?? null },
        },
        {
          scopeType: 'sip_series' as const,
          scopeId: a.series.seriesKey,
          metricKey: 'sip_benchmark_xirr',
          metricVersion: a.subVersions.benchmarkSip,
          engineVersion: SIP_ENGINE_VERSION,
          dataAsOfDate: result.asOfDate,
          inputSnapshotVersion: a.inputSnapshotVersion,
          qualityStatus: a.benchmarkSip.status,
          qualityReason: a.benchmarkSip.status === 'ok' ? null : a.benchmarkSip.reason ?? null,
          resultValue: { rate: a.benchmarkSip.rate ?? null, terminalValue: a.benchmarkSip.terminalValue ?? null, benchmarkKey: a.benchmarkKey },
        },
      ])
    );

    return ok({
      empty: false,
      warnings: persistence.error ? [...warnings, { scope: 'persistence', detail: `Results could not be stored (${persistence.error}); the figures shown were recomputed from certified inputs.` }] : warnings,
      asOfDate: result.asOfDate,
      engineVersion: result.engineVersion,
      seriesCount: result.seriesCount,
      presentableCount: result.presentableCount,
      // Only presentable series are returned as SIP series. Ambiguous
      // groupings are reported as a count, never dressed up as a SIP.
      series: result.analytics
        .filter((a) => a.presentable)
        .map((a) => ({
          seriesKey: a.series.seriesKey,
          instrumentId: a.series.instrumentId,
          instrumentName: a.instrumentName,
          currencyCode: a.series.currencyCode,
          cadence: a.series.cadence,
          confidence: a.series.confidence,
          confidenceRationale: a.series.confidenceRationale,
          trend: a.series.trend,
          firstContributionDate: a.series.firstContributionDate,
          latestContributionDate: a.series.latestContributionDate,
          contributionCount: a.series.contributions.length,
          contributions: a.series.contributions.map((c) => ({ date: c.transactionDate, amount: c.grossAmount, units: c.units })),
          activity: a.activity,
          consistency: a.consistency,
          actualXirr: a.actualXirr,
          benchmarkSip: {
            status: a.benchmarkSip.status,
            rate: a.benchmarkSip.rate ?? null,
            terminalValue: a.benchmarkSip.terminalValue ?? null,
            reason: a.benchmarkSip.reason ?? null,
            detail: a.benchmarkSip.detail ?? null,
            benchmarkKey: a.benchmarkKey,
            benchmarkReturnType: a.benchmarkReturnType,
            appliedContributions: a.benchmarkSip.appliedContributions ?? null,
          },
          excessReturn: a.excessReturn,
          wealthComparison: a.wealthComparison,
          timing: a.timing,
          navAtAsOf: a.navAtAsOf,
          navDateUsed: a.navDateUsed,
          attribution: { status: a.attribution.status, reason: a.attribution.reason ?? null, positionIsMixed: a.attribution.positionIsMixed ?? false, detail: a.attribution.detail ?? null },
          observations: a.observations,
          inputSnapshotVersion: a.inputSnapshotVersion,
        })),
      ambiguous: result.analytics
        .filter((a) => !a.presentable)
        .map((a) => ({ instrumentId: a.series.instrumentId, instrumentName: a.instrumentName, confidence: a.series.confidence, rationale: a.series.confidenceRationale })),
    });
  } catch (e) {
    // Clean error handling: a failure surfaces as an explicit error, never as
    // a zero-valued result a caller could mistake for a real calculation.
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`SIP analytics could not be calculated: ${message}`, 500);
  }
}
