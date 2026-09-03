import { createClient } from '@/lib/supabase/server';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export const ok = (data: unknown) => Response.json({ data });
// `errorCode` is optional and additive (PC1-D2/D4): when omitted, behaviour
// is byte-identical to before (`{ error: msg }`) for every one of this
// helper's existing call sites. When a stable machine-readable code is
// supplied, the body becomes `{ error: CODE, message: msg }` — the
// contract PC1's ISIN/date validation error responses use so a client can
// branch on `error` without parsing prose.
export const bad = (msg: string, code = 400, errorCode?: string) =>
  Response.json(errorCode ? { error: errorCode, message: msg } : { error: msg }, { status: code });

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

// G3 — Registration and Existing-User Alignment, spec section 10.
//
// Identical to requireCountryConfirmedUser() except that it also admits
// GENERIC-experience (GB/US/SG/AE) users. It exists because G3 opens
// registration to four generic countries while G4's application-wide
// capability layer — the thing that will decide, per module, what a generic
// user may do — has not been built. In that gap, the safe default had to be
// "generic users are refused", and the safe default had to apply to all ~241
// existing gated routes WITHOUT touching 241 files (where one missed file is
// a real hole). So the default lives in the shared guard above, and this
// function is the explicit, greppable opt-out.
//
// USE THIS ONLY for a surface that is genuinely jurisdiction-neutral and has
// been reasoned about individually. As of G3 that is exactly:
//   - the user's own cross-border relationship declarations (spec section 9 —
//     a declaration, never a calculation)
//   - the primary-country preview/confirm workflow (G1's own controlled
//     country-change path, which a generic user must be able to run in order
//     to correct a wrong country)
// Everything else — every financial module, every domestic calculation,
// SMSF, catalogue creation, reports, billing confirmation — deliberately
// keeps requireCountryConfirmedUser() and therefore refuses generic users
// with a truthful GENERIC_EXPERIENCE_RESTRICTED (403) until G4.
export async function requireCountryConfirmedUserAllowingGeneric() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };

  const block = await countryConfirmationBlockResponse(supabase, user.id, { allowGenericExperience: true });
  if (block) return { user: null, unauthenticated: block };
  return { user, unauthenticated: null };
}
