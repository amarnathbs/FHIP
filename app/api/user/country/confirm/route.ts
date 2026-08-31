// POST /api/user/country/confirm — the ONLY way country_confirmed_at /
// country_source can ever be set for a self-service (non-admin) user.
//
// Deliberately a separate endpoint from PUT /api/user/profile rather than
// adding country_confirmed_at to that route's schema: profileSchema is a
// general partial-update surface, and spec section 8.2 requires "Forged
// country_confirmed_at" and "client cannot mark country_source=
// ADMIN_CORRECTED" to be rejected server-side. Keeping confirmation on its
// own route with its own tiny, closed request schema (ONE field:
// country_of_residence) makes both of those structurally true — there is no
// field in the request body this route reads that could set either column
// to a client-chosen value; country_confirmed_at is always `now()` computed
// server-side and country_source is always the literal 'USER_CONFIRMED'.
//
// Uses requireUser() (auth-only), not requireCountryConfirmedUser() — this
// is exactly the "narrowly required endpoint used to save and validate the
// country selection" spec section 1.2 requires to stay reachable pre-
// confirmation.
import { z } from 'zod';
import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { classifyCountryValue, SUPPORTED_COUNTRY_CODES } from '@/lib/services/countryGate';
import { recordCountryAuditEvent } from '@/lib/services/countryAudit';

const confirmSchema = z.object({
  country_of_residence: z.string().min(1, 'Country of residence is required.'),
});

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const bodyResult = confirmSchema.safeParse(await req.json().catch(() => null));
  if (!bodyResult.success) return bad('COUNTRY_INVALID', 422);

  const raw = bodyResult.data.country_of_residence;
  const shape = classifyCountryValue(raw);
  if (shape === 'MISSING' || shape === 'INVALID') return bad('COUNTRY_INVALID', 422);
  if (shape === 'UNSUPPORTED') return bad('COUNTRY_UNSUPPORTED', 403);

  const country = raw.trim().toUpperCase();
  if (!(SUPPORTED_COUNTRY_CODES as readonly string[]).includes(country)) {
    // Defensive — classifyCountryValue already guarantees this branch is
    // unreachable for a well-formed, currently-supported code, but a
    // security-relevant gate never trusts a single check alone.
    return bad('COUNTRY_UNSUPPORTED', 403);
  }

  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase
    .from('user_profiles')
    .select('country_of_residence')
    .eq('user_id', user.id)
    .maybeSingle();
  if (readError) return bad('OPERATIONAL_ERROR', 500);
  if (!existing) return bad('PROFILE_INCOMPLETE', 403);

  const previousCountry = existing.country_of_residence;
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('user_profiles')
    .update({
      country_of_residence: country,
      country_confirmed_at: nowIso,
      country_source: 'USER_CONFIRMED',
      country_updated_at: nowIso,
      updated_at: nowIso,
    })
    .eq('user_id', user.id)
    .select('country_of_residence, country_confirmed_at, country_source')
    .single();

  if (error) return bad('OPERATIONAL_ERROR', 500);

  await recordCountryAuditEvent({
    userId: user.id,
    eventType: 'country_confirmed',
    previousCountry,
    newCountry: country,
    actor: 'self',
  });

  return ok(data);
}
