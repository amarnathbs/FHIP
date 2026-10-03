// Holding-period benchmark comparison (money-weighted). PURE: no I/O.
//
// WHAT THIS ANSWERS. "How did THIS investor's money do against the scheme's
// declared benchmark, over the investor's OWN holding period?" A fund held two
// years and the same fund held two months MUST NOT show the same comparison.
//
// METHOD (replication, then compare like with like):
//   1. The investor's real cash flows are replayed into the benchmark: every
//      purchase buys benchmark units on the SAME date for the SAME amount, every
//      redemption sells benchmark units on the SAME date for the SAME amount
//      (the same identical-cash-flow idea R5's SIP engine already uses for
//      contributions; this extends it to redemptions and to the whole holding).
//   2. The benchmark-equivalent ending value is those units x the benchmark
//      level at the as-of date.
//   3. Period = the investor's FIRST investment date -> the as-of date.
//        - one year or more : XIRR of the holding vs XIRR of the benchmark-
//                             equivalent flows (annualised, money-weighted).
//        - under one year   : NOT annualised. Absolute gain on money invested,
//                             both sides over exactly the same dates and
//                             amounts, labelled as such.
//   XIRR is the only annualised measure used.
//
// HONESTY (each rule has a named negative control in
// tests/unit/holdingBenchmarkComparison.test.ts). Whenever a number cannot be
// produced like-for-like the result is UNAVAILABLE with a reason and NO number:
//   - no mapping, or no mapping in force on the first investment date / as-of
//     date, or a gap/overlap inside the period;
//   - the benchmark's catalogue entry is not verified;
//   - no approved entitlement (the caller passes entitled=false / no series);
//   - a PRICE index where total return is required (never substituted);
//   - benchmark history starts after the first investment date, or stops more
//     than the alignment window before the as-of date (never extrapolated);
//   - a benchmark CHANGE inside the period is replayed segment by segment (the
//     benchmark in force for each portion); it needs both series to cover the
//     change date, otherwise unavailable;
//   - a redemption larger than the benchmark-equivalent holding (the replay
//     would need negative units);
//   - transactions dated after the valuation date.
// The entitlement gates (storage/calculation/display/export) are NOT decided
// here: the caller passes only series the central gate already allowed.

import { xirr, XIRR_METHOD_VERSION, type CashFlow } from './xirr';
import { formatDateShort } from '@/lib/engines/date';
import {
  MAX_BACKWARD_SEARCH_DAYS,
  resolveObservationAsOf,
  resolveObservationOnOrAfter,
  sortSeries,
  type Observation,
} from './sip/dateAlignment';
import type { SeriesPoint } from './benchmarkService';
import { categoryReferenceBasisLabel, DECLARED_BENCHMARK_LABEL } from '@/lib/services/investment-intelligence/benchmarkData/categoryReference';

export const HOLDING_BENCHMARK_COMPARISON_VERSION = 'holding-benchmark-replication-v1';
export const BENCHMARK_UNAVAILABLE_TITLE = 'Benchmark data not available';

export type SegmentReturnType = 'TRI' | 'PRI' | 'DEBT_INDEX' | 'COMMODITY_GOLD' | 'OTHER';

export type BenchmarkBasis = 'declared' | 'category_reference';

/** "Fund's declared benchmark" or "Compared with the usual benchmark for <category> funds (not this fund's own declared benchmark)". */
export function benchmarkBasisLabel(basis: BenchmarkBasis, categoryLabel?: string | null): string {
  return basis === 'category_reference' && categoryLabel ? categoryReferenceBasisLabel(categoryLabel) : DECLARED_BENCHMARK_LABEL;
}

export interface BenchmarkSegmentInput {
  /** 'declared' (default) or 'category_reference'. A category reference is never mixed with a declared mapping. */
  basis?: BenchmarkBasis;
  categoryLabel?: string | null;
  benchmarkId: string;
  benchmarkKey: string;
  label: string;
  returnType: SegmentReturnType;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** ii_benchmarks.catalogue_status === 'verified'. Anything else = not available. */
  catalogueVerified: boolean;
  /** The central entitlement gate allowed calculation AND customer display. */
  entitled: boolean;
  /** User-facing reason when not entitled (benchmarkAccess.blockedReason). */
  entitlementDetail?: string;
  /** Already entitlement-gated and clamped to the entitled data scope by the loader. */
  series: SeriesPoint[];
}

export interface HoldingComparisonInput {
  /** Investor-perspective flows EXCLUDING the terminal valuation: purchases negative, redemptions positive. */
  flows: CashFlow[];
  /** Current value of the holding (>= 0), at asOfDate. */
  terminalValue: number;
  asOfDate: Date;
  /** Drives day-first date text: INR dd-mm-yyyy, anything else dd/mm/yyyy. */
  currencyCode: string;
  /** Effective-dated PRIMARY mappings of this scheme, each with its series and gates. */
  segments: readonly BenchmarkSegmentInput[];
}

export type ComparisonUnavailableReason =
  | 'NO_PURCHASE_FLOWS'
  | 'FLOWS_AFTER_VALUATION'
  | 'PERIOD_NOT_STARTED'
  | 'INVALID_TERMINAL_VALUE'
  | 'NO_MAPPING'
  | 'NO_MAPPING_FOR_START'
  | 'NO_MAPPING_FOR_END'
  | 'MAPPING_GAP'
  | 'MAPPING_OVERLAP'
  | 'NOT_ENTITLED'
  | 'CATALOGUE_NOT_VERIFIED'
  | 'PRICE_INDEX_NOT_TOTAL_RETURN'
  | 'UNKNOWN_RETURN_TYPE'
  | 'NO_SERIES'
  | 'HISTORY_STARTS_AFTER_INVESTMENT'
  | 'HISTORY_ENDS_BEFORE_VALUATION'
  | 'HISTORY_GAP'
  | 'REPLICATION_NEEDS_NEGATIVE_UNITS'
  | 'XIRR_UNAVAILABLE';

export interface ComparisonUnavailable {
  status: 'unavailable';
  reason: ComparisonUnavailableReason;
  title: typeof BENCHMARK_UNAVAILABLE_TITLE;
  /** One plain sentence saying why. No number accompanies it. */
  detail: string;
  /** Present whenever the period itself is known, so the screen can still state it. */
  periodLabel?: string;
  /** The benchmark's NAME and what it is (declared or category reference), shown even though no figure is: a user sees the name, not a number. */
  benchmarkLabel?: string;
  benchmarkBasis?: BenchmarkBasis;
  benchmarkBasisLabel?: string;
  method: typeof HOLDING_BENCHMARK_COMPARISON_VERSION;
}

export interface ComparisonOk {
  status: 'ok';
  basis: 'annualised_xirr' | 'absolute_not_annualised';
  basisLabel: string;
  /** "Since 12-03-2025, 1 year 6 months" */
  periodLabel: string;
  windowStart: string; // ISO yyyy-mm-dd (data; never shown raw)
  windowEnd: string;
  holdingReturn: number;
  benchmarkReturn: number;
  /** What the same purchases and sales would be worth today in the benchmark (transparency; also what the tests pin). */
  benchmarkEndingValue: number;
  /** holdingReturn - benchmarkReturn, same measure on both sides. */
  difference: number;
  benchmarkKey: string;
  benchmarkLabel: string;
  /** 'declared' or 'category_reference'; benchmarkBasisLabel is the sentence that must accompany the figure. */
  benchmarkBasis: BenchmarkBasis;
  benchmarkBasisLabel: string;
  returnType: SegmentReturnType;
  /** Benchmarks in force over the period, in order (more than one = the benchmark changed inside the period). */
  segmentsUsed: Array<{ benchmarkKey: string; label: string; from: string; to: string }>;
  notes: string[];
  method: typeof HOLDING_BENCHMARK_COMPARISON_VERSION;
  xirrMethod: typeof XIRR_METHOD_VERSION;
}

export type HoldingBenchmarkComparison = ComparisonOk | ComparisonUnavailable;

// ---------------------------------------------------------------------------
// Date helpers (UTC, day-first display)
// ---------------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const dayMs = 86_400_000;
const toUtc = (s: string): number => Date.parse(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number): string => new Date(toUtc(s) + n * dayMs).toISOString().slice(0, 10);
const fmtKey = (currencyCode: string): 'INR' | 'AUD' => ((currencyCode ?? '').toUpperCase() === 'INR' ? 'INR' : 'AUD');
const showDate = (isoDate: string, currencyCode: string): string => formatDateShort(isoDate, fmtKey(currencyCode));

/** Whole calendar months between two ISO dates (end exclusive of a part month). */
function wholeMonths(startIso: string, endIso: string): number {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ey, em, ed] = endIso.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm) - (ed < sd ? 1 : 0);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "1 year 6 months", "2 years", "3 months", "23 days". Whole months only; days only when under a month. */
export function describeDuration(startIso: string, endIso: string): string {
  const months = wholeMonths(startIso, endIso);
  if (months <= 0) {
    const days = Math.max(0, Math.round((toUtc(endIso) - toUtc(startIso)) / dayMs));
    return plural(days, 'day');
  }
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(plural(years, 'year'));
  if (rem > 0) parts.push(plural(rem, 'month'));
  return parts.join(' ');
}

/** "Since 12-03-2025, 1 year 6 months" (INR) / "Since 12/03/2025, ..." (otherwise). */
export function holdingPeriodLabel(startIso: string, endIso: string, currencyCode: string): string {
  return `Since ${showDate(startIso, currencyCode)}, ${describeDuration(startIso, endIso)}`;
}

/** True when the holding period is shorter than one calendar year (so it is NOT annualised). */
export function isUnderOneYear(startIso: string, endIso: string): boolean {
  return wholeMonths(startIso, endIso) < 12;
}

// ---------------------------------------------------------------------------
// Splitting a scheme dataset's flows
// ---------------------------------------------------------------------------

/**
 * The analytics datasets carry the real flows PLUS one synthetic terminal flow
 * (current value, positive, on the valuation date). Remove exactly that one by
 * its own (date, amount) identity so the comparison replays only real money.
 */
export function splitTerminalFlow(cashFlows: readonly CashFlow[], currentValue: number, currentValueDate: Date): { flows: CashFlow[]; terminalValue: number } {
  if (!(currentValue > 0)) return { flows: [...cashFlows], terminalValue: 0 };
  let removed = false;
  const flows: CashFlow[] = [];
  for (let i = cashFlows.length - 1; i >= 0; i--) {
    const cf = cashFlows[i];
    if (!removed && cf.amount === currentValue && cf.date.getTime() === currentValueDate.getTime()) {
      removed = true;
      continue;
    }
    flows.push(cf);
  }
  flows.reverse();
  return { flows, terminalValue: currentValue };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function unavailable(reason: ComparisonUnavailableReason, detail: string, periodLabel?: string): ComparisonUnavailable {
  return { status: 'unavailable', reason, title: BENCHMARK_UNAVAILABLE_TITLE, detail, ...(periodLabel ? { periodLabel } : {}), method: HOLDING_BENCHMARK_COMPARISON_VERSION };
}

/** For a caller that must withhold the comparison for its own reason (e.g. an unresolved data-quality state). */
export function withheldComparison(reason: ComparisonUnavailableReason, detail: string): ComparisonUnavailable {
  return unavailable(reason, detail);
}

interface PreparedSegment {
  input: BenchmarkSegmentInput;
  from: string;
  to: string | null;
  obs: Observation[];
}

type LevelResult = { ok: true; value: number } | { ok: false; reason: ComparisonUnavailableReason; detail: string };

/** Level at which a PURCHASE or SALE on `date` executes: first observation on/after the date (R5 rule), never before the series begins. */
function executionLevel(seg: PreparedSegment, date: string, currencyCode: string): LevelResult {
  const first = seg.obs[0];
  if (!first) return { ok: false, reason: 'NO_SERIES', detail: `${seg.input.label} has no published levels.` };
  if (date < first.date) {
    return {
      ok: false,
      reason: 'HISTORY_STARTS_AFTER_INVESTMENT',
      detail: `Benchmark history does not go back to your investment date: ${seg.input.label} levels start on ${showDate(first.date, currencyCode)}, after your transaction on ${showDate(date, currencyCode)}.`,
    };
  }
  const r = resolveObservationOnOrAfter(seg.obs, date);
  if (r.status !== 'ok' || !r.observation || !(r.observation.value > 0)) {
    return { ok: false, reason: 'HISTORY_GAP', detail: `${seg.input.label} has no published level within ${MAX_BACKWARD_SEARCH_DAYS} days of ${showDate(date, currencyCode)}, so the comparison would not be like-for-like.` };
  }
  return { ok: true, value: r.observation.value };
}

/** Level used to VALUE a position on `date`: last observation on/before the date (never forward). */
function valuationLevel(seg: PreparedSegment, date: string, currencyCode: string, what: 'valuation' | 'change'): LevelResult {
  const last = seg.obs[seg.obs.length - 1];
  if (!last) return { ok: false, reason: 'NO_SERIES', detail: `${seg.input.label} has no published levels.` };
  if (seg.obs[0].date > date) {
    return { ok: false, reason: 'HISTORY_STARTS_AFTER_INVESTMENT', detail: `Benchmark history does not go back to your investment date: ${seg.input.label} levels start on ${showDate(seg.obs[0].date, currencyCode)}.` };
  }
  const r = resolveObservationAsOf(seg.obs, date);
  if (r.status !== 'ok' || !r.observation || !(r.observation.value > 0)) {
    return {
      ok: false,
      reason: what === 'valuation' ? 'HISTORY_ENDS_BEFORE_VALUATION' : 'HISTORY_GAP',
      detail:
        what === 'valuation'
          ? `${seg.input.label} levels are only published up to ${showDate(last.date, currencyCode)}, before your valuation date ${showDate(date, currencyCode)}; the comparison is not extended past the data.`
          : `${seg.input.label} has no published level near ${showDate(date, currencyCode)}, the date its benchmark changed.`,
    };
  }
  return { ok: true, value: r.observation.value };
}

/**
 * The comparison. When it cannot produce a figure it still says WHICH benchmark it would have used and
 * whether that is the fund's declared benchmark or the category reference, so a user sees the name and the
 * honest label even where there is no number.
 */
/** A declared mapping ALWAYS wins: when any declared segment exists, category-reference segments are dropped. */
export function declaredWins(segments: readonly BenchmarkSegmentInput[]): BenchmarkSegmentInput[] {
  const hasDeclared = segments.some((s) => (s.basis ?? 'declared') === 'declared');
  return segments.filter((s) => !hasDeclared || (s.basis ?? 'declared') === 'declared');
}

export function compareHoldingToBenchmark(rawInput: HoldingComparisonInput): HoldingBenchmarkComparison {
  const input: HoldingComparisonInput = { ...rawInput, segments: declaredWins(rawInput.segments) };
  const r = compareInner(input);
  if (r.status === 'ok') return r;
  const asOf = iso(input.asOfDate);
  const sorted = [...input.segments].sort((a, b) => iso(a.effectiveFrom).localeCompare(iso(b.effectiveFrom)));
  const seg = [...sorted].reverse().find((s) => iso(s.effectiveFrom) <= asOf) ?? sorted[0];
  if (!seg) return r;
  const basis: BenchmarkBasis = seg.basis ?? 'declared';
  return { ...r, benchmarkLabel: seg.label, benchmarkBasis: basis, benchmarkBasisLabel: benchmarkBasisLabel(basis, seg.categoryLabel) };
}

function compareInner(input: HoldingComparisonInput): HoldingBenchmarkComparison {
  const { currencyCode } = input;
  const flows = [...input.flows].filter((f) => Number.isFinite(f.amount) && f.amount !== 0).sort((a, b) => a.date.getTime() - b.date.getTime());
  const asOf = iso(input.asOfDate);

  if (!flows.some((f) => f.amount < 0)) return unavailable('NO_PURCHASE_FLOWS', 'There is no recorded purchase to start a holding period from.');
  const start = iso(flows[0].date);
  const periodLabel = holdingPeriodLabel(start, asOf, currencyCode);
  if (!Number.isFinite(input.terminalValue) || input.terminalValue < 0) return unavailable('INVALID_TERMINAL_VALUE', 'The current value of the holding is not available.', periodLabel);
  if (flows.some((f) => iso(f.date) > asOf)) {
    return unavailable('FLOWS_AFTER_VALUATION', `Transactions are recorded after the valuation date ${showDate(asOf, currencyCode)}. Upload a more recent statement so the comparison can include them.`, periodLabel);
  }
  if (asOf <= start) return unavailable('PERIOD_NOT_STARTED', 'The holding period has not started yet (first investment and valuation fall on the same day).', periodLabel);

  // ---- mapping segments in force over [start, asOf] ----------------------
  const all = [...input.segments].sort((a, b) => iso(a.effectiveFrom).localeCompare(iso(b.effectiveFrom)));
  if (all.length === 0) return unavailable('NO_MAPPING', 'No approved benchmark is mapped to this scheme yet.', periodLabel);
  const overlaps = (s: BenchmarkSegmentInput) => iso(s.effectiveFrom) <= asOf && (s.effectiveTo === null || iso(s.effectiveTo) >= start);
  const inPeriod = all.filter(overlaps);
  const earliestFrom = iso(all[0].effectiveFrom);
  if (inPeriod.length === 0 || iso(inPeriod[0].effectiveFrom) > start) {
    return unavailable(
      'NO_MAPPING_FOR_START',
      `No approved benchmark is in force on your first investment date ${showDate(start, currencyCode)}${earliestFrom > start ? ` (the earliest mapping starts ${showDate(earliestFrom, currencyCode)})` : ''}.`,
      periodLabel
    );
  }
  for (let i = 0; i + 1 < inPeriod.length; i++) {
    const a = inPeriod[i];
    const b = inPeriod[i + 1];
    const aTo = a.effectiveTo === null ? null : iso(a.effectiveTo);
    if (aTo === null || aTo >= iso(b.effectiveFrom)) {
      return unavailable('MAPPING_OVERLAP', `Two benchmarks are recorded as in force at the same time for this scheme (from ${showDate(iso(b.effectiveFrom), currencyCode)}); a reviewer has to correct the mapping dates.`, periodLabel);
    }
    if (addDays(aTo, 1) < iso(b.effectiveFrom)) {
      return unavailable('MAPPING_GAP', `There is a gap in this scheme's benchmark mapping between ${showDate(aTo, currencyCode)} and ${showDate(iso(b.effectiveFrom), currencyCode)}, inside your holding period.`, periodLabel);
    }
  }
  const lastSeg = inPeriod[inPeriod.length - 1];
  if (lastSeg.effectiveTo !== null && iso(lastSeg.effectiveTo) < asOf) {
    return unavailable('NO_MAPPING_FOR_END', `The scheme's last approved benchmark mapping ended on ${showDate(iso(lastSeg.effectiveTo), currencyCode)}, before the valuation date ${showDate(asOf, currencyCode)}.`, periodLabel);
  }

  // ---- gates, per segment actually used ----------------------------------
  for (const s of inPeriod) {
    if (!s.entitled) return unavailable('NOT_ENTITLED', s.entitlementDetail ?? `${s.label}: no approved entitlement covers this benchmark, so no comparison is shown.`, periodLabel);
    if (!s.catalogueVerified) return unavailable('CATALOGUE_NOT_VERIFIED', `${s.label}: the benchmark's catalogue entry has not been verified yet.`, periodLabel);
    if (s.returnType === 'PRI') return unavailable('PRICE_INDEX_NOT_TOTAL_RETURN', `${s.label} is a price index (it leaves out dividends), so it is not used where a total-return benchmark is required.`, periodLabel);
    if (s.returnType === 'OTHER') return unavailable('UNKNOWN_RETURN_TYPE', `${s.label}: it is not recorded whether this series is total return, so it is not used.`, periodLabel);
    if (s.series.length === 0) return unavailable('NO_SERIES', `${s.label}: no published levels are available.`, periodLabel);
  }

  const prepared: PreparedSegment[] = inPeriod.map((s) => ({
    input: s,
    from: iso(s.effectiveFrom),
    to: s.effectiveTo === null ? null : iso(s.effectiveTo),
    obs: sortSeries(s.series.map((p) => ({ date: iso(p.date), value: p.value }))),
  }));
  const segmentFor = (date: string): PreparedSegment | undefined => prepared.find((p) => p.from <= date && (p.to === null || p.to >= date));

  // ---- replicate the investor's flows into the benchmark -----------------
  type Event = { date: string; kind: 'change' | 'flow'; flow?: CashFlow; toIdx?: number };
  const events: Event[] = [];
  for (let i = 1; i < prepared.length; i++) events.push({ date: prepared[i].from, kind: 'change', toIdx: i });
  for (const f of flows) events.push({ date: iso(f.date), kind: 'flow', flow: f });
  // A change takes effect before any flow on the same date (that flow is in the NEW segment).
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'change' ? -1 : 1));

  let units = 0;
  let curIdx = 0;
  for (const ev of events) {
    if (ev.kind === 'change') {
      const from = prepared[curIdx];
      const to = prepared[ev.toIdx!];
      const lvA = valuationLevel(from, ev.date, currencyCode, 'change');
      if (!lvA.ok) return unavailable(lvA.reason, lvA.detail, periodLabel);
      const lvB = valuationLevel(to, ev.date, currencyCode, 'change');
      if (!lvB.ok) return unavailable(lvB.reason, lvB.detail, periodLabel);
      units = (units * lvA.value) / lvB.value;
      curIdx = ev.toIdx!;
      continue;
    }
    const seg = segmentFor(ev.date) ?? prepared[curIdx];
    const lv = executionLevel(seg, ev.date, currencyCode);
    if (!lv.ok) return unavailable(lv.reason, lv.detail, periodLabel);
    const amt = ev.flow!.amount;
    // A purchase (amt < 0) buys |amt| / level units; a redemption (amt > 0) sells amt / level units.
    units += -amt / lv.value;
    if (units < -1e-9) {
      return unavailable('REPLICATION_NEEDS_NEGATIVE_UNITS', `Your redemption on ${showDate(ev.date, currencyCode)} is larger than the same money would have been worth in ${seg.input.label}, so a like-for-like benchmark comparison cannot be built.`, periodLabel);
    }
  }
  const term = valuationLevel(prepared[prepared.length - 1], asOf, currencyCode, 'valuation');
  if (!term.ok) return unavailable(term.reason, term.detail, periodLabel);
  const benchTerminal = Math.max(0, units) * term.value;

  const segmentsUsed = prepared.map((p) => ({
    benchmarkKey: p.input.benchmarkKey,
    label: p.input.label,
    from: p.from < start ? start : p.from,
    to: p.to === null || p.to > asOf ? asOf : p.to,
  }));
  const notes: string[] = [];
  if (prepared.length > 1) {
    notes.push(`The scheme's benchmark changed during your holding period (${prepared.map((p) => `${p.input.label} from ${showDate(p.from < start ? start : p.from, currencyCode)}`).join(', then ')}). Each portion is compared with the benchmark in force at the time.`);
  }
  const first = prepared[0].input;
  const base = {
    periodLabel,
    windowStart: start,
    windowEnd: asOf,
    benchmarkKey: prepared.length === 1 ? first.benchmarkKey : prepared.map((p) => p.input.benchmarkKey).join(' > '),
    benchmarkLabel: prepared.length === 1 ? first.label : prepared.map((p) => p.input.label).join(', then '),
    benchmarkBasis: (first.basis ?? 'declared') as BenchmarkBasis,
    benchmarkBasisLabel: benchmarkBasisLabel(first.basis ?? 'declared', first.categoryLabel),
    returnType: first.returnType,
    segmentsUsed,
    notes,
    method: HOLDING_BENCHMARK_COMPARISON_VERSION,
    xirrMethod: XIRR_METHOD_VERSION,
  } as const;

  // ---- under one year: absolute, not annualised --------------------------
  if (isUnderOneYear(start, asOf)) {
    const invested = flows.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0);
    const received = flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
    if (!(invested > 0)) return unavailable('NO_PURCHASE_FLOWS', 'There is no recorded purchase amount to measure a gain against.', periodLabel);
    const holdingReturn = (received + input.terminalValue) / invested - 1;
    const benchmarkReturn = (received + benchTerminal) / invested - 1;
    return {
      status: 'ok',
      basis: 'absolute_not_annualised',
      basisLabel: 'Less than a year, not annualised',
      holdingReturn,
      benchmarkReturn,
      benchmarkEndingValue: benchTerminal,
      difference: holdingReturn - benchmarkReturn,
      ...base,
    };
  }

  // ---- one year or more: XIRR vs XIRR on identical flows -----------------
  const holdingFlows: CashFlow[] = [...flows];
  if (input.terminalValue > 0) holdingFlows.push({ date: input.asOfDate, amount: input.terminalValue });
  const benchFlows: CashFlow[] = [...flows];
  if (benchTerminal > 1e-9) benchFlows.push({ date: input.asOfDate, amount: benchTerminal });
  const h = xirr(holdingFlows);
  if (h.status !== 'ok' || h.rate === undefined) return unavailable('XIRR_UNAVAILABLE', `A money-weighted return could not be solved for this holding (${h.reason ?? 'unknown'}), so no comparison is shown.`, periodLabel);
  const b = xirr(benchFlows);
  if (b.status !== 'ok' || b.rate === undefined) return unavailable('XIRR_UNAVAILABLE', `A money-weighted return could not be solved for the benchmark on the same flows (${b.reason ?? 'unknown'}), so no comparison is shown.`, periodLabel);
  return {
    status: 'ok',
    basis: 'annualised_xirr',
    basisLabel: 'Annualised, money-weighted (XIRR) on your own purchases and sales',
    holdingReturn: h.rate,
    benchmarkReturn: b.rate,
    benchmarkEndingValue: benchTerminal,
    difference: h.rate - b.rate,
    ...base,
  };
}
