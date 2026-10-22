// Document2 (4) F10, F11, F12 -- what the Fund analytics SCREEN says that the saved report model already knows. Pure (no React, no I/O).
//
//   F10  the one-page summary ("Your funds at a glance") the PDF opens with was never rendered on the screen. ONE builder, used by the screen
//        and by the print document, so they cannot disagree.
//   F11  "What do you need for this to show": a figure that cannot be shown says WHICH prerequisite is missing (which fund, which category,
//        plan and option, which horizon), not just "Not applicable".
//   F12  the two-fund comparison: validation (the same fund twice), common-date alignment, the minimum number of observations, the coverage
//        actually used, a reason when it cannot be calculated, and the two funds side by side.
//
// Nothing here recalculates a figure: every number comes from the stored report (showResult()), so an unavailable result is still its fixed
// headline, never a number.

import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import type { FundAnalyticsReport, FundAnalyticsSchemeBlock } from './fundAnalyticsReport';
import { pct, rupees, showResult, type ShownCell } from './presentation';
import type { CorrelationValue } from './schemeRisk';
import { showDate, type Nav2Context, type Nav2Result } from './types';

// ---------------------------------------------------------------------------------------------------------------------------------------
// F10: the one-page summary
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface FundSummaryRow {
  instrumentId: string;
  /** The fund name, with the ownership share where the fund is held jointly (the same wording the PDF uses). */
  name: string;
  valueNow: ShownCell | null;
  gainLoss: ShownCell | null;
  xirr: ShownCell | null;
  cagr3Year: ShownCell | null;
}

export const FUND_SUMMARY_HEAD = ['Fund', 'Value now', 'Gain or loss', 'Your return (XIRR)', 'Fund CAGR, 3 year'] as const;

/** The summary row of every fund in the report, in report order. The screen and the print document both render exactly this. */
export function buildFundAnalyticsSummary(report: Pick<FundAnalyticsReport, 'schemes'>, shareLabel: (basisPoints: number) => string): FundSummaryRow[] {
  return report.schemes.map((b) => {
    const inv = b.analytics.investor;
    const three = b.analytics.scheme.pointToPoint.find((p) => p.id === '3Y');
    const share =
      b.ownership?.mode === 'share' && b.ownership.jointBasisPoints !== null ? ` (your share ${shareLabel(b.ownership.jointBasisPoints)})` : b.ownership?.mode === 'not_set' ? ' (ownership share not set)' : '';
    return {
      instrumentId: b.instrumentId,
      name: `${b.schemeName}${share}`,
      valueNow: inv ? showResult(inv.currentValue, (v) => rupees(v.value)) : null,
      gainLoss: inv ? showResult(inv.gainLoss, (v) => rupees(v.gainLoss)) : null,
      xirr: inv ? showResult(inv.xirr, (v) => pct(v.rate)) : null,
      cagr3Year: three ? showResult(three.cagr, (v) => pct(v.cagr)) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// F11: name the missing prerequisite
// ---------------------------------------------------------------------------------------------------------------------------------------

const words = (s: string | null): string => (s ? s.replace(/_/g, ' ') : '');

/** "Large Cap fund, Regular plan, Growth option" -- only the parts that are known. */
export function describeFundKind(b: Pick<FundAnalyticsSchemeBlock, 'categoryLabel' | 'planType' | 'optionType'>): string {
  const parts = [
    b.categoryLabel ? `${b.categoryLabel} fund` : null,
    b.planType && b.planType !== 'not_applicable' ? `${words(b.planType)} plan` : null,
    b.optionType && b.optionType !== 'not_applicable' ? `${words(b.optionType)} option` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'fund';
}

/**
 * Why no ranking is shown for a horizon, and what would make it show: one plain sentence per fund that is the reason. Empty when the
 * ranking has at least one comparable group (then only the funds left out are named, by the caller's own "not comparable" lines).
 */
export function rankingPrerequisites(report: Pick<FundAnalyticsReport, 'schemes' | 'comparison'>, horizonId: string): string[] {
  const horizon = horizonId.replace('Y', ' year');
  const ranking = report.comparison.rankings.find((r) => r.horizonId === horizonId);
  if (!ranking || ranking.result.state === 'available') return [];
  const lines: string[] = [];
  const key = (b: FundAnalyticsSchemeBlock) => JSON.stringify([b.categoryLabel, b.planType, b.optionType]);
  const withFigure = report.schemes.filter((b) => {
    const cg = b.analytics.scheme.pointToPoint.find((p) => p.id === horizonId)?.cagr;
    return cg?.state === 'available';
  });
  for (const b of report.schemes) {
    const cg = b.analytics.scheme.pointToPoint.find((p) => p.id === horizonId)?.cagr;
    if (!cg || cg.state !== 'available') {
      const why = cg && cg.detail ? ` (${cg.detail.replace(/\.$/, '')})` : '';
      lines.push(`${b.schemeName}: it has no ${horizon} CAGR yet, so it cannot be ranked. It needs price history reaching back ${horizon === '1 year' ? 'one year' : horizon} before the report date${why}.`);
      continue;
    }
    if (!b.categoryLabel) {
      lines.push(`${b.schemeName}: its fund category is not known yet, so it cannot be placed beside other funds. It needs its category recorded (it is read from the scheme master or the statement heading).`);
      continue;
    }
    const peers = withFigure.filter((o) => o.instrumentId !== b.instrumentId && key(o) === key(b));
    if (peers.length === 0) {
      lines.push(`${b.schemeName}: to rank it you would need to hold another ${describeFundKind(b)} that also has a ${horizon} figure. It is the only one of its kind among your funds that has one.`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// F12: the two-fund comparison
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface PickerOption {
  value: string;
  label: string;
}

/**
 * The funds offered in the two pickers: each fund ONCE (a report that lists the same fund twice must not offer it twice, or "two different
 * funds" could be the same fund under two rows), and two different funds that print the same name are told apart by their kind.
 */
export function comparisonPickerOptions(report: Pick<FundAnalyticsReport, 'schemes'>): PickerOption[] {
  const seen = new Set<string>();
  const unique = report.schemes.filter((b) => (seen.has(b.instrumentId) ? false : (seen.add(b.instrumentId), true)));
  const counts = new Map<string, number>();
  for (const b of unique) counts.set(b.schemeName, (counts.get(b.schemeName) ?? 0) + 1);
  return unique.map((b) => ({ value: b.instrumentId, label: (counts.get(b.schemeName) ?? 0) > 1 ? `${b.schemeName} (${describeFundKind(b)})` : b.schemeName }));
}

/** The default pair offered: the first two DIFFERENT funds. */
export function defaultComparisonPair(options: readonly PickerOption[]): [string, string] {
  return [options[0]?.value ?? '', options[1]?.value ?? ''];
}

export interface FundSideBySideRow {
  label: string;
  a: ShownCell;
  b: ShownCell;
}

export type FundComparison =
  | { status: 'invalid'; reason: 'same_fund' | 'unknown_fund' | 'fewer_than_two_funds'; message: string }
  | { status: 'unavailable'; message: string; headline: string; whatToDo: string; rows: FundSideBySideRow[]; fundA: string; fundB: string }
  | {
      status: 'ok';
      fundA: string;
      fundB: string;
      correlation: number;
      /** A plain sentence for the number. */
      reading: string;
      commonReturnCount: number;
      windowStart: string;
      windowEnd: string;
      frequency: string;
      /** The fewest returns the policy accepts, and the count above which the figure needs no caution. */
      minimumReturns: number;
      preferredReturns: number;
      /** Each fund's own price history, so the overlap can be read against it. */
      historyA: { first: string | null; last: string | null };
      historyB: { first: string | null; last: string | null };
      cautions: string[];
      rows: FundSideBySideRow[];
    };

const NO_DATE_CTX = (report: Pick<FundAnalyticsReport, 'displayCurrency'>): Nav2Context => ({ policy: NAV2_POLICY, currency: report.displayCurrency });

function sideBySide(a: FundAnalyticsSchemeBlock, b: FundAnalyticsSchemeBlock): FundSideBySideRow[] {
  const cagr = (x: FundAnalyticsSchemeBlock, id: string): ShownCell => {
    const p = x.analytics.scheme.pointToPoint.find((q) => q.id === id);
    return p ? showResult(p.cagr, (v) => pct(v.cagr)) : showResult(null, () => '');
  };
  const inv = (x: FundAnalyticsSchemeBlock, pick: 'xirr' | 'currentValue'): ShownCell => {
    const i = x.analytics.investor;
    if (!i) return { available: false, text: 'Not available', headline: 'Your transactions are not matched to this fund', detail: null, notes: [], noteCodes: [] };
    return pick === 'xirr' ? showResult(i.xirr, (v) => pct(v.rate)) : showResult(i.currentValue, (v) => rupees(v.value));
  };
  return [
    { label: 'Fund CAGR, 1 year', a: cagr(a, '1Y'), b: cagr(b, '1Y') },
    { label: 'Fund CAGR, 3 year', a: cagr(a, '3Y'), b: cagr(b, '3Y') },
    { label: 'Fund CAGR, 5 year', a: cagr(a, '5Y'), b: cagr(b, '5Y') },
    { label: 'Volatility (annualised)', a: showResult(a.analytics.scheme.volatility, (v) => pct(v.annualisedVolatility)), b: showResult(b.analytics.scheme.volatility, (v) => pct(v.annualisedVolatility)) },
    { label: 'Maximum drawdown', a: showResult(a.analytics.scheme.maxDrawdown, (v) => pct(v.maxDrawdown)), b: showResult(b.analytics.scheme.maxDrawdown, (v) => pct(v.maxDrawdown)) },
    { label: 'Your return (XIRR)', a: inv(a, 'xirr'), b: inv(b, 'xirr') },
    { label: 'Value now', a: inv(a, 'currentValue'), b: inv(b, 'currentValue') },
  ];
}

const readCorrelation = (rho: number): string => {
  const abs = Math.abs(rho);
  const strength = abs >= 0.8 ? 'very closely' : abs >= 0.5 ? 'fairly closely' : abs >= 0.2 ? 'only loosely' : 'hardly at all';
  return rho < -0.2 ? `The two funds tended to move in opposite directions (${strength}).` : rho < 0.2 ? 'The two funds were hardly related in how they moved.' : `The two funds rose and fell together ${strength}.`;
};

/**
 * The comparison of two of the report's funds, from the stored report only. Never recalculates and never invents a number.
 *  - the same fund twice, an unknown fund, or fewer than two funds is `invalid` with the sentence to show;
 *  - a pair with no stored result, or one the engine could not work out, is `unavailable` with the engine's reason and what would fix it;
 *  - otherwise `ok` with the correlation, the common-date window, the number of returns used against the minimum, and the caution (if any).
 */
export function compareTwoFunds(report: FundAnalyticsReport, aId: string, bId: string): FundComparison {
  const ctx = NO_DATE_CTX(report);
  const options = comparisonPickerOptions(report);
  if (options.length < 2) return { status: 'invalid', reason: 'fewer_than_two_funds', message: 'You need at least two different funds in this report to compare how they move together.' };
  const a = report.schemes.find((s) => s.instrumentId === aId);
  const b = report.schemes.find((s) => s.instrumentId === bId);
  if (!a || !b) return { status: 'invalid', reason: 'unknown_fund', message: 'Choose a first and a second fund from the lists.' };
  if (aId === bId) return { status: 'invalid', reason: 'same_fund', message: 'Pick two different funds. A fund always moves exactly with itself, so comparing it with itself tells you nothing.' };

  const rows = sideBySide(a, b);
  const min = NAV2_POLICY.minimums.correlationReturns;
  const preferred = NAV2_POLICY.minimums.correlationDisclosureBelowReturns;
  const pair = report.comparison.correlations.find((x) => (x.aInstrumentId === aId && x.bInstrumentId === bId) || (x.aInstrumentId === bId && x.bInstrumentId === aId));
  const base = { rows, fundA: a.schemeName, fundB: b.schemeName };
  if (report.comparison.correlationsSkippedReason) {
    return { status: 'unavailable', ...base, headline: 'Not calculated for a report this large', message: report.comparison.correlationsSkippedReason, whatToDo: 'Generate a report that covers fewer funds (choose the funds you want to compare) and this pair will be worked out.' };
  }
  if (!pair) {
    return {
      status: 'unavailable',
      ...base,
      headline: 'Not in this saved report',
      message: 'This saved version of the report did not work out this pair of funds.',
      whatToDo: 'Generate a new version of the report; every pair of the funds it covers is then calculated.',
    };
  }
  const r = pair.result as Nav2Result<CorrelationValue>;
  if (r.state !== 'available') {
    const cell = showResult(r, () => '');
    const tooFew = /At least \d+ returns/i.test(r.detail ?? '');
    return {
      status: 'unavailable',
      ...base,
      headline: cell.headline ?? 'Not calculated',
      message: r.detail ?? 'The correlation could not be worked out for this pair.',
      whatToDo: tooFew
        ? `The two funds need at least ${min} returns on dates both have prices for. Choose a longer period for the report (for example "Since you first held each fund"), or wait until both funds have more price history.`
        : r.state === 'insufficient_history' || r.state === 'history_hydrating'
          ? 'Price history for one of the funds is still being prepared or does not reach far enough back. Generate a new version of the report once it has loaded.'
          : 'See the explanation above; nothing has been estimated in its place.',
    };
  }
  const v = r.value;
  const cautions: string[] = [];
  if (v.commonReturnCount < preferred) cautions.push(`Only ${v.commonReturnCount.toLocaleString('en-IN')} returns are shared between these two funds (fewer than ${preferred}), so treat this correlation with caution.`);
  for (const d of r.disclosures) if (d.code !== 'below_preferred_observations') cautions.push(d.detail);
  return {
    status: 'ok',
    ...base,
    correlation: v.correlation,
    reading: readCorrelation(v.correlation),
    commonReturnCount: v.commonReturnCount,
    windowStart: v.windowStart ?? '',
    windowEnd: v.windowEnd ?? '',
    frequency: v.frequency,
    minimumReturns: min,
    preferredReturns: preferred,
    historyA: { first: a.navSeriesSummary.firstDate, last: a.navSeriesSummary.lastDate },
    historyB: { first: b.navSeriesSummary.firstDate, last: b.navSeriesSummary.lastDate },
    cautions,
  };
}

/** The sentences the screen prints under a successful comparison, with day-first dates. */
export function describeComparisonCoverage(c: Extract<FundComparison, { status: 'ok' }>, ctx: Pick<Nav2Context, 'currency'>): string[] {
  return [
    `Worked out from ${c.commonReturnCount.toLocaleString('en-IN')} ${c.frequency} returns on dates both funds have a price for, from ${showDate(ctx, c.windowStart)} to ${showDate(ctx, c.windowEnd)}. At least ${c.minimumReturns} are needed.`,
    `${c.fundA} has prices from ${showDate(ctx, c.historyA.first)} to ${showDate(ctx, c.historyA.last)}; ${c.fundB} from ${showDate(ctx, c.historyB.first)} to ${showDate(ctx, c.historyB.last)}. Only the dates both have are used.`,
  ];
}

