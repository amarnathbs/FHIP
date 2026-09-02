// POST /api/user/country/confirm — the ONLY way country_confirmed_at /
// country_source can ever be set for a self-service (non-admin) user.
//
// Deliberately a separate endpoint from PUT /api/user/profile rather than
// adding country_confirmed_at to that route's schema: profileSchema is a
// general partial-update surface, and spec section 8.2 requires "Forged
// country_confirmed_at" and "client cannot mark country_source=
// ADMIN_CORRECTED" to be rejected server-side. Keeping confirmation on its
// own route with its own tiny, closed request schema makes both of those
// structurally true — there is no field in the request body this route reads
// that could set either column to a client-chosen value; country_confirmed_at
// is always `now()` computed server-side and country_source is always the
// literal 'USER_CONFIRMED'.
//
// Uses requireUser() (auth-only), not requireCountryConfirmedUser() — this
// is exactly the "narrowly required endpoint used to save and validate the
// country selection" spec section 1.2 requires to stay reachable pre-
// confirmation. G3 keeps that: a GENERIC-country user must be able to reach
// this route both before their first confirmation and afterwards.
//
// =============================================================================
// G3 — Registration and Existing-User Alignment
// =============================================================================
// Three things change here, and nothing else:
//
//  1. SERVER AUTHORITY OVER THE REGISTRY (spec section 6.3). The submitted
//     country is re-validated against the LIVE registry — exists, active,
//     inside its effective window, selectable, REGISTRATION enabled — and the
//     experience level is DERIVED from that registry read. The request body
//     has no field for an experience level or a capability flag, so a client
//     cannot forge FULL: there is nowhere to put it.
//
//  2. EXPLICIT GENERIC DISCLOSURE (spec section 7.2). Confirming a GENERIC
//     country requires an acknowledgement of the current disclosure version.
//     It is enforced here AND independently by the database
//     (trg_enforce_generic_disclosure, migration 0127), so a forged direct
//     PostgREST write that skipped this route is still rejected.
//
//  3. IDEMPOTENCY (spec section 6.3, scenario G3-25). A repeated confirmation
//     of the same country with the same acknowledgement is a no-op replay: it
//     returns the existing authoritative state and writes NO second audit
//     event. This matters for real retries — OAuth callback replays, a
//     double-submitted form, a flaky network — not just for the test matrix.
//
// What deliberately does NOT change: the landing-page cookie is never read
// here (a forged G2 cookie cannot influence this route, because this route
// has no access to it), no currency is written, no billing field is touched,
// no primary country is set, and no financial row is read or written.
import { z } from 'zod';
import { requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import {
  classifyCountryValue,
  SUPPORTED_COUNTRY_CODES,
  loadCountryRegistrySnapshot,
  isRegistrationPermitted,
} from '@/lib/services/countryGate';
import {
  isDisclosureAcknowledgementValid,
  GENERIC_DISCLOSURE_VERSION,
} from '@/lib/services/countryDisclosure';
import { recordCountryAuditEvent } from '@/lib/services/countryAudit';

// A two-field closed schema. Note what is absent and can therefore never be
// forged: experience_level, capabilities, country_confirmed_at,
// country_source, preferred_currency, primary_country, billing_country.
const confirmSchema = z.object({
  country_of_residence: z.string().min(1, 'Country of residence is required.'),
  acknowledged_disclosure_version: z.string().min(1).max(100).optional(),
});

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const bodyResult = confirmSchema.safeParse(await req.json().catch(() => null));
  if (!bodyResult.success) return bad('COUNTRY_INVALID', 422);

  const raw = bodyResult.data.country_of_residence;

  // 'GLOBAL' lands here as INVALID, not UNSUPPORTED — it is six characters,
  // so it fails the two-letter shape check before any registry lookup. It can
  // never be written: it is not in SUPPORTED_COUNTRY_CODES, there is no
  // `countries` row for it, and country_of_residence is a char(2) FK.
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

  // --- G3 step 1: registry authority -------------------------------------
  const registry = await loadCountryRegistrySnapshot(supabase);
  if (!registry) return bad('OPERATIONAL_ERROR', 500);

  const entry = registry.get(country);
  if (!isRegistrationPermitted(entry)) {
    // Covers: no registry row, inactive, not selectable, outside its
    // effective window, or REGISTRATION capability disabled. All are the same
    // honest answer to the user — this country is not one you can register
    // with right now — and all fail closed.
    return bad('COUNTRY_REGISTRATION_NOT_PERMITTED', 403);
  }
  const experienceLevel = entry!.experienceLevel;

  // --- G3 step 2: generic disclosure acknowledgement -----------------------
  const acknowledgedVersion = bodyResult.data.acknowledged_disclosure_version ?? null;
  if (!isDisclosureAcknowledgementValid({ experienceLevel, acknowledgedVersion })) {
    return bad('GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED', 422);
  }

  const { data: existing, error: readError } = await supabase
    .from('user_profiles')
    .select(
      'country_of_residence, country_confirmed_at, country_source, generic_disclosure_version, generic_disclosure_country'
    )
    .eq('user_id', user.id)
    .maybeSingle();
  if (readError) return bad('OPERATIONAL_ERROR', 500);
  if (!existing) return bad('PROFILE_INCOMPLETE', 403);

  const previousCountry = existing.country_of_residence;

  // --- G3 step 3: idempotent replay ---------------------------------------
  // Same country, already confirmed, and (for a generic country) the stored
  // acknowledgement already matches the current version for this same
  // country. Nothing to change and nothing new to record — return the
  // authoritative state and write NO audit event.
  const alreadyConfirmedIdentically =
    existing.country_confirmed_at != null &&
    existing.country_of_residence === country &&
    (experienceLevel !== 'GENERIC' ||
      (existing.generic_disclosure_version === GENERIC_DISCLOSURE_VERSION &&
        existing.generic_disclosure_country === country));

  if (alreadyConfirmedIdentically) {
    return ok({
      country_of_residence: existing.country_of_residence,
      country_confirmed_at: existing.country_confirmed_at,
      country_source: existing.country_source,
      experience_level: experienceLevel,
      generic_disclosure_version: existing.generic_disclosure_version ?? null,
      idempotent_replay: true,
    });
  }

  const nowIso = new Date().toISOString();

  // The disclosure columns are always written EXPLICITLY, in both directions.
  // Confirming a FULL country clears any acknowledgement left over from a
  // previous generic country — otherwise an AU user who had briefly been GB
  // would keep a stale acknowledgement row that no longer describes anything
  // true about their account.
  const disclosureFields =
    experienceLevel === 'GENERIC'
      ? {
          generic_disclosure_version: GENERIC_DISCLOSURE_VERSION,
          generic_disclosure_acknowledged_at: nowIso,
          generic_disclosure_country: country,
        }
      : {
          generic_disclosure_version: null,
          generic_disclosure_acknowledged_at: null,
          generic_disclosure_country: null,
        };

  const { data, error } = await supabase
    .from('user_profiles')
    .update({
      country_of_residence: country,
      country_confirmed_at: nowIso,
      country_source: 'USER_CONFIRMED',
      country_updated_at: nowIso,
      updated_at: nowIso,
      ...disclosureFields,
    })
    .eq('user_id', user.id)
    .select('country_of_residence, country_confirmed_at, country_source, generic_disclosure_version')
    .single();

  // A failure here leaves the profile exactly as it was — the update is a
  // single statement, so there is no partial-write state to unwind (spec
  // section 14: "Failed confirmation does not partially update profile
  // data"). No audit event is written either, because nothing happened.
  if (error) return bad('OPERATIONAL_ERROR', 500);

  await recordCountryAuditEvent({
    userId: user.id,
    eventType: 'country_confirmed',
    previousCountry,
    newCountry: country,
    actor: 'self',
    experienceLevel,
    disclosureVersion: experienceLevel === 'GENERIC' ? GENERIC_DISCLOSURE_VERSION : null,
  });

  return ok({ ...data, experience_level: experienceLevel, idempotent_replay: false });
}
