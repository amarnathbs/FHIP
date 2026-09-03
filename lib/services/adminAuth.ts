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

// Admin A0.2 Wave 4 — Gate G6 (raw PostgREST error-message redaction).
//
// Every one of the 19 call sites this gate names shared the same defect:
// `bad(error.message)`, which returns whatever string Postgres/PostgREST
// produced — including table names, column names, constraint names and
// function names — straight to the client, and (worse) collapses every
// distinct failure mode (not-found, conflict, validation, transport) into
// the same generic 400. This maps a Postgres/PostgREST error to one of the
// canonical result states (spec §12.1) with a safe, stable, administrator-
// facing message and machine-readable `code`, while the ORIGINAL error is
// still logged server-side for real diagnosis.
//
// The response envelope is DELIBERATELY still `{ error: string, code }` —
// not a nested `{ error: { code, message } }` shape — because every
// existing Benchmarks-tab consumer reads `json.error` as a plain string
// (`alert(json.error ?? 'Could not update source')`, confirmed by direct
// read of components/admin/AdminBenchmarksClient.tsx) and would render
// `[object Object]` if `error` became an object. `code` is purely additive.
export type SafeErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_FAILED' | 'DEPENDENCY_UNAVAILABLE' | 'INTERNAL_ERROR';

interface PostgrestLikeError {
  message?: string;
  code?: string;
}

export function safeDbError(error: PostgrestLikeError | null | undefined, context: string): Response {
  const code = error?.code ?? '';

  // PostgREST's own "no rows / multiple rows" signal from .single() —
  // the overwhelmingly common real-world cause is "no rows" (a genuine
  // not-found); the rarer "multiple rows" case is itself a data anomaly
  // that must not be disclosed to the client either way, so both resolve
  // to the same safe 404.
  if (code === 'PGRST116') {
    return respond('The requested item was not found.', 'NOT_FOUND', 404);
  }
  if (code === '23505') {
    // unique_violation
    return respond('This already exists or conflicts with an existing record.', 'CONFLICT', 409);
  }
  if (code === '23503') {
    // foreign_key_violation
    return respond('This references a record that does not exist.', 'VALIDATION_FAILED', 422);
  }
  if (code === '23502' || code === '23514' || code === '22P02' || code === '22023') {
    // not_null_violation / check_violation / invalid_text_representation /
    // a scheduling-style validation raise (see lib/resources/workflow.ts's
    // own precedent for 22023) — all genuine, fixable input problems.
    return respond('The submitted data is invalid.', 'VALIDATION_FAILED', 422);
  }
  if (code.startsWith('08') || code === '57014' || code === '55000') {
    // Connection-class (Class 08) errors, statement timeout, or object not
    // in the prerequisite state (55000 — Wave 2's own deliberate choice for
    // a stale/conflicting concurrent write, never 40001 — see the
    // FHIP_A02_Wave2_Terminal_Report.md's own SQLSTATE discipline, not
    // reopened here).
    return respond('This service is temporarily unavailable. Please try again shortly.', 'DEPENDENCY_UNAVAILABLE', 503);
  }

  // Unexpected — never forward `error.message` itself (it can name an
  // internal table, column, constraint or function). Full detail is
  // logged server-side only, for real diagnosis.
  console.error(`${context} — unexpected database error:`, error);
  return respond('Something went wrong. Please try again.', 'INTERNAL_ERROR', 500);
}

function respond(message: string, code: SafeErrorCode, status: number): Response {
  return Response.json({ error: message, code }, { status });
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
