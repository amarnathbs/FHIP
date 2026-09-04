// G4 — resolved module capability decisions for authenticated navigation.
//
// GET only, authenticated (plain auth — no country-confirmation requirement
// here: app/(app)/layout.tsx already redirects an unconfirmed user to
// /confirm-country before AppShell ever renders and fetches this, so by the
// time this route is reached the country gate has already been evaluated
// once; re-deriving the FULL decision set here is what lets the nav react
// correctly to a GENERIC-experience user without a second, separate
// allow/deny convention).
//
// Server-authoritative only: never reads a client-supplied country,
// experience level or capability flag from the request. All decisions are
// (re-)computed from lib/services/appCapability.ts's manifest and
// lib/services/jurisdiction.ts's resolveCountryContext(), never trusted from
// the client and never cached per-request beyond the existing short-TTL
// registry cache those functions already use.
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';
import { resolveCountryContext } from '@/lib/services/jurisdiction';
import { resolveModuleCapability, MODULE_KEYS, type CapabilityDecision } from '@/lib/services/appCapability';
import { isG4CapabilityLayerEnabled } from '@/lib/services/appCapabilityFlag';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  // Flag OFF: every module reports ENABLED, so the nav filter
  // (lib/nav/appNavCapability.ts's isNavHrefVisible) shows every item exactly
  // as it did before this endpoint existed — dispatch section 9's "flag-off
  // restores exact G3 containment behavior with no data changes either way".
  if (!isG4CapabilityLayerEnabled()) {
    const decisions = Object.fromEntries(MODULE_KEYS.map((key) => [key, 'ENABLED' as CapabilityDecision]));
    return ok({ decisions });
  }

  const context = await resolveCountryContext(user.id, supabase);
  const decisions: Record<string, CapabilityDecision> = {};
  for (const key of MODULE_KEYS) {
    // Nav visibility deliberately does not evaluate per-module
    // hasExistingRecords (would require one query per module on every nav
    // render). This is safe today: a GENERIC user structurally cannot hold
    // existing rows in any of these modules (the ~85-table MCC/G1 backstop
    // blocks row creation for any country whose countries.is_supported is
    // false), so EXISTING_RECORD_ONLY never actually differs from
    // UNAVAILABLE for a GENERIC user in practice, and an AU/IN user is never
    // EXISTING_RECORD_ONLY for a module their own confirmed country's
    // capability already enables. The one route-level guard that DOES need
    // the distinction (requireModuleCapability) computes it itself, per
    // request, for the specific module that route protects.
    decisions[key] = resolveModuleCapability(key, context).decision;
  }
  return ok({ decisions });
}
