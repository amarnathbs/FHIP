import { createClient } from '@/lib/supabase/server';
import { householdSchema } from '@/lib/validation/household';
import { ok, bad } from '@/lib/api';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// Mandatory Country Confirmation, round-2 closure (MCC-7): this route used
// its own inline auth check (not lib/api.ts's requireUser()/
// requireCountryConfirmedUser()), so it was not covered by the 187-route
// import-alias switch.
//
// Round-3 closure (Gap 1): this is now the ONLY caller in the entire
// gated API surface that passes `{ allowDuringOnboarding: true }` — every
// other route (including goals/route.ts, which used to rely on the same
// exemption before the onboarding wizard's optional first-goal write moved
// out of onboarding entirely) requires a genuinely confirmed country
// regardless of onboarding_completed. This is deliberately narrow: only
// GET/PUT on this one route get the flag, matching the DB trigger's own
// households-only exemption exactly.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id, { allowDuringOnboarding: true });
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

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id, { allowDuringOnboarding: true });
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
