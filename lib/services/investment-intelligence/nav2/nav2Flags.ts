// NAV2 Stage 2 -- the feature switches. They reuse the existing ii_reference_job_control kill-switch table (rows
// seeded DISABLED by migration 0260), so there is one switch mechanism, not a second one.
//
// FAIL CLOSED: a missing row, a failed read, or an unapplied migration reads as OFF. A switch that is OFF changes
// behaviour only by not doing the new thing; it never deletes anything (the old path keeps running untouched).

import type { SupabaseClient } from '@supabase/supabase-js';

export const NAV2_JOB_KEYS = {
  /** The Fund analytics report (generation). */
  fundAnalytics: 'nav2_fund_analytics',
  /** The user-scoped NAV history trigger uses the NAV2 window planner instead of the legacy window. */
  triggerPlanner: 'nav2_trigger_planner',
  /** The correction worker that invalidates cache entries after a NAV / benchmark / risk-free correction. */
  correctionWorker: 'nav2_correction_worker',
  /** The weekly RBI risk-free refresh job. */
  riskFreeWeeklyRefresh: 'nav2_risk_free_weekly_refresh',
} as const;

export type Nav2JobKey = (typeof NAV2_JOB_KEYS)[keyof typeof NAV2_JOB_KEYS];

/** true only when the row exists and is enabled. */
export async function isNav2FlagOn(client: SupabaseClient, key: Nav2JobKey): Promise<boolean> {
  try {
    const { data, error } = await client.from('ii_reference_job_control').select('enabled').eq('job_key', key).maybeSingle();
    if (error) return false;
    return (data as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
}
