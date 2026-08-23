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
    if (/not authenticated/i.test(msg)) return bad(msg, 401);
    if (/not found/i.test(msg)) return bad(msg, 404);
    return bad(msg, 403);
  }

  return ok(data);
}
