import { createClient } from '@/lib/supabase/server';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export const ok = (data: unknown) => Response.json({ data });
export const bad = (msg: string, code = 400) => Response.json({ error: msg }, { status: code });

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };
  return { user, unauthenticated: null };
}

// Mandatory Country Confirmation (Product Owner decision, 2026-08-29) — the
// canonical API-layer guard for every authenticated financial endpoint.
//
// Kept as a SEPARATE export from requireUser() (rather than changing
// requireUser() itself) so the two responsibilities stay distinguishable in
// code, but every one of the ~188 route handlers that previously imported
// `requireUser` from this module has been switched onto this function via a
// single-line import alias (`import { requireCountryConfirmedUser as
// requireUser, ... } from '@/lib/api'`) — see the closure report's Scope and
// Security Audit section for the exact file list. That preserves the
// existing `const { user, unauthenticated } = await requireUser(); if
// (!user) return unauthenticated!;` idiom verbatim at every call site (this
// function returns the identical `{ user, unauthenticated }` shape), so no
// route handler body had to change to gain country enforcement.
//
// Round-3 closure (Gap 1): NO onboarding exemption is applied here at all —
// deliberately. Round 2 gave every one of the ~241 routes using this
// function the same blanket "skip the check while onboarding_completed is
// false" exemption the database trigger had, which was the identical class
// of bypass the Product Owner flagged: a defective or malicious client
// could call ANY of those routes directly while onboarding_completed
// stayed false. The onboarding wizard no longer calls any of these routes
// during onboarding at all — its optional first-goal write (the one thing
// that used to need this) now happens strictly AFTER country confirmation
// (see app/(onboarding)/confirm-country/ConfirmCountryForm.tsx), and its
// household write goes through app/api/household/route.ts, which is the
// ONLY caller of countryConfirmationBlockResponse() that opts into the
// (now off-by-default) onboarding exemption via
// `{ allowDuringOnboarding: true }`. Every other route gated by this
// function requires a genuinely confirmed country, full stop.
export async function requireCountryConfirmedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };

  // Delegates to the ONE shared classify-and-respond helper
  // (lib/services/countryGate.ts's countryConfirmationBlockResponse) also
  // used by requireAdmin(), the 39 Resources admin routes (MCC-2) and
  // app/api/household/route.ts (MCC-7), so every call site shares
  // identical state-to-response logic instead of near-duplicates.
  const block = await countryConfirmationBlockResponse(supabase, user.id);
  if (block) return { user: null, unauthenticated: block };
  return { user, unauthenticated: null };
}
