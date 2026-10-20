// NAV2 Stage 2 -- the trigger runner: what the post-response "kick" does when the NAV2 planner switch is ON.
//
//   switch OFF (the default; row nav2_trigger_planner in ii_reference_job_control, shipped disabled, fails closed):
//       EXACTLY the existing behaviour, runLiveUserNavHistoryBatch(userId). Nothing here changes it.
//   switch ON:
//       the caller's own held schemes are planned with the NAV2 required-window planner (per scheme one consolidated window
//       from the analysis spec and the policy buffers) and the planned schemes are fetched through the SAME existing
//       user-scoped path (runUserNavHistoryBatch with requiredFromOverrides): same attempt ledger, rate limit, single-flight,
//       audit and adapter chain. A planner failure falls back to the existing behaviour rather than leaving the user's
//       history unfetched.
//
// Nothing here enumerates instruments: the candidate set is the caller's own held schemes (every read is user_id = caller).

import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec, type ReportPeriodChoice } from '@/lib/engines/nav2/analysisSpec';
import type { Nav2Trigger } from '@/lib/engines/nav2/requiredWindowPlanner';
import { createAdminClient } from '@/lib/supabase/admin';
import { createLiveUserNavHistoryRuntime, runLiveUserNavHistoryBatch } from '../pc6/userNavHistoryLive';
import { runUserNavHistoryBatch } from '../pc6/userNavHistory';
import { isNav2FlagOn, NAV2_JOB_KEYS } from './nav2Flags';
import { handleNav2Trigger, planUserNav2Windows, type Nav2TriggerOutcome, type Nav2WindowPlan } from './windowPlannerService';

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export interface TriggerRunnerDeps {
  isPlannerOn: () => Promise<boolean>;
  /** The existing user-scoped fetch. `onlyInstrumentIds` (B2) restricts it to the funds a report covers; absent = every fund held (the previous behaviour). */
  legacy: (userId: string, onlyInstrumentIds?: readonly string[]) => Promise<unknown>;
  planned: (userId: string, trigger: Nav2Trigger, period: ReportPeriodChoice, onlyInstrumentIds?: readonly string[] | null) => Promise<Nav2TriggerOutcome>;
}

const liveDeps: TriggerRunnerDeps = {
  isPlannerOn: async () => {
    try {
      return await isNav2FlagOn(createAdminClient(), NAV2_JOB_KEYS.triggerPlanner);
    } catch {
      return false;
    }
  },
  legacy: (userId, onlyInstrumentIds) => (onlyInstrumentIds && onlyInstrumentIds.length > 0 ? runLiveUserNavHistoryBatch(userId, { onlyInstrumentIds }) : runLiveUserNavHistoryBatch(userId)),
  planned: async (userId, trigger, period, onlyInstrumentIds) => {
    const runtime = createLiveUserNavHistoryRuntime();
    const today = todayIso();
    return handleNav2Trigger({
      trigger,
      userId,
      db: runtime.db as SupabaseClient,
      spec: reportAnalysisSpec(today, NAV2_POLICY, period),
      policy: NAV2_POLICY,
      today,
      onlyInstrumentIds,
      runBatch: ({ userId: u, onlyInstrumentIds, requiredFromOverrides }) => runUserNavHistoryBatch({ userId: u, today, runtime, onlyInstrumentIds, requiredFromOverrides }),
    });
  },
};

/**
 * What kickUserNavHistory runs by default. Switch off = the existing path, untouched. Switch on = the NAV2 plan, falling back to
 * the existing path if planning itself fails. A trigger that creates no requirement (nothing planned) is not an error.
 */
export async function runUserNavHistoryForKick(userId: string, deps: Partial<TriggerRunnerDeps> = {}, trigger: Nav2Trigger = { kind: 'statement_accepted' }, period: ReportPeriodChoice = 'all_history', onlyInstrumentIds: readonly string[] | null = null): Promise<unknown> {
  const d = { ...liveDeps, ...deps };
  if (!(await d.isPlannerOn())) return onlyInstrumentIds && onlyInstrumentIds.length > 0 ? d.legacy(userId, onlyInstrumentIds) : d.legacy(userId);
  try {
    return await d.planned(userId, trigger, period, onlyInstrumentIds);
  } catch (e) {
    console.error('[nav2] planned fetch failed; using the existing fetch', e instanceof Error ? e.message : e);
    return onlyInstrumentIds && onlyInstrumentIds.length > 0 ? d.legacy(userId, onlyInstrumentIds) : d.legacy(userId);
  }
}

/**
 * Report-period trigger: start the planned fetch for the period the user just chose, AFTER the response. Returns true when the
 * work was scheduled (the report holds and the screen checks again), false when it could not be (the report then proceeds and
 * says honestly what history it has; it never waits for work that was not started). Never throws.
 */
export function kickNav2ReportPeriod(userId: string, period: ReportPeriodChoice, deps: Partial<TriggerRunnerDeps> = {}, onlyInstrumentIds: readonly string[] | null = null): boolean {
  try {
    after(async () => {
      try {
        await runUserNavHistoryForKick(userId, deps, { kind: 'report_period_requested' }, period, onlyInstrumentIds);
      } catch (e) {
        console.error('[nav2] report-period fetch failed', e instanceof Error ? e.message : e);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Read-only: the plan a report period needs for this user (nothing is fetched or written). */
export async function planForReportPeriod(admin: SupabaseClient, userId: string, period: ReportPeriodChoice, today: string = todayIso(), onlyInstrumentIds: readonly string[] | null = null): Promise<Nav2WindowPlan> {
  return planUserNav2Windows({ db: admin, userId, spec: reportAnalysisSpec(today, NAV2_POLICY, period), policy: NAV2_POLICY, today, onlyInstrumentIds });
}
