/**
 * Basis of a forecast run's opening position, and the matching "actual" for the variance table
 * (PO decision 16-10-2026, personal basis).
 *
 * Runs created by forecast engine 1.7.0 or later open from the PERSONAL position (entity-held rows left out).
 * Earlier runs opened from the position as it was reported before that decision, which counted every entity
 * amount. Comparing an actual on one basis with a forecast built on the other would publish a variance made
 * entirely of the basis difference, so the actual is taken on the SAME basis as the original run it is compared
 * with. Entity-free households: both bases are identical and nothing changes.
 */
import type { NetWorthBasisInfo } from '@/lib/engines/netWorthBasis';

export const FIRST_PERSONAL_BASIS_FORECAST_ENGINE_VERSION = 'forecast-1.7.0';

function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /^forecast-(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true when a run was created by an engine that opens from the personal position. Unknown = earlier basis. */
export function forecastRunIsPersonalBasis(engineVersion: string | null | undefined): boolean {
  const run = parseVersion(engineVersion);
  const first = parseVersion(FIRST_PERSONAL_BASIS_FORECAST_ENGINE_VERSION)!;
  if (!run) return false;
  for (let i = 0; i < 3; i += 1) {
    if (run[i] !== first[i]) return run[i] > first[i];
  }
  return true;
}

export type VarianceCategoryWithLiveActual = 'net_worth' | 'retirement' | 'investment' | 'debt';

export interface VarianceDashboardFigures {
  netWorth: number;
  totalRetirement: number;
  totalInvestments: number;
  totalLiabilities: number;
  netWorthBasis?: NetWorthBasisInfo;
}

export interface ResolvedVarianceActual {
  actual: number;
  /** true only when the stored snapshot's figure is the actual (net worth, same basis). */
  usedSnapshot: boolean;
  basis: 'personal' | 'family_incl_entities';
}

export function resolveVarianceActual(args: {
  category: VarianceCategoryWithLiveActual;
  /** engine_version of the ORIGINAL run being compared with; null when there is none yet (a new baseline is personal). */
  runEngineVersion: string | null | undefined;
  snapshot: { net_worth: number } | null;
  dashboard: VarianceDashboardFigures;
}): ResolvedVarianceActual {
  const { category, snapshot, dashboard } = args;
  const hasRun = args.runEngineVersion !== null && args.runEngineVersion !== undefined;
  const personalRun = !hasRun || forecastRunIsPersonalBasis(args.runEngineVersion);
  const info = dashboard.netWorthBasis;
  const comparable = info ? info.history.comparableToPersonal : true;
  const entityHeld = info?.entityHeld;
  const basis = personalRun || comparable ? 'personal' : 'family_incl_entities';

  if (category === 'net_worth') {
    if (personalRun) {
      // Stored months are on the history basis: usable beside a personal run only when the bases coincide.
      return snapshot && comparable
        ? { actual: snapshot.net_worth, usedSnapshot: true, basis }
        : { actual: dashboard.netWorth, usedSnapshot: false, basis };
    }
    return snapshot
      ? { actual: snapshot.net_worth, usedSnapshot: true, basis }
      : { actual: info ? info.history.netWorth : dashboard.netWorth, usedSnapshot: false, basis };
  }
  const add =
    personalRun || !entityHeld
      ? 0
      : category === 'retirement'
        ? entityHeld.retirement
        : category === 'investment'
          ? entityHeld.investments
          : entityHeld.liabilities;
  const live = category === 'retirement' ? dashboard.totalRetirement : category === 'investment' ? dashboard.totalInvestments : dashboard.totalLiabilities;
  return { actual: live + add, usedSnapshot: false, basis };
}
