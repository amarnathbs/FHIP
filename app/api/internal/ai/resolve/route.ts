// Module 11.2 — DEV/admin resolution-router tester (spec section 61).
//
// NOT an open AI chat endpoint (spec section 63): it runs the zero-cost
// router only, never a provider. Scope always comes from
// resolveHouseholdContext() — a caller can never address another user's
// household. Accepts either a structured `intent_code` (preferred, spec
// section 46) or free-text `question` for DEV testing (spec section 45).

import { bad, ok } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { resolveAnswer } from '@/lib/ai/resolution/router';
import { createRouterDependencies } from '@/lib/ai/resolution/routerDependencies';
import type { ResolveRequest } from '@/lib/ai/resolution/types';

export async function POST(req: Request) {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  let body: ResolveRequest;
  try {
    body = (await req.json()) as ResolveRequest;
  } catch {
    return bad('Request body must be valid JSON.', 422);
  }

  if (!body.intent_code && !body.question) {
    return bad('Provide either intent_code or question.', 422);
  }

  try {
    const deps = createRouterDependencies(scope.userId, scope.householdId);
    const result = await resolveAnswer(deps, { userId: scope.userId, householdId: scope.householdId, request: body });
    return ok(result);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to resolve the request.', 500);
  }
}
