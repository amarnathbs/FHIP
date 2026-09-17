import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listBusinessEntities, createBusinessEntity } from '@/lib/services/businessEntityData';
import {
  businessEntityCreateInputSchema,
  BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY,
} from '@/lib/validation/businessEntity';
import { getUserFullExperienceHomeCountry } from '@/lib/services/jurisdiction';

// LR-11 (Company / Family Trust Entity Architecture). Company and Family
// Trust have no jurisdiction gate at all — WP-09's own lesson is that
// Company/Trust must NOT copy SMSF's AU-only assumption without actual
// evidence a restriction is warranted; `country_code` on the entity is purely
// informational (nullable = no restriction), never enforced by a trigger.
//
// M4B — HUF is the one exception, and only for HUF. See the POST handler.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listBusinessEntities(user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityCreateInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();

  // M4B — India-only gate for entity_type = 'huf' (Product Owner decision
  // 2026-09-15, closing PO-PC5-1). A Hindu Undivided Family is a creature of
  // Indian personal law with no analogue in any other jurisdiction this
  // platform serves.
  //
  // This is the ESTABLISHED FHIP jurisdiction-gate idiom, reused rather than
  // reinvented: resolve the caller's AUTHORITATIVE home country with
  // `getUserFullExperienceHomeCountry()` and fail closed on anything else —
  // exactly the shape of
  // `app/api/financial-data-hub/investment-statement/upload/route.ts:44-52`
  // (AU-only) and its paired account-match route. The country comes from
  // `user_profiles.country_of_residence`; it is NEVER read from the request
  // body, never derived from `currency_code`, and never defaulted (a null —
  // an unresolved or GENERIC-experience country — is refused, not treated as
  // India).
  //
  // `requireCountryConfirmedUser` above has already established that this
  // user has CONFIRMED a country at all (Mandatory Country Confirmation), so
  // the two guards compose: confirmed, and confirmed as India.
  //
  // DEFENCE IN DEPTH, not the only defence. `business_entities` RLS is
  // `for all using (auth.uid() = user_id)` (migration 0134), so a user can
  // insert straight through PostgREST without ever reaching this route; the
  // real backstop is `trg_business_entities_huf_india_gate` (migration 0154),
  // which refuses the same insert at the database with SQLSTATE 42501. This
  // check exists so the app's own route answers with an honest, readable
  // 403 instead of surfacing a raw Postgres error.
  const requiredCountry = BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY[parsed.data.entity_type];
  if (requiredCountry) {
    const homeCountry = await getUserFullExperienceHomeCountry(user.id, supabase);
    if (homeCountry !== requiredCountry) {
      return bad(
        'A Hindu Undivided Family (HUF) can only be added by accounts confirmed in India. You can still add a company or a family trust.',
        403,
        'ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY'
      );
    }
  }

  const { data, error } = await createBusinessEntity(user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}
