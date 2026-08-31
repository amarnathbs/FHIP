// Module 11.1 — GET /api/ai/entitlement  (spec sections 7, 8, 39).
//
// The one user-facing endpoint Module 11.1 adds. It is a READ: it tells an
// authenticated subject what their AI entitlement currently is. It consumes
// nothing, reserves nothing, and reaches no provider.
//
// This is NOT an AI capability and does not imply one. Spec section 44
// forbids shipping any user-facing AI chat in this phase, and nothing here
// generates, requests or returns an AI answer.
//
// SUBJECT IS ALWAYS THE SESSION USER. There is no user_id or household_id
// parameter, by design (spec sections 50 and 84): the subject comes from
// requireUser(), so "read another Premium user's quota" has no input to
// attack. The underlying RPC additionally refuses a cross-user read.
//
// SAFE FIELDS ONLY. The response body is built by
// toPublicEntitlementResponse(), an allowlist-shaped builder — a field added
// to the internal state later cannot leak through it. Never returned:
// per-user or platform dollar ceilings, platform spend, provider budgets,
// model routing, model or provider names, rate-limit internals, kill-switch
// reasons, raw feature-flag state, or any other subject's data.

import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { AIEntitlementService, toPublicEntitlementResponse } from '@/lib/ai/entitlement/aiEntitlementService';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated || !user) return unauthenticated ?? Response.json({ error: 'unauthenticated' }, { status: 401 });

  const state = await AIEntitlementService.getAIPlanEntitlement(user.id);

  // 200 in both the eligible and the not-eligible case. A Free user asking
  // "what am I entitled to" has received a correct, complete answer; that is
  // not a client error. The `eligible: false` / `reason` / `upgrade_available`
  // triple is exactly section 7's controlled entitlement response.
  return ok(toPublicEntitlementResponse(state));
}
