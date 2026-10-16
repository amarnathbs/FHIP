// Staff admin Premium (migration 0283) -- the application-side constants and wording for Premium that FHIP gives its own
// staff accounts automatically. Pure and dependency free so the Admin screen, the billing status endpoint and the tests share it.
//
// PO DECISION 16-10-2026: the admin user should also be a premium user, not the normal user. The mechanism is a REAL row in
// user_entitlements (entitlement_source 'staff_admin'), written by the database whenever a staff role is assigned and ended when the
// last staff role is removed. It is deliberately NOT a code shortcut: the consumer Premium checks (lib/entitlements/financialDataImport.ts,
// lib/ai/access/premiumAiAccess.ts, lib/services/entitlementWindow.ts effectivePlanTier, the SQL AI functions) read ONLY the entitlement
// row and know nothing about roles. tests/unit/staffPremiumNoRoleShortcut.test.ts fails if that ever changes.
//
// The single definition of who counts as staff is the SQL function public.is_staff_premium_account(). STAFF_PREMIUM_RESOURCE_ROLES
// mirrors its role list; a PGlite test asserts the two agree.

/** The entitlement_source value of an automatic staff entitlement. */
export const STAFF_PREMIUM_SOURCE = 'staff_admin' as const;

/**
 * The Resources roles that make an account staff (together with a row in admin_users, i.e. Super Admin).
 * PO decision D1 (16-10-2026): Super Admin, Resource Administrator and Editor only. Changing this list means changing the SQL function and
 * running the reconcile preview (it lists who would start and who would end); the test keeps the two in step.
 */
export const STAFF_PREMIUM_RESOURCE_ROLES = ['resource_admin', 'editor'] as const;

/** Resources roles that open the Admin area but do NOT qualify (PO decision D1, 16-10-2026). Listed so a test can show the split is deliberate. */
export const STAFF_PREMIUM_EXCLUDED_RESOURCE_ROLES = ['author', 'compliance_reviewer', 'publisher', 'analyst'] as const;

/** What the person is told on their own billing page. Never worded as a purchase and never offers a cancel flow. */
export const STAFF_PREMIUM_PLAN_LABEL = 'Premium (included with your FHIP staff account)';
export const STAFF_PREMIUM_PROMO_NOTE =
  'Your FHIP staff account already includes Premium, so a promo code is not needed. It lasts while you hold a staff role and has no payment attached.';

/** The states the Admin screen shows for a staff account (admin_list_staff_premium). */
export type StaffPremiumState = 'staff_premium' | 'paid_subscription' | 'not_applied' | 'stray_staff_row';

export const STAFF_PREMIUM_STATE_LABEL: Record<StaffPremiumState, string> = {
  staff_premium: 'Staff Premium (automatic, no end date)',
  paid_subscription: 'Paid subscription (a paid plan wins; Staff Premium takes over if it ends)',
  not_applied: 'Not applied yet (the backfill has not been run for this account)',
  stray_staff_row: 'Needs review (holds a staff entitlement but no longer a staff role)',
};

export const SOURCE_LABEL_STAFF = 'Staff (automatic)';

/** Error body for an admin who tries to grant, extend or revoke a staff entitlement on the Premium Access screen. */
export const STAFF_PREMIUM_NOT_MANAGEABLE = {
  status: 409,
  code: 'ENTITLEMENT_STAFF_PREMIUM',
  message:
    'This account has Premium because it is an FHIP staff account. That entitlement is automatic: it cannot be granted, extended or revoked here, and it ends only when the account no longer holds a staff role.',
} as const;

/** Redeem route answer for a staff account that enters a promo code. */
export const STAFF_PREMIUM_PROMO_REFUSAL = {
  status: 409,
  code: 'PROMO_STAFF_PREMIUM',
  message: STAFF_PREMIUM_PROMO_NOTE,
} as const;

export interface StaffPremiumListRow {
  user_id: string;
  email: string | null;
  roles: string | null;
  plan_tier: 'free' | 'premium';
  entitlement_source: string;
  effective_from: string | null;
  entitlement_active: boolean;
  state: StaffPremiumState;
}

export function isStaffPremiumSource(source: unknown): boolean {
  return source === STAFF_PREMIUM_SOURCE;
}
