// Module 11.0 — provider health check (spec section 43).
//
// Reports whether the configured provider is reachable, WITHOUT ever
// returning a provider secret or key fragment. Uses the mock provider by
// default in Module 11.0 since no real provider is activated for any
// user-facing path yet (ADR-M11-001 decision #5, spec section 48).

import { ok, bad, requireCountryConfirmedUser as requireUser } from '@/lib/api';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';
import { MockAIProvider } from '@/lib/ai/providers/mockProvider';

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const gateway = new AIModelGateway(new MockAIProvider());
    const health = await gateway.validateProviderHealth();
    return ok(health);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Provider health check failed.', 500);
  }
}
