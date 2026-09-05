// Module 11.0 — server-side household/user ownership resolution (spec
// sections 4, 41, ADR-M11-001 decision #6). Every internal AI route must
// call this instead of trusting any household/user id supplied by the
// caller. It never accepts a client-supplied id as the scope — it derives
// scope entirely from the authenticated session.
//
// Mandatory Country Confirmation fix (found during G4 review, 2026-09-04):
// this used to call the plain, auth-only requireUser() instead of
// requireCountryConfirmedUser(), which meant every one of the AI Coach/
// Insights routes that resolve scope through here (standard-questions,
// contextual-explanations, and the internal DEV/certification resolve and
// context routes) enforced authentication but NOT the country-confirmation
// gate that ~241 other routes enforce via lib/api.ts's requireUser() alias
// pattern (see app/api/ai/entitlement/route.ts for the canonical example).
// An authenticated-but-country-unconfirmed user could reach these routes
// directly through the API layer even though the UI never exposes them
// pre-confirmation (app/(app)/layout.tsx structurally blocks the pages).
// Fixed here, at the single shared scope resolver, so all affected routes
// are closed by one change rather than four-plus separate edits.
import { requireCountryConfirmedUser } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

export interface AuthorisedScope {
  userId: string;
  householdId: string | null;
}

export type ResolveScopeResult = { scope: AuthorisedScope; forbidden: null } | { scope: null; forbidden: Response };

/**
 * Resolves the CURRENT session's own scope only. There is deliberately no
 * "look up household by id" path here — the only household an AI request
 * may ever address is the one belonging to the authenticated session,
 * closing off the cross-household URL-tampering vector (spec section 50
 * Security Tests: "cross-household URL tampering fails").
 */
export async function resolveHouseholdContext(): Promise<ResolveScopeResult> {
  const { user, unauthenticated } = await requireCountryConfirmedUser();
  if (!user) return { scope: null, forbidden: unauthenticated! };

  const supabase = await createClient();
  const { data: household } = await supabase.from('households').select('id').eq('user_id', user.id).maybeSingle();

  return { scope: { userId: user.id, householdId: household?.id ?? null }, forbidden: null };
}
