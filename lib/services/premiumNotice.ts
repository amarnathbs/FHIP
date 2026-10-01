import { computeEntitlementReminder, type EntitlementReminder } from '@/lib/services/entitlementReminder';
import { utcToday } from '@/lib/services/entitlementWindow';

// Server-side loader for the in-app expiry notice (the app-wide banner rendered
// by app/(app)/layout.tsx, and the reminder returned by GET /api/payments/status).
//
// A USER NEVER SEES ANOTHER USER'S NOTICE. The only row read is the one whose
// user_id equals the id of the already-authenticated session user passed in, on
// the caller's own session client (so RLS "select own" is a second guard), and
// the computation (computeEntitlementReminder) is a pure function of that single
// row. There is no code path that can mention anyone else.
//
// FAIL SOFT: a missing column (migration not yet applied), a read error or no row
// all yield "no notice". A reminder is advisory UX and must never break page
// rendering or claim something it could not verify.

interface OwnRowClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
    };
  };
}

export const NO_REMINDER: EntitlementReminder = Object.freeze({
  kind: 'none',
  source: null,
  endsOn: null,
  days: null,
  key: null,
  title: null,
  message: null,
});

export async function getOwnEntitlementReminder(client: OwnRowClient, userId: string, today: string = utcToday()): Promise<EntitlementReminder> {
  try {
    const { data, error } = await client
      .from('user_entitlements')
      .select('plan_tier, effective_from, effective_to, entitlement_source')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return NO_REMINDER;
    return computeEntitlementReminder(data as Parameters<typeof computeEntitlementReminder>[0], today);
  } catch {
    return NO_REMINDER;
  }
}
