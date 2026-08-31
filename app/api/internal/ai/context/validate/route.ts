// Module 11.0 — context validation endpoint (spec section 43).
//
// Builds the caller's own Financial Context Object and reports its
// certification/allowlist state without ever exposing it to a provider.
// Useful for certification tooling and future 11.1 pre-flight checks.

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { buildFinancialContextObject } from '@/lib/ai/context/financialContextObject';
import { scanForBannedFields } from '@/lib/ai/context/allowlist';
import type { ContextSizeMode } from '@/lib/ai/context/types';

export async function POST(req: Request) {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  const body = await req.json().catch(() => ({}));
  const mode: ContextSizeMode = body.mode === 'MINIMAL' || body.mode === 'DOMAIN' ? body.mode : 'FULL';

  try {
    const context = await buildFinancialContextObject(scope.userId, { mode, intentCode: body.intentCode });
    const violations = scanForBannedFields(context);
    return ok({
      valid: violations.length === 0,
      certification_status: context.meta.certification_status,
      currency_integrity_status: context.meta.currency_integrity_status,
      domain_certification: context.domain_certification,
      allowlist_violations: violations,
    });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to validate financial context.', 500);
  }
}
