// Risk-free Rate Data -- switch a series ON/OFF or change its terms status (audited, reason required, no data deleted).
// Capability: riskFreeSeriesSwitch ONLY -- deliberately NOT the upload capability (separation of duties, Standard s3).
// Switching a series off turns every risk-free-dependent ratio into the typed `risk_free_missing` state for every customer.
// Caller's own session client, so set_risk_free_series_state() authorises with auth.uid().
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, bad, badValidation } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { requireRiskFreeCapability } from '@/lib/services/investment-intelligence/nav2/riskFreeAdmin';
import { seriesStateBodySchema, rpcFailure } from '@/lib/services/investment-intelligence/nav2/riskFreeAdminService';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireRiskFreeCapability('switch');
  if (forbidden || !user) return forbidden ?? bad('unauthenticated', 401);
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return bad('The request body is not valid JSON.', 400);
  }
  const parsed = seriesStateBodySchema.safeParse(json);
  if (!parsed.success) return badValidation(parsed.error);
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.rpc('set_risk_free_series_state', { p_series_id: parsed.data.seriesId, p_enabled: parsed.data.enabled, p_terms_status: parsed.data.termsStatus, p_reason: parsed.data.reason });
  if (error) return rpcFailure(error, 'risk-free series state');
  return ok(data);
});
