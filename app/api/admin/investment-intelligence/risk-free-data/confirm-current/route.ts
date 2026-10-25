// Risk-free Rate Data -- confirm that a policy-change series (the RBI repo rate) is still current through a date.
//
// WHY THIS EXISTS (19-10-2026): confirming "no rate change happened" used to mean re-submitting a data file with a date typed beside it,
// which is the wrong act (a data attestation for no data) and, when the date did not move, said nothing. This is the dedicated control: one
// date, one reason, one recorded answer, no rate row touched. The database function (migration 0294) refuses a weekly series, a date in the
// future (India calendar), a date earlier than the last published rate and a date that is not later than the one already recorded.
//
// ADMIN ARCHITECTURE STANDARD: capability riskFreeDataUpload (admin_users.can_upload_risk_free_data) ONLY, no new capability (s2: confirming
// a series is an upload duty). Four layers: DB -- confirm_risk_free_verified_through() checks auth.uid() and is_risk_free_data_admin() itself;
// API -- requireRiskFreeCapability('upload') below (401 / 403, never an empty 200); page -- requireRiskFreePage(); nav -- adminNav.
// Caller's own session client, never the service role (s4, s6). A refusal is an explicit error with a sentence for a person (s8, s13).
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, bad, badValidation } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { requireRiskFreeCapability } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { confirmCurrentBodySchema, rpcFailure } from '@/lib/services/investment-intelligence/nav2/riskFreeAdminService';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireRiskFreeCapability('upload');
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return bad('The request body is not valid JSON.', 400);
  }
  const parsed = confirmCurrentBodySchema.safeParse(json);
  if (!parsed.success) return badValidation(parsed.error);
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.rpc('confirm_risk_free_verified_through', { p_series_id: parsed.data.seriesId, p_verified_through: parsed.data.throughDate, p_reason: parsed.data.reason });
  if (error) {
    // The function's own sentences for a refused confirmation (22023) are written for a person: pass them on, never a bare status code.
    if (error.code === '22023' && typeof error.message === 'string') return Response.json({ error: error.message.replace(/^risk-free confirmation: /, '') }, { status: 422 });
    return rpcFailure(error, 'risk-free confirmation');
  }
  return ok(data);
});
