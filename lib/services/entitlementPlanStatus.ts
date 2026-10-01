// What the user is TOLD about their plan — pure, so the wording is testable and
// cannot drift between the API and the UI.
//
// Honesty rule (PO requirement 6): Premium that an FHIP admin allocated must
// never read as if the user paid for it, and a lapsed admin grant must read as
// lapsed, not as a silent downgrade. No billing flow is implied.

import { effectivePlanTier, type EntitlementWindowRow } from '@/lib/services/entitlementWindow';

export type PlanStatusKind = 'free' | 'premium_paid' | 'premium_admin_grant' | 'admin_grant_lapsed';

export interface PlanStatusInput extends EntitlementWindowRow {
  entitlement_source?: string | null;
  admin_grant_ends_on?: string | null;
}

export interface PlanStatus {
  kind: PlanStatusKind;
  /** The tier consumers should act on today (window-aware). */
  planTier: 'free' | 'premium';
  label: string;
  /** Set for premium_admin_grant (the date it ends) and admin_grant_lapsed (the date it ended). */
  grantEndsOn: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-12 -> "12 Oct 2026" (locale-independent so server and tests agree). */
export function formatIsoDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function describePlanStatus(row: PlanStatusInput | null | undefined, today: string): PlanStatus {
  const planTier = effectivePlanTier(row, today);
  const isAdminGrant = row?.entitlement_source === 'admin_grant';
  const endsOn = row?.effective_to ?? row?.admin_grant_ends_on ?? null;

  if (planTier === 'premium') {
    if (isAdminGrant && endsOn) {
      return {
        kind: 'premium_admin_grant',
        planTier,
        label: `Premium (granted by FHIP admin, ends ${formatIsoDate(endsOn)})`,
        grantEndsOn: endsOn,
      };
    }
    return { kind: 'premium_paid', planTier, label: 'Premium', grantEndsOn: null };
  }

  if (isAdminGrant && row?.plan_tier === 'premium' && endsOn && endsOn < today) {
    return {
      kind: 'admin_grant_lapsed',
      planTier,
      label: `Free (your Premium access granted by FHIP admin ended ${formatIsoDate(endsOn)})`,
      grantEndsOn: endsOn,
    };
  }
  return { kind: 'free', planTier, label: 'Free', grantEndsOn: null };
}
