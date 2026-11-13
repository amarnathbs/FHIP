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

/** Why a switch reads the way it does. Only `on` lets anything run; the other three all read as OFF, but they are NOT the same thing. */
export interface Nav2FlagRead {
  on: boolean;
  /** on / off = the row says so; missing = no such row; read_failed = the database could not be read (reported as OFF, fail closed). */
  state: 'on' | 'off' | 'missing' | 'read_failed';
  /** Present only when state is read_failed: the database error code and a short message, so a restricted or unreachable project is not mistaken for a switched-off job. */
  failure?: { code: string | null; message: string };
}

const shortMessage = (m: unknown): string => String(m ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 120);

/** Same fail-closed answer as isNav2FlagOn, but it says WHY (found 13-11-2026: a failed read looked exactly like a switched-off job). */
export async function readNav2Flag(client: SupabaseClient, key: Nav2JobKey): Promise<Nav2FlagRead> {
  try {
    const { data, error } = await client.from('ii_reference_job_control').select('enabled').eq('job_key', key).maybeSingle();
    if (error) return { on: false, state: 'read_failed', failure: { code: (error as { code?: string }).code ?? null, message: shortMessage(error.message) } };
    if (data === null || data === undefined) return { on: false, state: 'missing' };
    return (data as { enabled?: boolean }).enabled === true ? { on: true, state: 'on' } : { on: false, state: 'off' };
  } catch (e) {
    return { on: false, state: 'read_failed', failure: { code: null, message: shortMessage(e instanceof Error ? e.message : e) } };
  }
}

/** true only when the row exists and is enabled. */
export async function isNav2FlagOn(client: SupabaseClient, key: Nav2JobKey): Promise<boolean> {
  return (await readNav2Flag(client, key)).on;
}
