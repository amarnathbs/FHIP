// What the user is TOLD about their plan — pure, so the wording is testable and
// cannot drift between the API and the UI.
//
// Honesty rule (PO requirement 6): Premium that an FHIP admin allocated must
// never read as if the user paid for it, and a lapsed admin grant must read as
// lapsed, not as a silent downgrade. No billing flow is implied.

import { effectivePlanTier, type EntitlementWindowRow } from '@/lib/services/entitlementWindow';
import { dateFormatKeyForCountry, formatDateShort } from '@/lib/engines/date';

export type PlanStatusKind = 'free' | 'premium_paid' | 'premium_admin_grant' | 'admin_grant_lapsed' | 'premium_promo' | 'promo_lapsed';

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

/**
 * 2026-10-12 -> "12-10-2026" for India, "12/10/2026" otherwise (the user's own
 * country; an unknown country uses the AU shape). Day-first through the
 * canonical formatter (lib/engines/date.ts), never ISO year-first or US
 * month-first (PO rule, Document2 findings #8/#19). Locale-independent so server
 * and tests agree.
 */
export function formatIsoDate(isoDate: string, country?: string | null): string {
  return formatDateShort(isoDate, dateFormatKeyForCountry(country));
}

export function describePlanStatus(row: PlanStatusInput | null | undefined, today: string, country?: string | null): PlanStatus {
  const planTier = effectivePlanTier(row, today);
  const isAdminGrant = row?.entitlement_source === 'admin_grant';
  const isPromo = row?.entitlement_source === 'promo_code';
  const endsOn = row?.effective_to ?? row?.admin_grant_ends_on ?? null;

  if (planTier === 'premium') {
    if (isAdminGrant && endsOn) {
      return {
        kind: 'premium_admin_grant',
        planTier,
        label: `Premium (granted by FHIP admin, ends ${formatIsoDate(endsOn, country)})`,
        grantEndsOn: endsOn,
      };
    }
    if (isPromo && endsOn) {
      return {
        kind: 'premium_promo',
        planTier,
        label: `Premium (promo code, ends ${formatIsoDate(endsOn, country)})`,
        grantEndsOn: endsOn,
      };
    }
    return { kind: 'premium_paid', planTier, label: 'Premium', grantEndsOn: null };
  }

  if (isPromo && row?.plan_tier === 'premium' && endsOn && endsOn < today) {
    return {
      kind: 'promo_lapsed',
      planTier,
      label: `Free (your Premium access from a promo code ended ${formatIsoDate(endsOn, country)})`,
      grantEndsOn: endsOn,
    };
  }

  if (isAdminGrant && row?.plan_tier === 'premium' && endsOn && endsOn < today) {
    return {
      kind: 'admin_grant_lapsed',
      planTier,
      label: `Free (your Premium access granted by FHIP admin ended ${formatIsoDate(endsOn, country)})`,
      grantEndsOn: endsOn,
    };
  }
  return { kind: 'free', planTier, label: 'Free', grantEndsOn: null };
}
