// NAV2 -- ranking among the household's OWN schemes (spec 8.17). Family:
// scheme_performance. Pure.
//
// This is NOT a market ranking and never becomes one:
//   * the population is exactly the schemes the caller passes in (the caller passes
//     only schemes held within the authorised household scope);
//   * the label is always "Your held schemes" - never "market ranking" or "best funds";
//   * only COMPARABLE schemes are ranked against each other: same category, same plan,
//     same option, same horizon, same metric and metric definition. A scheme alone in
//     its group is `not comparable` rather than forced into a rank, and an equity fund
//     is never ranked against a liquid or debt fund;
//   * a scheme whose metric is not available (insufficient history, missing benchmark,
//     ...) is listed as excluded with its state, never ranked with a placeholder;
//   * ties are broken deterministically by instrument id (ascending) and flagged;
//   * the result states the population size and the as-of date.

import type { IiOptionType, IiPlanType } from '@/lib/services/investment-intelligence/types';
import { available, makeProvenance, unavailable, type Nav2Context, type Nav2Result, type Nav2State } from './types';

export const HELD_RANKING_LABEL = 'Your held schemes';

export interface RankingCandidate {
  instrumentId: string;
  /** Normalised category key (same value = comparable). null = unknown: never ranked. */
  category: string | null;
  planType: IiPlanType | null;
  optionType: IiOptionType | null;
  horizonId: string;
  metricId: string;
  metricDefinitionVersion: string;
  /** The state of the metric result for this scheme. Only 'available' can be ranked. */
  state: Nav2State;
  /** The metric value (a return, a ratio, ...); null when not available. */
  value: number | null;
}

export interface RankedRow {
  rank: number;
  instrumentId: string;
  value: number;
  /** True when another scheme in the group has exactly this value (the id order decided the rank). */
  tied: boolean;
}

export interface RankingGroup {
  category: string;
  planType: IiPlanType | null;
  optionType: IiOptionType | null;
  horizonId: string;
  metricId: string;
  metricDefinitionVersion: string;
  populationSize: number;
  /** Highest value first. */
  rows: RankedRow[];
}

export interface NotComparableRow {
  instrumentId: string;
  reason: 'category_unknown' | 'no_comparable_peer';
}

export interface ExcludedRow {
  instrumentId: string;
  state: Nav2State;
}

export interface HeldRankingValue {
  label: typeof HELD_RANKING_LABEL;
  asOfDate: string;
  /** Every scheme passed in. */
  populationSize: number;
  groups: RankingGroup[];
  notComparable: NotComparableRow[];
  excluded: ExcludedRow[];
}

export function rankHeldSchemes(candidates: readonly RankingCandidate[], asOfDate: string, ctx: Nav2Context): Nav2Result<HeldRankingValue> {
  const prov = makeProvenance(ctx, 'held_ranking', {
    observationCount: candidates.length,
    actual: { start: null, end: asOfDate },
    convention: { population: 'households_own_schemes_only', tie: ctx.policy.conventions.rankingTie, comparableBy: 'category_plan_option_horizon_metric' },
  });
  const excluded: ExcludedRow[] = [];
  const notComparable: NotComparableRow[] = [];
  const grouped = new Map<string, RankingCandidate[]>();
  for (const c of candidates) {
    if (c.state !== 'available' || c.value === null || !Number.isFinite(c.value)) {
      excluded.push({ instrumentId: c.instrumentId, state: c.state });
      continue;
    }
    if (c.category === null || c.category === '') {
      notComparable.push({ instrumentId: c.instrumentId, reason: 'category_unknown' });
      continue;
    }
    const key = JSON.stringify([c.category, c.planType, c.optionType, c.horizonId, c.metricId, c.metricDefinitionVersion]);
    const list = grouped.get(key);
    if (list) list.push(c);
    else grouped.set(key, [c]);
  }
  const groups: RankingGroup[] = [];
  for (const members of grouped.values()) {
    if (members.length < 2) {
      notComparable.push({ instrumentId: members[0].instrumentId, reason: 'no_comparable_peer' });
      continue;
    }
    const sorted = [...members].sort((a, b) => b.value! - a.value! || (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
    const first = sorted[0];
    groups.push({
      category: first.category!,
      planType: first.planType,
      optionType: first.optionType,
      horizonId: first.horizonId,
      metricId: first.metricId,
      metricDefinitionVersion: first.metricDefinitionVersion,
      populationSize: sorted.length,
      rows: sorted.map((m, i) => ({ rank: i + 1, instrumentId: m.instrumentId, value: m.value!, tied: sorted.some((o) => o !== m && o.value === m.value) })),
    });
  }
  groups.sort((a, b) => JSON.stringify([a.category, a.horizonId, a.metricId, a.planType, a.optionType]).localeCompare(JSON.stringify([b.category, b.horizonId, b.metricId, b.planType, b.optionType])));
  notComparable.sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : 1));
  excluded.sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : 1));
  if (groups.length === 0) {
    return unavailable('not_applicable', 'no_comparable_peer', 'None of your held schemes has a comparable peer among your other schemes, so no ranking is shown.', prov);
  }
  return available({ label: HELD_RANKING_LABEL, asOfDate, populationSize: candidates.length, groups, notComparable, excluded }, prov);
}
