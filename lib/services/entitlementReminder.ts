// Expiry reminders for time-limited Premium (admin grant or promo code).
//
// PURE and dependency-free so the rules are testable and cannot drift between
// the app-wide banner (server-rendered in app/(app)/layout.tsx) and the plan
// panel on the profile page (GET /api/payments/status).
//
// RULES
//   * Only an entitlement whose current SOURCE is 'admin_grant' or 'promo_code'
//     can produce a reminder. A paid entitlement (source 'payment') never does,
//     even if it carries an effective_to: a paying customer must not be told
//     their access is ending because of a leftover grant date.
//   * Active (Premium today) and ending within 30 days -> 'expiring_30';
//     within 7 days -> 'expiring_7' (the more urgent one replaces the other —
//     a user sees exactly one notice).
//   * Lapsed (end date passed) -> 'lapsed' for LAPSED_NOTICE_DAYS days, then
//     nothing: an old lapse should not nag forever.
//   * The notice tells the truth about how to continue: subscribe on the
//     billing page if a plan exists for the user's region, or ask FHIP support
//     (who can ask an admin). No billing flow is invented here.
//   * The function takes ONE row (the signed-in user's own) and the date; it
//     has no way to mention anyone else.

import { isEntitlementWindowCurrent, type EntitlementWindowRow } from '@/lib/services/entitlementWindow';
import { formatIsoDate } from '@/lib/services/entitlementPlanStatus';

export const REMINDER_THRESHOLD_DAYS = [30, 7] as const;
export const LAPSED_NOTICE_DAYS = 30;

export type ReminderKind = 'none' | 'expiring_30' | 'expiring_7' | 'lapsed';
export type TimeLimitedSource = 'admin_grant' | 'promo_code';

export interface ReminderRow extends EntitlementWindowRow {
  entitlement_source?: string | null;
}

export interface EntitlementReminder {
  kind: ReminderKind;
  source: TimeLimitedSource | null;
  /** The (inclusive) last day of access. */
  endsOn: string | null;
  /** Days left (expiring) or days since the end date (lapsed). */
  days: number | null;
  /** Stable key for per-threshold dismissal in the browser. */
  key: string | null;
  title: string | null;
  message: string | null;
}

const NONE: EntitlementReminder = Object.freeze({ kind: 'none', source: null, endsOn: null, days: null, key: null, title: null, message: null });

function dayDiff(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

const SOURCE_PHRASE: Record<TimeLimitedSource, string> = {
  admin_grant: 'granted by FHIP',
  promo_code: 'from a promo code',
};

const HOW_TO_CONTINUE =
  'To keep Premium you can subscribe from the Plans section on your Profile page (where a plan is available for your region), or contact FHIP support and ask for your access to be reviewed.';

export function computeEntitlementReminder(row: ReminderRow | null | undefined, today: string): EntitlementReminder {
  if (!row || row.plan_tier !== 'premium') return NONE;
  const source = row.entitlement_source;
  if (source !== 'admin_grant' && source !== 'promo_code') return NONE; // paid / unknown / legacy: never
  const endsOn = row.effective_to ?? null;
  if (!endsOn) return NONE;

  if (isEntitlementWindowCurrent(row, today)) {
    const left = dayDiff(today, endsOn);
    const phrase = SOURCE_PHRASE[source];
    if (left <= REMINDER_THRESHOLD_DAYS[1]) {
      return {
        kind: 'expiring_7',
        source,
        endsOn,
        days: left,
        key: `expiring_7:${endsOn}`,
        title: left === 0 ? 'Your Premium access ends today' : `Your Premium access ends in ${left} day${left === 1 ? '' : 's'}`,
        message: `Your Premium access (${phrase}) ends on ${formatIsoDate(endsOn)}. ${HOW_TO_CONTINUE}`,
      };
    }
    if (left <= REMINDER_THRESHOLD_DAYS[0]) {
      return {
        kind: 'expiring_30',
        source,
        endsOn,
        days: left,
        key: `expiring_30:${endsOn}`,
        title: `Your Premium access ends in ${left} days`,
        message: `Your Premium access (${phrase}) ends on ${formatIsoDate(endsOn)}. ${HOW_TO_CONTINUE}`,
      };
    }
    return NONE;
  }

  // Not current: lapsed only if the END date has passed (a not-yet-started window is not a lapse).
  if (endsOn < today) {
    const since = dayDiff(endsOn, today);
    if (since <= LAPSED_NOTICE_DAYS) {
      return {
        kind: 'lapsed',
        source,
        endsOn,
        days: since,
        key: `lapsed:${endsOn}`,
        title: 'Your Premium access has ended',
        message: `Your Premium access (${SOURCE_PHRASE[source]}) ended on ${formatIsoDate(endsOn)} and your account is now on the Free plan. ${HOW_TO_CONTINUE}`,
      };
    }
  }
  return NONE;
}
