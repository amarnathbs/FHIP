import { createClient } from '@/lib/supabase/server';
import {
  assertCountryConfirmedForUser,
  COUNTRY_GATE_ERROR_CODE,
  COUNTRY_GATE_HTTP_STATUS,
} from '@/lib/services/countryGate';

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
// Bootstrap exemption: while the caller's profile has NOT yet completed
// onboarding, this behaves exactly like requireUser() (auth-only). The
// onboarding wizard itself calls a handful of these same routes
// (`/api/household`, `/api/goals`) to save its own form data before country
// confirmation exists as a concept for that user — blocking those calls
// would break signup outright (hard-stop condition, spec section 10:
// "Enforcement would block profile creation"). Once onboarding_completed is
// true, every route that used to accept `requireUser` now requires a
// CONFIRMED, supported country — matching spec section 1.2's access list.
export async function requireCountryConfirmedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };

  const gate = await assertCountryConfirmedForUser(supabase, user.id);

  if (!gate.onboardingCompleted && gate.state !== 'DB_ERROR' && gate.state !== 'PROFILE_INCOMPLETE') {
    return { user, unauthenticated: null };
  }
  if (gate.state === 'CONFIRMED') return { user, unauthenticated: null };

  const code = COUNTRY_GATE_ERROR_CODE[gate.state];
  const status = COUNTRY_GATE_HTTP_STATUS[gate.state];
  return { user: null, unauthenticated: bad(code, status) };
}
