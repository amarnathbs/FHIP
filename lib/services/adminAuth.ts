import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';
import type { User } from '@supabase/supabase-js';

// Admin routes use the service-role client for writes (bypassing RLS on the
// reference tables), but only after confirming the caller is a real admin —
// admin_users itself is RLS-scoped so a user can only ever read their OWN
// flag, never grant it to themselves (spec section 20/26: no benchmark
// governance action without a real, auditable admin).
//
// Mandatory Country Confirmation, round-2 closure (MCC-2): every one of the
// ~14 Benchmarks/Recommendations admin routes calls this single function, so
// adding the country-confirmation check HERE — rather than at each of those
// call sites — closes the gap for all of them at once, the same "one
// canonical guard" pattern already used for requireUser(). An admin whose
// own country is unconfirmed is blocked from admin API routes exactly like
// every other authenticated user is blocked from financial API routes; no
// exemption is given for Admin status itself (spec 1.2: admin is denied
// "unless the repository proves that a separately controlled administrator
// path is required for remediation" — it does not, see the closure report).
export async function requireAdmin(): Promise<{ user: User | null; forbidden: Response | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, forbidden: bad('unauthenticated', 401) };

  const { data: adminRow } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!adminRow) return { user: null, forbidden: bad('Admin access required', 403) };

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { user: null, forbidden: countryBlock };

  return { user, forbidden: null };
}

export function adminClient() {
  return createAdminClient();
}

// Wraps an admin route handler so any thrown error (most notably
// createAdminClient() throwing synchronously on a missing/misconfigured
// env var, but also any other unexpected exception) becomes a normal JSON
// error response instead of an uncaught crash. Without this, an uncaught
// throw inside a route handler skips straight past Next.js's ability to
// send a response body at all — on Amplify's hosting compute this surfaces
// to the browser as an empty-body 500 with no error text (CloudFront
// synthesizes its own generic error page), which is indistinguishable from
// a dozen other causes. Every admin/benchmarks route should be wrapped in
// this so a misconfiguration is diagnosable from the Network tab alone.
export function adminRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('Admin route error:', err);
      return bad(err instanceof Error ? err.message : 'Unexpected server error', 500);
    }
  };
}
