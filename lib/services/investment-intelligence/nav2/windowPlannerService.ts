// NAV2 Phase B -- the window planner SERVICE: it reads the caller's OWN held
// schemes, turns the analysis spec into one required window per scheme
// (lib/engines/nav2/requiredWindowPlanner.ts), compares each window with what is
// already stored, and produces a bounded, fairly ordered fetch plan that the
// EXISTING user-scoped fetch path executes. It is NOT a second fetch system:
//
//   reads:     loadUserHeldFundDates / loadCoverage / loadAttempts  (userNavHistory.ts)
//   gap rule:  planSchemeGap, classifySchemeHistory, inFailureCooldown   (same file)
//   ordering:  orderHydrationWork   (the scheduled job's fair-rotation rule)
//   chunking:  chunkDateWindow / MAX_FETCH_WINDOW_DAYS   (the job's bounded windows)
//   fetching:  runUserNavHistoryBatch(... requiredFromOverrides)  (the 0198/0199
//              attempt ledger, rate limit, single-flight, audit, and the adapter chain)
//
// WHAT IT ADDS: the per-scheme consolidated REQUIRED WINDOW (buffers for rolling
// horizons, moving averages, point-to-point boundaries and the risk / benchmark
// minimum span), handed to the existing path as `requiredFromOverrides` (an
// override can only move a scheme's required date EARLIER than its own
// earliest-holding rule, and only for the caller's own schemes).
//
// NO FULL-UNIVERSE EXPANSION (spec 1, 3, 12.1): the candidate set is exactly the
// caller's held schemes (every read is user_id = caller); nothing in this module
// enumerates instruments, benchmarks, or the AMFI universe, and a scheme that is
// not held is never planned. Tests pin this against a database holding a thousand
// other instruments.
//
// WHAT IS A REQUIREMENT. Requirements derive from CANONICAL rows only (usable
// transactions, user investment dates, holding snapshots), never from a source
// document. A draft, rejected, quarantined, malware-failed, unresolved or
// unaccepted document has no canonical rows, so it creates no requirement and no
// retention hold; a trigger that says so is classified `ignore`.
//
// TENANCY (spec 14). The plan carries instrument ids, dates and driver kinds, and
// no user, household, folio or document identifier; the same scheme held by two
// users yields one window, and the second user finds the history already stored.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Nav2Policy } from '@/lib/config/nav2/metricPolicy';
import type { AnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import {
  classifyTrigger,
  computeRequiredWindow,
  consolidateWindows,
  heldDateKind,
  type Nav2Trigger,
  type RequiredWindow,
  type TriggerAction,
} from '@/lib/engines/nav2/requiredWindowPlanner';
import type { InvalidationEvent } from '@/lib/engines/nav2/cacheKeys';
import {
  inFailureCooldown,
  loadAttempts,
  loadCoverage,
  loadUserHeldFundDates,
  planSchemeGap,
  type AttemptInfo,
  type SchemeCoverage,
  type UserNavHistoryBatchResult,
  type RequiredFromOverrides,
} from '../pc6/userNavHistory';
import { REPORT_NAV_MAX_FAILED_ATTEMPTS } from '../pc6/reportNavHistoryGate';
import { MAX_FETCH_WINDOW_DAYS, chunkDateWindow, orderHydrationWork, type HydrationAttemptRecord } from '../pc6/selectiveHistoricalHydrationJob';

type Db = Pick<SupabaseClient, 'from'>;

/** Schemes the plan will ask the existing path to work on in ONE pass (the existing batch caps its own work too). */
export const NAV2_PLAN_DEFAULT_BUDGET = 3;

export interface PlannedFetch {
  instrumentId: string;
  fromDate: string;
  toDate: string;
  /** How many bounded (<= MAX_FETCH_WINDOW_DAYS) provider requests the window needs in total (the existing path does a few per call and resumes). */
  chunkCount: number;
}

export interface FetchPlan {
  /** Ordered fairly (never attempted first, then least recently attempted), at most `budget`. */
  toFetch: PlannedFetch[];
  /** The stored history already reaches the required date (or the fund's confirmed history floor). */
  alreadyCovered: string[];
  /** A recent failed or empty attempt: left alone for now. */
  inCooldown: string[];
  /** Needs history, but the budget for this pass is spent. */
  deferred: string[];
}

export interface PlanFetchesInput {
  windows: readonly RequiredWindow[];
  coverage: ReadonlyMap<string, SchemeCoverage>;
  attempts: ReadonlyMap<string, AttemptInfo & { attemptsTotal?: number; lastSuccessAt?: string | null }>;
  today: string;
  nowIso: string;
  budget: number;
}

/** Pure. Reuses the existing gap, cooldown, fair-ordering and chunking rules unchanged. */
export function planFetches(input: PlanFetchesInput): FetchPlan {
  const alreadyCovered: string[] = [];
  const inCooldown: string[] = [];
  const candidates: Array<{ instrumentId: string; fromDate: string; toDate: string }> = [];
  for (const w of input.windows) {
    const coverage = input.coverage.get(w.instrumentId) ?? { earliestNav: null, historyFloor: null };
    const gap = planSchemeGap({ requiredFrom: w.requiredFrom }, coverage, input.today);
    if (gap.state === 'complete') {
      alreadyCovered.push(w.instrumentId);
      continue;
    }
    // LIVELOCK GUARD (found on DEV, source timing out): a fund whose fetch has failed REPORT_NAV_MAX_FAILED_ATTEMPTS times in a row is left alone, the same
    // rule the price-history gate applies ("attempts exhausted"). Without it the plan asked for the same failing fetch after every cooldown and a report that
    // names these funds could never be issued. The report says honestly that the fund's longer history is not available.
    const tried = input.attempts.get(w.instrumentId) ?? null;
    if (tried && (tried.lastOutcome === 'fetch_failed' || tried.lastOutcome === 'unresolvable_identifier') && tried.consecutiveFailures >= REPORT_NAV_MAX_FAILED_ATTEMPTS) {
      inCooldown.push(w.instrumentId);
      continue;
    }
    if (inFailureCooldown(input.attempts.get(w.instrumentId) ?? null, input.nowIso)) {
      inCooldown.push(w.instrumentId);
      continue;
    }
    candidates.push({ instrumentId: w.instrumentId, fromDate: gap.fromDate, toDate: gap.toDate });
  }
  const ledger = new Map<string, HydrationAttemptRecord>();
  for (const c of candidates) {
    const a = input.attempts.get(c.instrumentId);
    if (a) {
      ledger.set(c.instrumentId, {
        instrumentId: c.instrumentId,
        lastAttemptedAt: a.lastAttemptedAt,
        lastOutcome: a.lastOutcome as HydrationAttemptRecord['lastOutcome'],
        consecutiveFailures: a.consecutiveFailures,
        attemptsTotal: a.attemptsTotal ?? 0,
        lastSuccessAt: a.lastSuccessAt ?? null,
      });
    }
  }
  const order = orderHydrationWork(candidates.map((c) => c.instrumentId), ledger, 0);
  const byId = new Map(candidates.map((c) => [c.instrumentId, c]));
  const ordered = order.map((id) => byId.get(id)!);
  const budget = Math.max(0, input.budget);
  return {
    toFetch: ordered.slice(0, budget).map((c) => ({ ...c, chunkCount: chunkDateWindow(c.fromDate, c.toDate, MAX_FETCH_WINDOW_DAYS).length })),
    alreadyCovered: alreadyCovered.sort(),
    inCooldown: inCooldown.sort(),
    deferred: ordered.slice(budget).map((c) => c.instrumentId),
  };
}

export interface Nav2WindowPlan {
  windows: RequiredWindow[];
  fetch: FetchPlan;
  /** Hand to runUserNavHistoryBatch({ requiredFromOverrides }) so the existing path fetches the planned window. */
  requiredFromOverrides: Map<string, string>;
  policyVersion: string;
}

/**
 * Read-only. The caller's own held schemes, their required windows and what (if anything) needs fetching.
 * Never fetches, never writes.
 */
export async function planUserNav2Windows(args: {
  db: Db;
  userId: string;
  spec: AnalysisSpec;
  policy: Nav2Policy;
  today: string;
  nowIso?: string;
  budget?: number;
  /** B2: plan only these funds (the ones the report covers). null / undefined = every fund the caller holds. */
  onlyInstrumentIds?: readonly string[] | null;
}): Promise<Nav2WindowPlan> {
  const allHeld = await loadUserHeldFundDates(args.db, args.userId);
  const only = args.onlyInstrumentIds ? new Set(args.onlyInstrumentIds) : null;
  const held = only ? allHeld.filter((h) => only.has(h.instrumentId)) : allHeld;
  const windows = consolidateWindows(
    held.map((h) =>
      computeRequiredWindow({ instrumentId: h.instrumentId, earliestHeldDate: h.earliestDate, earliestHeldKind: heldDateKind(h.reason), spec: args.spec, policy: args.policy, today: args.today })
    )
  );
  const ids = windows.map((w) => w.instrumentId);
  const [coverage, attempts] = await Promise.all([loadCoverage(args.db, ids), loadAttempts(args.db, ids)]);
  const fetch = planFetches({ windows, coverage, attempts, today: args.today, nowIso: args.nowIso ?? new Date().toISOString(), budget: args.budget ?? NAV2_PLAN_DEFAULT_BUDGET });
  return { windows, fetch, requiredFromOverrides: new Map(windows.map((w) => [w.instrumentId, w.requiredFrom])), policyVersion: args.policy.version };
}

export type Nav2RunBatch = (args: { userId: string; onlyInstrumentIds: readonly string[]; requiredFromOverrides: RequiredFromOverrides }) => Promise<UserNavHistoryBatchResult>;

export type Nav2TriggerOutcome =
  | { action: 'plan_held_windows'; reason: string; plan: Nav2WindowPlan; executed: UserNavHistoryBatchResult | null }
  | { action: 'invalidate_dependents'; reason: string; event: InvalidationEvent }
  | { action: 'record_benchmark_history_requirement'; reason: string; benchmarkId: string }
  | { action: 'ignore'; reason: string };

/**
 * The single entry point for the spec 4.1 triggers. A trigger that needs a user (statement accepted, new holding,
 * report period, analysis period) plans that user's windows and, when `runBatch` is supplied, hands the planned
 * schemes to the existing user-scoped fetch; the other triggers are classified and returned for their own handler
 * (cache invalidation, benchmark coverage). A non-accepted document is ignored: it creates no requirement.
 */
export async function handleNav2Trigger(args: {
  trigger: Nav2Trigger;
  userId?: string;
  db: Db;
  spec: AnalysisSpec;
  policy: Nav2Policy;
  today: string;
  nowIso?: string;
  budget?: number;
  runBatch?: Nav2RunBatch;
  /** B2: restrict the plan to these funds (a report-period trigger for the funds one report covers). */
  onlyInstrumentIds?: readonly string[] | null;
}): Promise<Nav2TriggerOutcome> {
  const action: TriggerAction = classifyTrigger(args.trigger);
  switch (action.action) {
    case 'plan_held_windows': {
      if (!args.userId) return { action: 'ignore', reason: 'No user was named for a per-user trigger, so nothing was planned.' };
      const plan = await planUserNav2Windows({ db: args.db, userId: args.userId, spec: args.spec, policy: args.policy, today: args.today, nowIso: args.nowIso, budget: args.budget, onlyInstrumentIds: args.onlyInstrumentIds });
      const executed =
        args.runBatch && plan.fetch.toFetch.length > 0
          ? await args.runBatch({ userId: args.userId, onlyInstrumentIds: plan.fetch.toFetch.map((f) => f.instrumentId), requiredFromOverrides: plan.requiredFromOverrides })
          : null;
      return { action: 'plan_held_windows', reason: action.reason, plan, executed };
    }
    case 'invalidate_dependents':
      return { action: 'invalidate_dependents', reason: action.reason, event: { kind: 'nav_correction', instrumentId: action.instrumentId, date: action.date } };
    case 'record_benchmark_history_requirement':
      return { action: 'record_benchmark_history_requirement', reason: action.reason, benchmarkId: action.benchmarkId };
    case 'ignore':
      return { action: 'ignore', reason: action.reason };
  }
}
