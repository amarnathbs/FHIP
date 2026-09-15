/**
 * PC5 (M4) — K.20: the real capability check PC5 supplies to AIE's
 * exception interface.
 *
 * `Pc5ExceptionInterfaceDeps.checkCapability` was deliberately left as a
 * REQUIRED, caller-supplied function with no default when the AIE-side seam
 * was built, and its own header says why: *"PC5 not existing means this
 * mission has no real capability/permission model to hard-code (inventing
 * one would itself be the 'labelling a stub as completed integration' the
 * mission explicitly forbids)... there is no default that 'allows
 * everything', which would defeat the whole point."*
 *
 * This file is PC5 supplying it, for real.
 *
 * THE RULE, AND WHY IT IS THIS NARROW. A caller may resolve an AIE
 * unresolved item if and only if they ARE the tenant that owns it.
 * `callerId === targetUserId`, and nothing else.
 *
 * That looks almost trivially strict, so it is worth stating what was
 * checked before settling on it rather than something richer. This
 * codebase has three delegated-access shapes, and NONE of them extends to
 * AIE exceptions:
 *   - `ii_audit_events.event_type` includes `'professional_access'` and
 *     `'permission_grant'`/`'permission_revoke'`, but those are Investment
 *     Intelligence audit vocabulary for a sharing feature; no table grants
 *     a third party read or write over another user's `aie_*` rows, and
 *     every `aie_*` RLS policy is `user_id = auth.uid()` with no exception.
 *   - Admin capabilities exist (`docs/admin/FHIP_ADMIN_ARCHITECTURE_
 *     STANDARD.md`), but PC5 builds no admin surface and deliberately does
 *     not: an administrator deciding whose money a statement represents,
 *     on a user's behalf, is a materially different product decision with
 *     its own consent and audit requirements, and inventing it here would
 *     be exactly the unauthorised scope creep this phase must not commit.
 *   - Household membership is a DATA relationship (`household_members`),
 *     not an auth one: household members are rows a single authenticated
 *     user owns, not separate logins. So "my spouse can resolve my
 *     exception" is not expressible in this system today and must not be
 *     faked by loosening this check.
 *
 * So the honest capability model is same-tenant-only. Making it wider would
 * grant access no other part of the system grants. It is a function rather
 * than an inline comparison so that a future, genuine delegation model has
 * one place to be added, with tests already pointed at it.
 *
 * WHY A SECOND LAYER STILL MATTERS EVEN THOUGH THIS ONE LOOKS SUFFICIENT.
 * Every underlying query is independently scoped by `.eq('user_id', ...)`,
 * so a bug here alone cannot leak data. That is deliberate: the AIE seam's
 * own header describes the two layers as "neither replaces the other", the
 * same principle applied elsewhere in this codebase to S3 tag-based access
 * control. This check exists to produce a clean, auditable REFUSAL; the
 * query filter exists to make a leak impossible even if this check were
 * wrong.
 */

import type { Pc5ExceptionInterfaceDeps } from '@/lib/aie/pc5/pc5ExceptionInterface';

export function createPc5CapabilityDeps(): Pc5ExceptionInterfaceDeps {
  return {
    checkCapability: async (callerId: string, targetUserId: string): Promise<boolean> => {
      // Both guards matter. An empty/undefined id must never compare equal
      // to another empty/undefined id and be treated as a match — that is
      // the classic "unauthenticated equals unauthenticated" bypass.
      if (!callerId || !targetUserId) return false;
      return callerId === targetUserId;
    },
  };
}
