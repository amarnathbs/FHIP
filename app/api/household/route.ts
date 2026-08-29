import { createClient } from '@/lib/supabase/server';
import { householdSchema } from '@/lib/validation/household';
import { ok, bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// Mandatory Country Confirmation, round-2 closure (MCC-7): this route used
// its own inline auth check (not lib/api.ts's requireUser()/
// requireCountryConfirmedUser()), so it was not covered by the 187-route
// import-alias switch. countryConfirmationBlockResponse() already carries
// the same onboarding-not-yet-completed exemption requireCountryConfirmedUser
// does, so the onboarding wizard's own PUT /api/household call (made before
// onboarding_completed is set) is unaffected — only a POST-onboarding,
// country-unconfirmed caller is now blocked here, matching every other
// module.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { data, error } = await supabase.from('households').select('*').eq('user_id', user.id).maybeSingle();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const parsed = householdSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const { data: existing } = await supabase.from('households').select('id').eq('user_id', user.id).maybeSingle();

  const query = existing
    ? supabase
        .from('households')
        .update({ ...parsed.data, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    : supabase.from('households').insert({ ...parsed.data, user_id: user.id });

  const { data, error } = await query.select().single();
  return error ? bad(error.message) : ok(data);
}
