// Risk-free Rate Data -- correct ONE published value (the only way a published value ever changes). The database
// function records who, why and the previous value in an append-only ledger and raises a correction event (migration
// 0262) so the NAV2 cache is invalidated. Capability: riskFreeDataUpload ONLY. Caller's own session client.
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, bad, badValidation } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { requireRiskFreeCapability } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { correctionBodySchema, rpcFailure } from '@/lib/services/investment-intelligence/nav2/riskFreeAdminService';

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
  const parsed = correctionBodySchema.safeParse(json);
  if (!parsed.success) return badValidation(parsed.error);
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.rpc('correct_risk_free_observation', { p_series_id: parsed.data.seriesId, p_date: parsed.data.date, p_new_value: parsed.data.newValue, p_reason: parsed.data.reason });
  if (error) return rpcFailure(error, 'risk-free correction');
  return ok(data);
});
