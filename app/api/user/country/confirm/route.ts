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
// NOTE: this route deliberately no longer imports recordCountryAuditEvent.
// The country_confirmed audit event is written inside the
// confirm_country_of_residence() RPC, in the same transaction as the profile
// write, so it cannot be skipped, cannot fail independently, and cannot be
// forged by a client that bypasses this route. recordCountryAuditEvent()
// remains in use by PUT /api/user/profile for the separate
// country_change_pending_reconfirmation event.

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

  // --- G3 step 3: the controlled confirmation workflow --------------------
  // The write itself is NOT performed here. It is delegated entirely to the
  // confirm_country_of_residence() RPC (migration 0127), which is the only
  // path permitted to set country_confirmed_at / country_source / the
  // generic_disclosure_* columns to a non-null value — enforced by
  // trg_enforce_controlled_confirmation_columns, so a client that skipped
  // this route and PATCHed its own profile row directly through PostgREST is
  // rejected by the database.
  //
  // Delegating also makes the audit event MANDATORY rather than best-effort.
  // Previously the profile UPDATE and the audit insert were two separate
  // statements on two different clients: if the audit insert failed, the
  // confirmation still stood, silently unaudited. Inside the RPC both happen
  // in ONE transaction, so a confirmed country with no audit record — or a
  // stored acknowledgement with no audit record — cannot exist.
  //
  // Idempotent replay is likewise decided inside the RPC, against the row it
  // is about to write, rather than against a separately-read snapshot that
  // could have changed in between.
  const { data: rpcResult, error } = await supabase.rpc('confirm_country_of_residence', {
    p_country_code: country,
    p_disclosure_version: experienceLevel === 'GENERIC' ? GENERIC_DISCLOSURE_VERSION : null,
  });

  if (error) {
    // The RPC raises its failures with stable, prefixed messages so this
    // route can map them to the same error codes it has always returned,
    // rather than leaking raw SQL text to the client.
    const message = error.message ?? '';
    if (message.includes('GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED')) {
      return bad('GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED', 422);
    }
    if (message.includes('COUNTRY_REGISTRATION_NOT_PERMITTED')) {
      return bad('COUNTRY_REGISTRATION_NOT_PERMITTED', 403);
    }
    if (message.includes('PROFILE_INCOMPLETE')) return bad('PROFILE_INCOMPLETE', 403);
    if (message.includes('UNAUTHENTICATED')) return bad('unauthenticated', 401);
    return bad('OPERATIONAL_ERROR', 500);
  }

  // A failed confirmation leaves the profile exactly as it was: the RPC's
  // profile write and audit insert share one transaction, so either both
  // happened or neither did (spec section 14: "Failed confirmation does not
  // partially update profile data").
  return ok(rpcResult);
}
