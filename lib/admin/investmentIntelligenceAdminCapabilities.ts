import { createClient } from '@/lib/supabase/server';
import { PC6_ADMIN_CAPABILITY } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';
import { PC7_ADMIN_CAPABILITY } from '@/lib/services/investment-intelligence/pc7/lookthroughDataAdmin';

// Admin A2-A5, A2A5_00 reconciliation finding: `app/api/admin/me/route.ts`
// (PC6/N.11, PC7/O.9) defined these two capability checks as private,
// route-local functions. The canonical Admin shell's server-side layout
// (`app/(app)/admin/layout.tsx`) needs the SAME two capabilities to compute
// its nav model without a client-side round trip — per A2-WP's own binding
// instruction ("reuse canonical shared components and predicates; do not
// introduce a competing resolver"), this extracts them here as the single
// shared source of truth, re-exported by `app/api/admin/me/route.ts` for
// backward compatibility rather than duplicated.
//
// Each capability lives on `admin_users`, not on `resource_user_roles`, so
// it cannot be read from `getCurrentResourceRoles()`'s snapshot — it needs
// its own independent read (Standard §2: capabilities may share lower-level
// role-resolution helpers, but each remains separately named/tested).
//
// FAILS CLOSED in both: any error, a logged-out caller, or a missing
// row/column yields false. A missing column (an unapplied migration) must
// never become a grant.

/** PC6/N.11 — Reference-data quality admin capability. */
export async function canViewReferenceDataQuality(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase.from('admin_users').select(PC6_ADMIN_CAPABILITY).eq('user_id', user.id).maybeSingle();
    return data?.[PC6_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}

/**
 * PC7/O.9 — Underlying Fund Look-Through data-quality admin capability.
 * A SEPARATE read from the PC6 one, deliberately — deriving it from
 * canViewReferenceDataQuality() would make one grant silently confer the
 * other, which is precisely the capability-implication Standard §2 prohibits.
 */
export async function canViewLookthroughDataQuality(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { data } = await supabase.from('admin_users').select(PC7_ADMIN_CAPABILITY).eq('user_id', user.id).maybeSingle();
    return data?.[PC7_ADMIN_CAPABILITY] === true;
  } catch {
    return false;
  }
}
