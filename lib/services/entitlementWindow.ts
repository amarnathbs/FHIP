// Entitlement validity-window rules — pure, dependency-free, shared by every
// consumer that must agree on "is this user Premium TODAY".
//
// WHY THIS EXISTS. `user_entitlements.plan_tier` is a stored flag; it does not
// flip itself back to 'free' when a time-limited entitlement (an admin grant,
// or a paid period that was given an effective_to) lapses. The AI functions
// ai_entitlement_state()/ai_admit_request() (migration 0115) honour
// effective_from/effective_to in SQL. Every OTHER reader of plan_tier
// (report export gates, the report generator, the recommendations page, the
// billing status endpoint, the admin counts) previously read the bare flag, so
// an expired admin grant would have kept working there forever. They all go
// through this module now, with exactly the same predicate as 0115:
//
//   Premium  <=>  plan_tier = 'premium'
//             AND (effective_from IS NULL OR effective_from <= today)
//             AND (effective_to   IS NULL OR effective_to   >= today)
//
// effective_to is INCLUSIVE (a grant ending on D works through the whole of D).
//
// `today` is the UTC calendar date: the database evaluates current_date in
// UTC on Supabase, and the two must not disagree about which day it is.

import type { SupabaseClient } from '@supabase/supabase-js';

export type EntitlementTier = 'free' | 'premium';

/** A grant's end date may be at most this many days after the date of allocation/extension. */
export const ENTITLEMENT_GRANT_MAX_DAYS = 365;

export interface EntitlementWindowRow {
  plan_tier?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
}

/** UTC calendar date as YYYY-MM-DD. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Add whole days to a YYYY-MM-DD date (UTC arithmetic, no DST). */
export function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The latest end date an admin may set when allocating/extending on `today`. */
export function maxGrantEndDate(today: string = utcToday()): string {
  return addDaysIso(today, ENTITLEMENT_GRANT_MAX_DAYS);
}

/** True when `isoDate` is a real calendar date written as YYYY-MM-DD. */
export function isValidIsoDate(isoDate: unknown): isoDate is string {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  const d = new Date(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === isoDate;
}

export function isEntitlementWindowCurrent(row: EntitlementWindowRow | null | undefined, today: string = utcToday()): boolean {
  if (!row) return false;
  const from = row.effective_from ?? null;
  const to = row.effective_to ?? null;
  return (from === null || from <= today) && (to === null || to >= today);
}

/**
 * The tier a consumer should act on today. A missing row, an unrecognised
 * tier value, or an expired/not-yet-started window all resolve to 'free' —
 * i.e. the fail-closed direction for a paid feature gate.
 */
export function effectivePlanTier(row: EntitlementWindowRow | null | undefined, today: string = utcToday()): EntitlementTier {
  if (!row || row.plan_tier !== 'premium') return 'free';
  return isEntitlementWindowCurrent(row, today) ? 'premium' : 'free';
}

/**
 * Head-count of users who are Premium TODAY (plan_tier='premium' AND inside the
 * validity window). Admin dashboards use this instead of counting the bare
 * plan_tier flag, which would keep counting lapsed admin grants as Premium.
 * Takes the caller's service-role client; the type import is erased at runtime
 * so this module stays dependency-free.
 */
export function countEffectivePremium(admin: SupabaseClient, today: string = utcToday()) {
  return admin
    .from('user_entitlements')
    .select('user_id', { count: 'exact', head: true })
    .eq('plan_tier', 'premium')
    .or(`effective_from.is.null,effective_from.lte.${today}`)
    .or(`effective_to.is.null,effective_to.gte.${today}`);
}
