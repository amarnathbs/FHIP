// Document2 (4) F2 -- the Performance tab's risk-free rate, read from the SAME governed series as the Fund analytics report.
//
// ROOT CAUSE (traced 20-10-2026). The Investment Intelligence Performance consumer (analyticsRepository.loadRiskFreeRates)
// read ONLY the old table ii_risk_free_rates (migration 0043), which production never had any rows in (on DEV it holds 16
// rows that label themselves "DEV SEED ... not a certified feed"). The Product Owner's governed RBI 91-day Treasury bill series
// (ii_risk_free_series / ii_risk_free_observations, migration 0260, loaded through 14-10-2026) is read only by the NAV2 Fund
// analytics report. So the same household got Sharpe and Sortino on the report and "No risk-free reference data has been
// loaded yet" (printed with the internal key `risk_free`) on the Performance tab.
//
// THE FIX. One rule, one dataset: the Performance tab asks the governed series for the rate in force on its own as-at date, with
// exactly the NAV2 lookup rule (latest published rate on or before the date, never a future one, never interpolated, a weekly
// rate may cross a documented RBI gap within the policy limit, the series' own switch and terms status honoured). It returns the
// old point shape the risk engine already takes, plus a NAMED reason when there is no rate. Nothing here fetches or writes.

import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { RISK_FREE_SERIES_LABELS, type RiskFreeSeriesId } from '@/lib/config/nav2/riskFreeSeriesConfig';
import { addDaysIso } from '@/lib/engines/nav2/dates';
import { cleanRiskFreeDataset, riskFreeObservationOn, type RiskFreeLookupRule, type RiskFreeSupply } from '@/lib/engines/nav2/riskFree';
import type { RiskFreeRatePoint } from '@/lib/config/investment-intelligence/riskFreeRate';
import { formatDateShort } from '@/lib/engines/date';

export interface PerformanceRiskFree {
  /** Points for the risk engine (it looks one up by country and date). Empty when there is no usable rate. */
  points: RiskFreeRatePoint[];
  /** The named reason there is no rate, in plain words. null when a rate was found. */
  unavailableReason: string | null;
  /** Which series the rate came from (for the "how this was calculated" panel). */
  seriesLabel: string | null;
}

const shown = (iso: string): string => formatDateShort(iso, 'INR');

/**
 * The governed series' rate in force on `asOfIso`, as a risk-engine point for India. Pure.
 * `supply` is what loadRiskFreeSupply() returned (null when the series is not set up or could not be read);
 * `readFailure` is that loader's plain reason in that case.
 */
export function governedRiskFreeFor(supply: RiskFreeSupply, readFailure: string | null, asOfIso: string): PerformanceRiskFree {
  const none = (reason: string): PerformanceRiskFree => ({ points: [], unavailableReason: reason, seriesLabel: null });
  if (supply === null) return none(`${readFailure ?? 'The risk-free rate series is not set up.'} Sharpe, Sortino and alpha are not shown. No rate has been assumed.`);
  const label = RISK_FREE_SERIES_LABELS[supply.seriesId as RiskFreeSeriesId] ?? supply.seriesName;
  if (!supply.enabled) return none(`The ${label} series is switched off, so Sharpe, Sortino and alpha are not shown. No rate has been assumed.`);
  const cleaned = cleanRiskFreeDataset(supply);
  if (!cleaned.usable || cleaned.observations.length === 0) return none(`The ${label} series has no usable rates on file yet, so Sharpe, Sortino and alpha are not shown. No rate has been assumed.`);
  const gaps = NAV2_POLICY.riskFreeGaps;
  const rule: RiskFreeLookupRule = {
    cadence: supply.cadence,
    maxStalenessDays: supply.maxStalenessDays,
    verifiedThroughDate: supply.verifiedThroughDate,
    ...(supply.cadence === 'weekly_auction'
      ? { gapCarry: { gapDates: cleaned.gaps.map((g) => g.observationDate), maxCarryDays: gaps.maxCarryAcrossDocumentedGapDays, maxRecordSpacingDays: gaps.documentedGapMaxRecordSpacingDays } }
      : {}),
  };
  const hit = riskFreeObservationOn(cleaned.observations, asOfIso, rule);
  if (!hit.ok) {
    const first = cleaned.observations[0].observationDate;
    const last = cleaned.observations[cleaned.observations.length - 1].observationDate;
    return none(
      hit.reason === 'stale'
        ? `The latest ${label} rate on file is dated ${shown(last)}, more than ${supply.maxStalenessDays} days before ${shown(asOfIso)}, so Sharpe, Sortino and alpha are not shown for that date. No rate has been carried forward or estimated. Newer rates are loaded from the Reserve Bank of India weekly.`
        : `The ${label} rates on file start on ${shown(first)}, after ${shown(asOfIso)}, so Sharpe, Sortino and alpha are not shown for that date. No rate has been assumed for the earlier period.`
    );
  }
  const o = hit.observation;
  const periodEnd = addDaysIso(asOfIso, 0);
  return {
    points: [
      {
        countryCode: 'IN',
        periodStart: new Date(`${o.observationDate}T00:00:00.000Z`),
        periodEnd: new Date(`${periodEnd}T00:00:00.000Z`),
        annualisedRate: (o.yieldPercent as number) / 100,
        source: `${label} (${supply.source}), ${supply.cadence === 'policy_change' ? 'decision' : 'auction'} of ${shown(o.observationDate)}`,
        method: 'latest_on_or_before_never_future_never_interpolated',
        version: supply.datasetVersion,
      },
    ],
    unavailableReason: null,
    seriesLabel: label,
  };
}
