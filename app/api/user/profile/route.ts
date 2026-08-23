import { createClient } from '@/lib/supabase/server';
import { profileSchema } from '@/lib/validation/profile';
import { ok, bad } from '@/lib/api';
import { deriveCohortKey, cohortKeyChanged, invalidateStaleTwinRuns } from '@/lib/services/twinStaleness';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { data, error } = await supabase.from('user_profiles').select('*').eq('user_id', user.id).single();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const parsed = profileSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  // Read the pre-update state (both this profile and the linked household,
  // which also feeds the Financial Twin's cohort match) so a change that
  // actually shifts the cohort key can be told apart from an unrelated field
  // save (e.g. toggling not_applicable_investments) — see twinStaleness.ts.
  const [{ data: beforeProfile }, { data: household }] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('date_of_birth, employment_status, country_of_residence')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('households')
      .select('dependants_count, household_type, housing_tenure, residence_type')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  const { data, error } = await supabase
    .from('user_profiles')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .select()
    .single();
  if (error) return bad(error.message);

  const householdFields = {
    dependantsCount: household?.dependants_count ?? 0,
    householdType: household?.household_type ?? null,
    housingTenure: household?.housing_tenure ?? null,
    residenceType: household?.residence_type ?? null,
  };
  const beforeKey = deriveCohortKey({
    countryOfResidence: beforeProfile?.country_of_residence ?? null,
    dateOfBirth: beforeProfile?.date_of_birth ?? null,
    employmentStatus: beforeProfile?.employment_status ?? null,
    ...householdFields,
  });
  const afterKey = deriveCohortKey({
    countryOfResidence: data.country_of_residence ?? null,
    dateOfBirth: data.date_of_birth ?? null,
    employmentStatus: data.employment_status ?? null,
    ...householdFields,
  });
  if (cohortKeyChanged(beforeKey, afterKey)) {
    // Best-effort: a Twin-invalidation hiccup should never block the user
    // from saving their own profile.
    await invalidateStaleTwinRuns(user.id, supabase).catch(() => undefined);
  }

  return ok(data);
}
