import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { loadRetirementPlanningContext } from '@/lib/services/retirementMemberData';
import { retirementMemberPatchSchema } from '@/lib/validation/retirementMember';

// GET returns everything the Retirement Planning UI needs in one call: the
// user's Self (and Spouse, if the household model says a spouse applies)
// retirement-member rows, whether a Spouse card should even be shown, the
// user's current age (Profile remains the canonical DOB source -- spec
// s.7), and the approved country-default suggested age.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  try {
    const context = await loadRetirementPlanningContext(user.id, supabase);
    return ok(context);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load retirement planning data');
  }
}

// PATCH upserts exactly one member's (self or spouse) target retirement
// age. Canonical mutation path (spec s.50) -- every request is
// authenticated (requireUser), scoped to the caller's own user_id (never
// trusts a client-supplied user_id), validated for a plausible member_type
// and age server-side (not just client-side), and a spouse row can only be
// created/edited when the household model genuinely has a spouse (spec
// s.9/50 "valid member role") -- defence in depth behind the UI's own
// conditional display.
export async function PATCH(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = retirementMemberPatchSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { member_type, target_retirement_age, country_code } = parsed.data;

  const supabase = await createClient();

  if (member_type === 'spouse') {
    const context = await loadRetirementPlanningContext(user.id, supabase);
    if (!context.spouseApplicable) {
      return bad('No spouse/partner is recorded on this household — update the household profile first.', 422);
    }
  }

  // Upsert keyed on the existing unique(user_id, member_type) constraint
  // (migration 0072) -- reactivates and re-confirms a previously
  // deactivated row rather than creating a duplicate (spec s.10/51).
  // is_active is always forced true here: this endpoint is only ever
  // reached from the active Retirement Planning UI, so any write through
  // it is by definition re-activating that member's planning data.
  const { data, error } = await supabase
    .from('retirement_members')
    .upsert(
      {
        user_id: user.id,
        member_type,
        target_retirement_age,
        ...(country_code ? { country_code } : {}),
        age_source: target_retirement_age === null ? 'needs_confirmation' : 'user_confirmed',
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,member_type' }
    )
    .select('id, member_type, target_retirement_age, country_code, age_source, is_active, created_at, updated_at')
    .single();

  return error ? bad(error.message) : ok(data);
}
