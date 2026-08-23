import { createClient } from '@/lib/supabase/server';
import { householdSchema } from '@/lib/validation/household';
import { ok, bad } from '@/lib/api';
import { deriveCohortKey, cohortKeyChanged, invalidateStaleTwinRuns } from '@/lib/services/twinStaleness';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { data, error } = await supabase.from('households').select('*').eq('user_id', user.id).maybeSingle();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const parsed = householdSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const [{ data: existing }, { data: profile }] = await Promise.all([
    supabase
      .from('households')
      .select('id, dependants_count, household_type, housing_tenure, residence_type')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase.from('user_profiles').select('date_of_birth, employment_status, country_of_residence').eq('user_id', user.id).maybeSingle(),
  ]);

  const query = existing
    ? supabase
        .from('households')
        .update({ ...parsed.data, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    : supabase.from('households').insert({ ...parsed.data, user_id: user.id });

  const { data, error } = await query.select().single();
  if (error) return bad(error.message);

  // See twinStaleness.ts — household fields (dependants, housing tenure,
  // residence type, household type) feed the Financial Twin's cohort match
  // exactly as much as date_of_birth does.
  const profileFields = {
    countryOfResidence: profile?.country_of_residence ?? null,
    dateOfBirth: profile?.date_of_birth ?? null,
    employmentStatus: profile?.employment_status ?? null,
  };
  const beforeKey = deriveCohortKey({
    ...profileFields,
    dependantsCount: existing?.dependants_count ?? 0,
    householdType: existing?.household_type ?? null,
    housingTenure: existing?.housing_tenure ?? null,
    residenceType: existing?.residence_type ?? null,
  });
  const afterKey = deriveCohortKey({
    ...profileFields,
    dependantsCount: data.dependants_count ?? 0,
    householdType: data.household_type ?? null,
    housingTenure: data.housing_tenure ?? null,
    residenceType: data.residence_type ?? null,
  });
  if (cohortKeyChanged(beforeKey, afterKey)) {
    // Best-effort: a Twin-invalidation hiccup should never block the user
    // from saving their own household.
    await invalidateStaleTwinRuns(user.id, supabase).catch(() => undefined);
  }

  return ok(data);
}
