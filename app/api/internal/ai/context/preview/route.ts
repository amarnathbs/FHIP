// Module 11.0 — DEV/certification context preview (spec section 44).
//
// Returns the caller's OWN Financial Context Object exactly as it would be
// handed to a provider adapter — no provider secret, no other user's data,
// no field outside the allowlist. There is deliberately no way to pass
// another user's id: scope always comes from resolveHouseholdContext().

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { buildFinancialContextObject } from '@/lib/ai/context/financialContextObject';
import type { ContextSizeMode } from '@/lib/ai/context/types';

const VALID_MODES: ContextSizeMode[] = ['MINIMAL', 'DOMAIN', 'FULL'];

export async function GET(req: Request) {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  const { searchParams } = new URL(req.url);
  const modeParam = searchParams.get('mode') ?? 'FULL';
  const intentCode = searchParams.get('intent') ?? undefined;
  if (!VALID_MODES.includes(modeParam as ContextSizeMode)) {
    return bad(`mode must be one of ${VALID_MODES.join(', ')}`, 422);
  }

  try {
    const context = await buildFinancialContextObject(scope.userId, { mode: modeParam as ContextSizeMode, intentCode });
    return ok(context);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to build financial context.', 500);
  }
}
