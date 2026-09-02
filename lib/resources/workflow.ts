// Resources / Financial Knowledge & Insights — R1.1 workflow helper.
//
// Thin, typed wrapper around the public.transition_resource_post_status RPC
// (supabase/migrations/0033_resources_foundation.sql). All the actual
// permission and compliance-workflow enforcement (spec §41-44) lives in
// that SQL function — this wrapper exists so R1.2's server actions have a
// typed call site instead of a raw .rpc('transition_resource_post_status', ...)
// scattered across route handlers, and so errors come back as the same
// `bad()`-shaped Response the rest of the app already uses.

import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import type { ResourceStatus } from './types';

export async function transitionResourcePostStatus(
  postId: string,
  toStatus: ResourceStatus,
  opts?: { reason?: string; notes?: string }
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { data, error } = await supabase.rpc('transition_resource_post_status', {
    p_post_id: postId,
    p_to_status: toStatus,
    p_reason: opts?.reason ?? null,
    p_notes: opts?.notes ?? null,
  });

  if (error) {
    // The RPC raises plain `raise exception '<message>'` for every
    // permission/workflow rule it enforces (spec §41-44) — surface that
    // message directly rather than a generic "forbidden", since it already
    // names the specific rule that blocked the transition (e.g. "AMBER
    // content must have a recorded Compliance Reviewer approval..."). Not
    // authenticated / not found map to 401/404; every other DB-raised
    // exception is a permission or workflow-state violation, so 403 is the
    // correct default rather than 500 for those, matching how a client
    // should treat "you may not do this" vs "the server broke".
    const msg = error.message ?? 'Workflow transition failed';

    // Admin A0.2 Wave 2 (Scope B). Two narrow, additive mappings so that a
    // scheduling rejection is reported identically for all four content
    // types and never leaks raw SQL. Everything else keeps its existing,
    // already-certified behaviour exactly.
    //
    //   22023 — the canonical scheduling invariant inside
    //           transition_resource_post_status (migration 0116). This is a
    //           validation failure the administrator can fix, not a
    //           permission failure, so it is a 422 with a scheduled_at field
    //           reference — the same envelope the route-level pre-check
    //           returns.
    if (error.code === '22023') {
      return Response.json({ error: msg, code: 'SCHEDULED_AT_INVALID_TRANSITION', fields: { scheduled_at: msg } }, { status: 422 });
    }
    //   23514 — the raw chk_resource_posts_scheduled_at CHECK constraint.
    //           Unreachable now that the RPC checks first, but if it is ever
    //           reached again the client must NOT receive the internal
    //           constraint name; it gets the same canonical message instead.
    if (error.code === '23514' && /chk_resource_posts_scheduled_at/.test(msg)) {
      const canonical = 'A publish date and time is required before this content can be scheduled.';
      console.error('Resources workflow: scheduled_at CHECK constraint reached despite the RPC guard:', error);
      return Response.json({ error: canonical, code: 'SCHEDULED_AT_REQUIRED', fields: { scheduled_at: canonical } }, { status: 422 });
    }

    // Admin A0.2 Wave 5 (§9 result-state accuracy, §19 no raw SQL errors).
    //
    // The reasoning above — "surface the RPC's own message, because it names
    // the exact workflow rule that blocked the transition" — is correct, but
    // it was applied to EVERY database error, not only to the RPC's own
    // deliberate `raise exception`. So an RLS denial, a check-constraint
    // violation, a statement timeout or a dropped connection was also
    // forwarded verbatim to the workflow panel, which renders it to the
    // author unfiltered. That could show an author a string such as
    // `new row violates row-level security policy for table "resource_posts"`
    // — a real table name, and no guidance at all.
    //
    // PL/pgSQL's own `raise exception '<message>'` always carries SQLSTATE
    // P0001 (raise_exception). That is precisely the set of messages the
    // function authors wrote for a human, so P0001 keeps its existing,
    // already-certified pass-through behaviour byte for byte. Anything else
    // is an engine error: it is logged in full server-side and reported as a
    // safe, correctly-classified failure instead of a 403 that wrongly reads
    // as "you are not allowed to do this".
    const isAuthoredRuleMessage = error.code === 'P0001' || error.code === undefined || error.code === null;

    if (isAuthoredRuleMessage) {
      if (/not authenticated/i.test(msg)) return bad(msg, 401);
      if (/not found/i.test(msg)) return bad(msg, 404);
      return bad(msg, 403);
    }

    console.error('Resources workflow: unexpected database error during transition:', error);
    if (error.code === '42501') {
      return bad('You do not have permission to make this workflow change.', 403);
    }
    if (typeof error.code === 'string' && (error.code.startsWith('08') || error.code === '57014')) {
      return bad('This service is temporarily unavailable. Nothing was changed — try again shortly.', 503);
    }
    return bad('This workflow change could not be completed, and nothing was changed. Try again; if it keeps happening, report it with the time you saw it.', 500);
  }

  return ok(data);
}
