// Investment Intelligence R5 — recurring-contribution (SIP) series detection.
//
// R5 IS AN ANALYTICAL INTERPRETATION LAYER OVER CERTIFIED R2 DATA.
// It never modifies ii_transactions and never reclassifies a certified R2
// transaction_type. R2 remains transaction truth; this module only groups
// and annotates (spec section 39).
//
// SERIES IDENTITY (spec section 40):
//   Owner + Account/Folio + Instrument + Recurring-Contribution-Series
// Two genuinely different mandates in the SAME fund and folio — say a
// Rs 5,000 monthly and a Rs 10,000 quarterly SIP — are DIFFERENT series and
// are never auto-merged. Separation is by (cadence band, amount cluster),
// derived below, not by assuming one series per fund.
//
// CONFIDENCE VOCABULARY (spec section 41):
//   CONFIRMED_SOURCE  — the statement itself says SIP (R2 transaction_type
//                       = 'sip', or an explicit SIP source description).
//                       Only source evidence earns this label.
//   HIGH_CONFIDENCE   — inferred: >= MIN_CONTRIBUTIONS_FOR_INFERENCE
//                       purchases, a consistent cadence band, and similar
//                       amounts (or a monotonic step-up).
//   POSSIBLE          — recurring-ish but failing one inference test.
//   AMBIGUOUS         — several manual purchases near similar dates with no
//                       stable interval. MUST NOT be shown as a SIP.
//   NOT_SIP           — no recurring pattern at all.
//
// The critical rule enforced here: an inferred series can NEVER be labelled
// CONFIRMED_SOURCE. Only genuine source evidence produces that value, and
// the certification pack asserts it directly (SIP-016).

import {
  CADENCE_BANDS,
  type CadenceKey,
  MIN_CONTRIBUTIONS_FOR_INFERENCE,
  MIN_INTERVAL_CONSISTENCY_FOR_CADENCE,
  AMOUNT_SIMILARITY_TOLERANCE,
  SIP_THRESHOLD_CONFIG_VERSION,
} from '@/lib/config/investment-intelligence/sipThresholds';

export const SIP_DETECTION_METHOD_VERSION = 'sip-detection-r5-v1';

/** A certified R2 transaction, narrowed to what detection needs. */
export interface SipCandidateTransaction {
  id: string;
  accountId: string;
  instrumentId: string;
  /** Certified R2 transaction_type — read only, never rewritten. */
  transactionType: string;
  transactionDate: string; // ISO yyyy-mm-dd
  grossAmount: number; // positive magnitude as recorded by R2
  units: number | null;
  currencyCode: string;
  /** Free-text provider description/reference, used only as corroborating evidence. */
  sourceDescription?: string | null;
}

export type SipCadence = 'MONTHLY' | 'QUARTERLY' | 'WEEKLY' | 'FORTNIGHTLY' | 'ANNUAL' | 'OTHER_RECURRING' | 'IRREGULAR' | 'UNKNOWN';

export type SipConfidence = 'CONFIRMED_SOURCE' | 'HIGH_CONFIDENCE' | 'POSSIBLE' | 'AMBIGUOUS' | 'NOT_SIP';

export type ContributionTrend = 'FLAT' | 'INCREASING' | 'DECREASING' | 'MIXED';

export interface SipSeries {
  /** Deterministic, stable identity string — see buildSeriesKey(). */
  seriesKey: string;
  accountId: string;
  instrumentId: string;
  currencyCode: string;
  contributions: SipCandidateTransaction[];
  cadence: SipCadence;
  /** Periods per year implied by `cadence`; null when cadence is not periodic. */
  periodsPerYear: number | null;
  confidence: SipConfidence;
  /** Human-readable justification for the assigned confidence — surfaced in the UI. */
  confidenceRationale: string;
  trend: ContributionTrend;
  firstContributionDate: string;
  latestContributionDate: string;
  detectionMethodVersion: typeof SIP_DETECTION_METHOD_VERSION;
  thresholdConfigVersion: typeof SIP_THRESHOLD_CONFIG_VERSION;
}

const CONTRIBUTION_TYPES = new Set(['purchase', 'sip', 'reinvestment']);
/** Types that count as an investor CONTRIBUTION for SIP purposes. Reinvestment
 *  is deliberately EXCLUDED from series membership (it is not investor money
 *  in — it is a distribution recycled), but is retained for XIRR treatment
 *  elsewhere. See sipXirr.ts. */
const SERIES_MEMBER_TYPES = new Set(['purchase', 'sip']);

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}
function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Deterministic series key. Stable across re-runs for identical input. */
export function buildSeriesKey(accountId: string, instrumentId: string, discriminator: string): string {
  return `${accountId}:${instrumentId}:${discriminator}`;
}

/** True when the source itself asserts this transaction is a SIP instalment. */
export function isSourceConfirmedSip(txn: SipCandidateTransaction): boolean {
  if (txn.transactionType === 'sip') return true;
  const d = (txn.sourceDescription ?? '').toUpperCase();
  // Deliberately narrow: the description must name a systematic plan, not
  // merely contain the letters "sip" inside another word.
  return /\bSIP\b/.test(d) || /SYSTEMATIC\s+INVESTMENT/.test(d);
}

/** Classify a set of consecutive-interval days into a cadence. */
export function classifyCadence(intervalDays: number[]): { cadence: SipCadence; periodsPerYear: number | null } {
  if (intervalDays.length === 0) return { cadence: 'UNKNOWN', periodsPerYear: null };
  let best: { key: CadenceKey; hits: number } | null = null;
  for (const key of Object.keys(CADENCE_BANDS) as CadenceKey[]) {
    const band = CADENCE_BANDS[key];
    const hits = intervalDays.filter((d) => d >= band.minDays && d <= band.maxDays).length;
    if (!best || hits > best.hits) best = { key, hits };
  }
  if (best && best.hits / intervalDays.length >= MIN_INTERVAL_CONSISTENCY_FOR_CADENCE) {
    return { cadence: best.key as SipCadence, periodsPerYear: CADENCE_BANDS[best.key].periodsPerYear };
  }
  // Recurring but with no single dominant band: still recurring if intervals
  // are broadly regular (coefficient of variation is modest), else irregular.
  const mean = intervalDays.reduce((s, d) => s + d, 0) / intervalDays.length;
  if (mean <= 0) return { cadence: 'IRREGULAR', periodsPerYear: null };
  const variance = intervalDays.reduce((s, d) => s + (d - mean) ** 2, 0) / intervalDays.length;
  const cv = Math.sqrt(variance) / mean;
  return cv <= 0.35 ? { cadence: 'OTHER_RECURRING', periodsPerYear: null } : { cadence: 'IRREGULAR', periodsPerYear: null };
}

/** Classify the amount trajectory of a contribution series. */
export function classifyTrend(amounts: number[]): ContributionTrend {
  if (amounts.length < 2) return 'FLAT';
  const med = median(amounts);
  if (med > 0 && amounts.every((a) => Math.abs(a - med) / med <= AMOUNT_SIMILARITY_TOLERANCE)) return 'FLAT';
  let up = 0;
  let down = 0;
  for (let i = 1; i < amounts.length; i++) {
    // Ignore within-tolerance wobble so a flat SIP with rounding noise is not
    // read as a trend.
    const ref = amounts[i - 1];
    if (ref <= 0) continue;
    const rel = (amounts[i] - ref) / ref;
    if (rel > AMOUNT_SIMILARITY_TOLERANCE) up++;
    else if (rel < -AMOUNT_SIMILARITY_TOLERANCE) down++;
  }
  if (up > 0 && down === 0) return 'INCREASING';
  if (down > 0 && up === 0) return 'DECREASING';
  if (up === 0 && down === 0) return 'FLAT';
  return 'MIXED';
}

/**
 * Split contributions for one (account, instrument) into distinct mandates.
 *
 * Deliberately conservative: source-confirmed SIP instalments are separated
 * from ordinary purchases first (a lump-sum purchase must never be absorbed
 * into a SIP series — spec section 20 depends on that separation), and
 * within the confirmed set, distinct amount clusters that ALSO carry
 * distinct cadences become distinct series (spec section 40's Rs 5,000
 * monthly vs Rs 10,000 quarterly example).
 */
function partitionIntoMandates(txns: SipCandidateTransaction[]): Array<{ discriminator: string; members: SipCandidateTransaction[] }> {
  const confirmed = txns.filter(isSourceConfirmedSip);
  const others = txns.filter((t) => !isSourceConfirmedSip(t));
  const groups: Array<{ discriminator: string; members: SipCandidateTransaction[] }> = [];

  // Cluster the confirmed instalments by amount. Amounts within tolerance of
  // each other belong to the same mandate; a genuinely different instalment
  // size is a different mandate.
  if (confirmed.length > 0) {
    const clusters: SipCandidateTransaction[][] = [];
    for (const t of [...confirmed].sort((a, b) => a.grossAmount - b.grossAmount)) {
      const target = clusters.find((c) => {
        const m = median(c.map((x) => x.grossAmount));
        return m > 0 && Math.abs(t.grossAmount - m) / m <= AMOUNT_SIMILARITY_TOLERANCE;
      });
      if (target) target.push(t);
      else clusters.push([t]);
    }
    // A step-up SIP produces several adjacent clusters with a single shared
    // cadence. Merge clusters whose union still yields one consistent cadence
    // AND whose amounts move monotonically over time — that is a step-up, not
    // two mandates.
    const merged = mergeStepUpClusters(clusters);
    for (const c of merged) {
      const sorted = [...c].sort((a, b) => toUtc(a.transactionDate) - toUtc(b.transactionDate));
      groups.push({ discriminator: `sip-${Math.round(median(sorted.map((x) => x.grossAmount)))}`, members: sorted });
    }
  }

  // Non-confirmed purchases are analysed as their own potential series.
  if (others.length > 0) {
    groups.push({ discriminator: 'inferred', members: [...others].sort((a, b) => toUtc(a.transactionDate) - toUtc(b.transactionDate)) });
  }
  return groups;
}

function mergeStepUpClusters(clusters: SipCandidateTransaction[][]): SipCandidateTransaction[][] {
  if (clusters.length < 2) return clusters;
  const all = clusters.flat().sort((a, b) => toUtc(a.transactionDate) - toUtc(b.transactionDate));
  const intervals: number[] = [];
  for (let i = 1; i < all.length; i++) intervals.push(daysBetween(all[i - 1].transactionDate, all[i].transactionDate));
  const { cadence } = classifyCadence(intervals);
  const isPeriodic = cadence !== 'IRREGULAR' && cadence !== 'UNKNOWN';
  const trend = classifyTrend(all.map((t) => t.grossAmount));
  // Only a clean periodic series with a monotonic amount trajectory is
  // treated as one stepped mandate. Anything else stays split.
  if (isPeriodic && (trend === 'INCREASING' || trend === 'DECREASING')) return [all];
  return clusters;
}

function assessSeries(members: SipCandidateTransaction[]): Omit<SipSeries, 'seriesKey' | 'accountId' | 'instrumentId' | 'currencyCode'> {
  const sorted = [...members].sort((a, b) => toUtc(a.transactionDate) - toUtc(b.transactionDate));
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push(daysBetween(sorted[i - 1].transactionDate, sorted[i].transactionDate));
  const { cadence, periodsPerYear } = classifyCadence(intervals);
  const amounts = sorted.map((t) => t.grossAmount);
  const trend = classifyTrend(amounts);
  const sourceConfirmed = sorted.some(isSourceConfirmedSip);

  let confidence: SipConfidence;
  let rationale: string;

  if (sourceConfirmed) {
    confidence = 'CONFIRMED_SOURCE';
    rationale = 'The source statement explicitly records these instalments as SIP transactions.';
  } else if (sorted.length < MIN_CONTRIBUTIONS_FOR_INFERENCE) {
    // Two purchases a month apart are a coincidence, never an inferred SIP.
    confidence = sorted.length <= 1 ? 'NOT_SIP' : 'AMBIGUOUS';
    rationale = `Only ${sorted.length} purchase(s) recorded — at least ${MIN_CONTRIBUTIONS_FOR_INFERENCE} are required before a recurring pattern can be inferred. Not shown as a SIP.`;
  } else if (cadence === 'IRREGULAR' || cadence === 'UNKNOWN') {
    confidence = 'AMBIGUOUS';
    rationale = 'Several purchases were recorded but the intervals between them are not regular enough to identify a recurring mandate. Not shown as a confirmed SIP.';
  } else {
    const med = median(amounts);
    const amountsSimilar = med > 0 && amounts.every((a) => Math.abs(a - med) / med <= AMOUNT_SIMILARITY_TOLERANCE);
    const monotonicStepUp = trend === 'INCREASING' || trend === 'DECREASING';
    if (amountsSimilar || monotonicStepUp) {
      confidence = 'HIGH_CONFIDENCE';
      rationale = amountsSimilar
        ? `${sorted.length} purchases at a consistent ${cadence.toLowerCase()} interval and a stable amount. Identified as a recurring contribution series by pattern, not stated by the source statement.`
        : `${sorted.length} purchases at a consistent ${cadence.toLowerCase()} interval with a steadily ${trend === 'INCREASING' ? 'rising' : 'falling'} amount. Identified by pattern, not stated by the source statement.`;
    } else {
      confidence = 'POSSIBLE';
      rationale = `${sorted.length} purchases occur at a consistent ${cadence.toLowerCase()} interval, but the amounts vary in a way that does not match a single mandate. Treated as a possible recurring series only.`;
    }
  }

  return {
    contributions: sorted,
    cadence,
    periodsPerYear,
    confidence,
    confidenceRationale: rationale,
    trend,
    firstContributionDate: sorted[0]?.transactionDate ?? '',
    latestContributionDate: sorted[sorted.length - 1]?.transactionDate ?? '',
    detectionMethodVersion: SIP_DETECTION_METHOD_VERSION,
    thresholdConfigVersion: SIP_THRESHOLD_CONFIG_VERSION,
  };
}

/**
 * Detect all recurring-contribution series across a user's certified
 * transactions. Pure and deterministic: identical input always yields
 * identical output, including ordering.
 */
export function detectSipSeries(transactions: SipCandidateTransaction[]): SipSeries[] {
  const contributions = transactions.filter((t) => SERIES_MEMBER_TYPES.has(t.transactionType) || isSourceConfirmedSip(t));
  const byPair = new Map<string, SipCandidateTransaction[]>();
  for (const t of contributions) {
    const k = `${t.accountId}:${t.instrumentId}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k)!.push(t);
  }

  const out: SipSeries[] = [];
  for (const [pairKey, txns] of [...byPair.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [accountId, instrumentId] = pairKey.split(':');
    for (const group of partitionIntoMandates(txns)) {
      const assessed = assessSeries(group.members);
      out.push({
        seriesKey: buildSeriesKey(accountId, instrumentId, group.discriminator),
        accountId,
        instrumentId,
        currencyCode: group.members[0]?.currencyCode ?? '',
        ...assessed,
      });
    }
  }
  // Deterministic ordering by key.
  return out.sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));
}

/** Series that R5 is willing to present as recurring contributions at all. */
export function isPresentableSeries(series: SipSeries): boolean {
  return series.confidence === 'CONFIRMED_SOURCE' || series.confidence === 'HIGH_CONFIDENCE' || series.confidence === 'POSSIBLE';
}

export const __sipDetectionInternals = { median, daysBetween, partitionIntoMandates, CONTRIBUTION_TYPES };
