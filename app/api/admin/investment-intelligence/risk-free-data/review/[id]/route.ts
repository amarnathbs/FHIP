// Risk-free Rate Data -- resolve one review-queue item (accept the candidate value, or reject it with a note).
// Capability: riskFreeDataUpload ONLY (the switch capability does not confer it). Runs under the caller's own session
// client so resolve_risk_free_review_item() authorises with auth.uid(). Explicit 401/403 on every verb (Standard s4).
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, bad, badValidation } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { requireRiskFreeCapability } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { reviewBodySchema, rpcFailure } from '@/lib/services/investment-intelligence/nav2/riskFreeAdminService';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = adminRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireRiskFreeCapability('upload');
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad('The review item id is not valid.', 400);
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return bad('The request body is not valid JSON.', 400);
  }
  const parsed = reviewBodySchema.safeParse(json);
  if (!parsed.success) return badValidation(parsed.error);
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.rpc('resolve_risk_free_review_item', { p_item_id: id, p_decision: parsed.data.decision, p_note: parsed.data.note });
  if (error) return rpcFailure(error, 'risk-free review resolve');
  return ok(data);
});
