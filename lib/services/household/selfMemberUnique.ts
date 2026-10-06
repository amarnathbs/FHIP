/**
 * Migration 0276 gives the database the rule "at most one ACTIVE self household member per user"
 * (partial unique index uq_household_members_one_active_self). This is the one place that recognises
 * its violation, so the callers answer it the same way. The rule limits ONLY self rows: every other
 * relationship, and every inactive row, is unrestricted, and household size has no cap.
 */
export const SELF_UNIQUE_INDEX = 'uq_household_members_one_active_self';

export const SELF_ALREADY_EXISTS_MESSAGE =
  'You already have a "Self" member in this household. Only one is allowed; choose it from the list, or add a different person (spouse, partner, child or another relative).';

export function isDuplicateSelfMemberError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === '23505' && String(error.message ?? '').includes(SELF_UNIQUE_INDEX);
}
