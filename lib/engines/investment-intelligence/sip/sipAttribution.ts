// Investment Intelligence R5 — SIP unit attribution.
//
// THE CRITICAL RULE (spec sections 20-21, and critical-FAIL item 5):
// If a fund holds BOTH SIP instalments and independent lump-sum purchases,
// the fund's full current value must NOT be attributed to the SIP series
// unless the SIP's own units are mathematically reconstructable. When they
// are not, R5 SUPPRESSES the SIP-specific XIRR and directs the caller to the
// certified R4 fund-level investor XIRR instead. It NEVER invents an
// allocation ratio.
//
// WHAT COUNTS AS RECONSTRUCTABLE
//   Every contribution in the series must carry its own `units` from the
//   source (CAS statements do provide units per transaction), AND every
//   unit-reducing event on the same (account, instrument) — redemption,
//   switch_out, transfer out — must be attributable to a lot under a
//   DETERMINISTIC, ALREADY-CERTIFIED convention.
//
//   R5 does NOT implement tax-lot optimisation (that is R6 scope, an
//   explicit hard stop). The only disposal convention R5 will accept is FIFO
//   across the whole (account, instrument) position, which is the canonical
//   structure R2/R1 already model via ii_tax_lots.acquisition_date. Under
//   FIFO, "how many of the surviving units came from SIP instalments?" has
//   exactly one answer, so no arbitrary methodology is introduced.
//
//   If ANY disposal exists and the series is mixed with non-series purchases,
//   FIFO still resolves it deterministically — but only when every
//   contributing transaction (series AND non-series) carries units. A single
//   missing unit figure makes the reconstruction unsound, and attribution is
//   reported UNAVAILABLE rather than approximated.

import type { SipCandidateTransaction, SipSeries } from './sipDetection';

export const SIP_ATTRIBUTION_METHOD_VERSION = 'sip-attribution-fifo-r5-v1';

/** Disposal / unit-reducing event types on the same (account, instrument). */
const DISPOSAL_TYPES = new Set(['redemption', 'switch_out', 'transfer']);
/** Unit-adding event types that are NOT part of the SIP series itself. */
const ACQUISITION_TYPES = new Set(['purchase', 'sip', 'switch_in', 'reinvestment', 'merger']);

export type AttributionUnavailableReason =
  | 'MISSING_UNITS_ON_CONTRIBUTION'
  | 'MISSING_UNITS_ON_NON_SERIES_ACQUISITION'
  | 'MISSING_UNITS_ON_DISPOSAL'
  | 'NO_SERIES_UNITS'
  | 'DISPOSALS_EXCEED_ACQUISITIONS';

export interface SipAttributionResult {
  status: 'ok' | 'unavailable';
  /** Units from this SIP series still held at the as-of date. */
  seriesUnitsRemaining?: number;
  /** Total units still held across the whole (account, instrument) position. */
  positionUnitsRemaining?: number;
  /** seriesUnitsRemaining / positionUnitsRemaining, 0..1. */
  seriesShareOfPosition?: number;
  /** True when the position contains acquisitions outside this SIP series. */
  positionIsMixed?: boolean;
  /** Units disposed that had originated from this SIP series (FIFO). */
  seriesUnitsDisposed?: number;
  reason?: AttributionUnavailableReason;
  detail?: string;
  method: typeof SIP_ATTRIBUTION_METHOD_VERSION;
}

interface Lot {
  date: string;
  units: number;
  fromSeries: boolean;
}

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}

const UNIT_EPSILON = 1e-9;

/**
 * Reconstruct, under FIFO, how many of the units still held on the as-of
 * date originated from `series`.
 *
 * @param series            the detected SIP series
 * @param positionTxns      ALL certified transactions for the same
 *                          (account, instrument), including non-series
 *                          purchases and every disposal
 * @param asOfDate          analysis end date; transactions after it are ignored
 */
export function attributeSipUnits(
  series: SipSeries,
  positionTxns: SipCandidateTransaction[],
  asOfDate: string
): SipAttributionResult {
  const seriesIds = new Set(series.contributions.map((c) => c.id));
  const inScope = positionTxns
    .filter((t) => toUtc(t.transactionDate) <= toUtc(asOfDate))
    .sort((a, b) => {
      const d = toUtc(a.transactionDate) - toUtc(b.transactionDate);
      // Deterministic tie-break so same-day acquisition/disposal ordering is
      // reproducible: acquisitions settle before disposals on the same date,
      // then by transaction id.
      if (d !== 0) return d;
      const aAcq = ACQUISITION_TYPES.has(a.transactionType) ? 0 : 1;
      const bAcq = ACQUISITION_TYPES.has(b.transactionType) ? 0 : 1;
      if (aAcq !== bAcq) return aAcq - bAcq;
      return a.id.localeCompare(b.id);
    });

  const lots: Lot[] = [];
  let disposedFromSeries = 0;
  let positionIsMixed = false;

  for (const t of inScope) {
    if (ACQUISITION_TYPES.has(t.transactionType)) {
      const isSeries = seriesIds.has(t.id);
      if (t.units === null || t.units === undefined || !Number.isFinite(t.units)) {
        return {
          status: 'unavailable',
          reason: isSeries ? 'MISSING_UNITS_ON_CONTRIBUTION' : 'MISSING_UNITS_ON_NON_SERIES_ACQUISITION',
          detail: `Transaction ${t.id} on ${t.transactionDate} (${t.transactionType}) has no unit figure, so the units attributable to this recurring series cannot be reconstructed. A SIP-specific return is not shown; the fund-level investor return remains available.`,
          method: SIP_ATTRIBUTION_METHOD_VERSION,
        };
      }
      if (t.units <= 0) continue;
      if (!isSeries) positionIsMixed = true;
      lots.push({ date: t.transactionDate, units: t.units, fromSeries: isSeries });
    } else if (DISPOSAL_TYPES.has(t.transactionType)) {
      if (t.units === null || t.units === undefined || !Number.isFinite(t.units)) {
        return {
          status: 'unavailable',
          reason: 'MISSING_UNITS_ON_DISPOSAL',
          detail: `Disposal ${t.id} on ${t.transactionDate} has no unit figure, so the surviving units cannot be attributed between this recurring series and other purchases in the same fund.`,
          method: SIP_ATTRIBUTION_METHOD_VERSION,
        };
      }
      let toRemove = Math.abs(t.units);
      // FIFO: consume the oldest surviving lots first.
      for (const lot of lots) {
        if (toRemove <= UNIT_EPSILON) break;
        if (lot.units <= UNIT_EPSILON) continue;
        const take = Math.min(lot.units, toRemove);
        lot.units -= take;
        toRemove -= take;
        if (lot.fromSeries) disposedFromSeries += take;
      }
      if (toRemove > 1e-6) {
        return {
          status: 'unavailable',
          reason: 'DISPOSALS_EXCEED_ACQUISITIONS',
          detail: `Recorded disposals exceed recorded acquisitions for this fund by ${toRemove.toFixed(6)} units as at ${t.transactionDate}. Unit attribution is not reliable, so a SIP-specific return is not shown.`,
          method: SIP_ATTRIBUTION_METHOD_VERSION,
        };
      }
    }
    // Types outside both sets (dividend cash, fee, tax, adjustment) do not
    // move units and are intentionally ignored here.
  }

  const seriesUnitsRemaining = lots.filter((l) => l.fromSeries).reduce((s, l) => s + l.units, 0);
  const positionUnitsRemaining = lots.reduce((s, l) => s + l.units, 0);

  if (seriesUnitsRemaining <= UNIT_EPSILON) {
    return {
      status: 'unavailable',
      reason: 'NO_SERIES_UNITS',
      detail: 'No units from this recurring series are still held at the analysis date, so there is no ending value to attribute to it.',
      positionIsMixed,
      seriesUnitsDisposed: disposedFromSeries,
      method: SIP_ATTRIBUTION_METHOD_VERSION,
    };
  }

  return {
    status: 'ok',
    seriesUnitsRemaining,
    positionUnitsRemaining,
    seriesShareOfPosition: positionUnitsRemaining > 0 ? seriesUnitsRemaining / positionUnitsRemaining : 0,
    positionIsMixed,
    seriesUnitsDisposed: disposedFromSeries,
    method: SIP_ATTRIBUTION_METHOD_VERSION,
  };
}

export const __sipAttributionInternals = { DISPOSAL_TYPES, ACQUISITION_TYPES, UNIT_EPSILON };
