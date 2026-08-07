import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getOrCreateForecastProfile, ensureDefaultScenario } from '@/lib/services/forecastData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const scenario = await ensureDefaultScenario(user.id, profile.id);
    return ok({ profile, defaultScenario: scenario });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load forecast profile');
  }
}

// Forecasting P1 fix FHIP-FC-RET-001 — lets a user set the retirement-timing
// fields that today have no write path at all (retirement_age has existed
// on forecast_profiles since Phase 4 with no UI/route ever writing it).
export async function PATCH(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));

  const patch: Record<string, number | string | null> = {};
  if ('retirement_age' in body) {
    const age = body.retirement_age === null || body.retirement_age === '' ? null : Number(body.retirement_age);
    if (age !== null && (!Number.isFinite(age) || age <= 0 || age >= 120)) return bad('retirement_age must be between 1 and 119', 422);
    patch.retirement_age = age;
  }
  if ('retirement_date' in body) {
    patch.retirement_date = body.retirement_date === '' ? null : (body.retirement_date ?? null);
  }
  if ('retirement_timing_override_months' in body) {
    const months = body.retirement_timing_override_months === null || body.retirement_timing_override_months === '' ? null : Number(body.retirement_timing_override_months);
    if (months !== null && (!Number.isFinite(months) || months < 0)) return bad('retirement_timing_override_months must be 0 or greater', 422);
    patch.retirement_timing_override_months = months;
  }
  if (Object.keys(patch).length === 0) return bad('No recognised fields in request body', 422);

  const supabase = await createClient();
  const profile = await getOrCreateForecastProfile(user.id, supabase);
  const { data, error } = await supabase.from('forecast_profiles').update(patch).eq('id', profile.id).select('*').single();
  if (error) return bad(error.message);
  return ok(data);
}
