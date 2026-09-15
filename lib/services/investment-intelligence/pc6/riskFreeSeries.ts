// PC6 (M6) — risk-free rate series.
//
// N.10: "Implement the approved risk-free-rate source and effective dates
//        required for risk analytics. Do not choose a proxy silently; record
//        the methodology decision explicitly (and if this genuinely requires a
//        Product Owner choice of source, name it as a blocker rather than
//        silently picking one — e.g. RBI repo rate vs. a specific G-Sec tenor
//        vs. a fixed assumption)."
//
// ============================================================================
// THIS MODULE DELIBERATELY DOES NOT CHOOSE A SOURCE. BLOCKER PO-PC6-2.
// ============================================================================
// There is no "approved risk-free-rate source" recorded anywhere in this
// repository. The search that established this is documented in the PC6
// certification; the only risk-free data that exists today is 16 rows in
// DEV's ii_risk_free_rates whose own `source` column reads
//
//     "DEV SEED - approximate RBI 91-day T-Bill annual average (not a
//      certified feed)"
//
// i.e. the seed labels itself as not a source of truth. Promoting that to
// production would be exactly the silent proxy choice N.10 forbids.
//
// The choice matters numerically. Sharpe and Sortino are (return - rf)/risk,
// so rf shifts every risk-adjusted number the app shows. Across 2024-2026 the
// three candidates below differ by 100-150 basis points, which moves a Sharpe
// ratio by a materially visible amount for a fund with 12% volatility.
//
// What PC6 ships instead is: the versioned, effective-dated series SHAPE; the
// methodology-record REQUIREMENT (a series cannot be written without one); the
// resolution and freshness logic; and a first-class `pending_po_decision`
// state that the admin surface reports honestly. When the Product Owner picks
// a candidate, the only change needed is a governed methodology row plus an
// importer for that one source.

import { assessFreshness, type FreshnessVerdict } from './referenceDataQuality';

export const PC6_RISK_FREE_RULES_VERSION = 'pc6-risk-free-v1';

export interface RiskFreeCandidate {
  key: string;
  label: string;
  publisher: string;
  /** Where a human can verify it. */
  reference: string;
  tenor: string;
  publicationCadence: 'daily' | 'weekly' | 'monthly' | 'policy_meeting';
  /** The case for it, stated plainly enough for a PO to decide on. */
  argumentFor: string;
  argumentAgainst: string;
}

/**
 * The three defensible Indian candidates, written out so the decision can be
 * made from this file rather than from memory. NONE of them is marked
 * default, and nothing in this module reads a "first" entry.
 */
export const INDIA_RISK_FREE_CANDIDATES: readonly RiskFreeCandidate[] = [
  {
    key: 'rbi_tbill_91d',
    label: 'RBI 91-day Treasury Bill auction cut-off yield',
    publisher: 'Reserve Bank of India',
    reference: 'https://data.rbi.org.in/ — Treasury Bill auction results',
    tenor: '91 days',
    publicationCadence: 'weekly',
    argumentFor:
      'The conventional academic short-rate proxy, genuinely default-free, and the closest Indian analogue to the US 3-month T-bill used in the original Sharpe/Sortino literature. Matches the short measurement horizon of monthly-frequency risk metrics.',
    argumentAgainst:
      'Auction-driven, so it moves with issuance calendars as well as policy, and there is no auction in some weeks — the series needs an explicit carry-forward rule.',
  },
  {
    key: 'rbi_gsec_10y',
    label: '10-year benchmark Government Security yield',
    publisher: 'Reserve Bank of India / FBIL',
    reference: 'https://data.rbi.org.in/ — G-Sec yields; FBIL publishes the benchmark valuation curve',
    tenor: '10 years',
    publicationCadence: 'daily',
    argumentFor:
      'Daily, liquid, and tenor-matched to a long-horizon equity investor — arguably the better comparator for a 10-year fund CAGR than a 91-day bill.',
    argumentAgainst:
      'Carries duration risk, so it is not risk-free over any holding period shorter than 10 years. Using it in Sharpe understates excess return when the curve is steep.',
  },
  {
    key: 'rbi_policy_repo',
    label: 'RBI policy repo rate',
    publisher: 'Reserve Bank of India',
    reference: 'https://www.rbi.org.in/ — Monetary Policy Statements',
    tenor: 'overnight (policy)',
    publicationCadence: 'policy_meeting',
    argumentFor:
      'Unambiguous, stepwise, easy to explain to a retail user, and never revised. No interpolation or auction-gap handling needed.',
    argumentAgainst:
      'A policy instrument, not a traded return. An investor cannot earn the repo rate, so it is not an achievable alternative investment — which is what the risk-free rate in Sharpe is supposed to represent.',
  },
] as const;

export type RiskFreeMethod = 'period_average' | 'period_end' | 'auction_cutoff_carry_forward' | 'policy_step';

/**
 * A methodology record is MANDATORY for every risk-free series. Without one,
 * a number in ii_risk_free_rates is an unattributed assertion.
 */
export interface RiskFreeMethodology {
  countryCode: string;
  /** Must be one of the candidate keys, or another key the PO has approved. */
  sourceKey: string;
  tenor: string;
  method: RiskFreeMethod;
  /** Exactly how a gap (no auction that week, a holiday) is handled. */
  gapRule: string;
  version: string;
  approvedByActorId: string;
  approvedAt: string;
  reference: string;
}

export type RiskFreeStatus =
  | { state: 'governed'; methodology: RiskFreeMethodology }
  | { state: 'pending_po_decision'; candidates: readonly RiskFreeCandidate[]; detail: string }
  | { state: 'uncertified_seed'; detail: string };

/**
 * Classify the risk-free position for a country.
 *
 * `uncertified_seed` is separated from `pending_po_decision` on purpose: the
 * first means rows EXIST and are being read by the risk engines while carrying
 * a self-declared "not a certified feed" label — a live correctness risk the
 * admin surface must show — while the second is simply an open decision.
 */
export function classifyRiskFree(
  countryCode: string,
  methodologies: RiskFreeMethodology[],
  existingRowSources: string[]
): RiskFreeStatus {
  const governed = methodologies.find((m) => m.countryCode === countryCode);
  if (governed) return { state: 'governed', methodology: governed };

  const looksLikeSeed = existingRowSources.some((s) => /dev seed|not a certified feed|approximate/i.test(s));
  if (looksLikeSeed) {
    return {
      state: 'uncertified_seed',
      detail:
        `Risk-free rows exist for ${countryCode} but carry a self-declared uncertified-seed source and no governed methodology record. ` +
        'Sharpe and Sortino computed from them must be labelled as provisional. BLOCKER PO-PC6-2.',
    };
  }
  return {
    state: 'pending_po_decision',
    candidates: INDIA_RISK_FREE_CANDIDATES,
    detail:
      `No approved risk-free source is on file for ${countryCode}. PC6 will not pick one on its own authority (N.10). ` +
      'BLOCKER PO-PC6-2.',
  };
}

export interface RiskFreePeriod {
  countryCode: string;
  periodStart: string;
  periodEnd: string;
  annualisedRate: number;
  version: string;
  source: string;
}

export type RiskFreeResolution =
  | { state: 'ok'; rate: number; period: RiskFreePeriod; qualified: boolean; detail: string }
  | { state: 'unavailable'; reason: 'NO_PERIOD_COVERS_DATE' | 'NO_SERIES' | 'PENDING_PO_DECISION'; detail: string };

/**
 * Resolve the annualised risk-free rate applicable on a date.
 *
 * Returns `unavailable` rather than a default. The certified risk engines
 * already treat a missing rf correctly: riskMetrics.sharpeRatio and
 * sortinoRatio return a MetricResult carrying an unavailable reason rather
 * than substituting zero, so an absent rate suppresses the ratio instead of
 * inflating it (rf = 0 would make every Sharpe look better than it is).
 */
export function resolveRiskFree(
  countryCode: string,
  onDate: string,
  periods: RiskFreePeriod[],
  status: RiskFreeStatus
): RiskFreeResolution {
  if (status.state === 'pending_po_decision') {
    return { state: 'unavailable', reason: 'PENDING_PO_DECISION', detail: status.detail };
  }
  const applicable = periods.filter((p) => p.countryCode === countryCode && p.periodStart <= onDate && onDate <= p.periodEnd);
  if (periods.filter((p) => p.countryCode === countryCode).length === 0) {
    return { state: 'unavailable', reason: 'NO_SERIES', detail: `No risk-free series exists for ${countryCode}.` };
  }
  if (applicable.length === 0) {
    return { state: 'unavailable', reason: 'NO_PERIOD_COVERS_DATE', detail: `No risk-free period covers ${onDate} for ${countryCode}. The rate is not extrapolated.` };
  }
  // Deterministic: newest version wins, then the shortest (most specific) period.
  const chosen = [...applicable].sort((a, b) => {
    if (a.version !== b.version) return b.version.localeCompare(a.version);
    const aLen = Date.parse(a.periodEnd) - Date.parse(a.periodStart);
    const bLen = Date.parse(b.periodEnd) - Date.parse(b.periodStart);
    return aLen - bLen;
  })[0];
  const qualified = status.state === 'uncertified_seed';
  return {
    state: 'ok',
    rate: chosen.annualisedRate,
    period: chosen,
    qualified,
    detail: qualified
      ? `Rate ${chosen.annualisedRate} resolved from an UNCERTIFIED seed series (${chosen.source}). Any Sharpe/Sortino built on it is provisional. BLOCKER PO-PC6-2.`
      : `Rate ${chosen.annualisedRate} resolved from ${chosen.source} (version ${chosen.version}).`,
  };
}

/** Risk-free freshness, for the admin surface (N.11). */
export function riskFreeFreshness(periods: RiskFreePeriod[], countryCode: string, asOfDate: string, thresholdDays = 45): FreshnessVerdict {
  const latest = periods
    .filter((p) => p.countryCode === countryCode)
    .map((p) => p.periodEnd)
    .sort()
    .at(-1) ?? null;
  return assessFreshness(latest, asOfDate, thresholdDays);
}
