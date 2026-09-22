// Module 11.0 — provider health check (spec section 43).
//
// R2 (2026-09-22): resolves the CONFIGURED provider (MODULE11_AI_PROVIDER /
// MODULE11_AI_MODEL, lib/ai/config.ts) through the same factory and gateway
// the real generation path uses, instead of the pre-R2 hard-coded
// MockAIProvider (source audit PH-13). For 'openai' the adapter runs a
// ZERO-TOKEN probe (GET /v1/models/{model}) — credential, reachability and
// model availability are all checked without spend. The response carries a
// secret-free configuration summary and never any part of a key.

import { ok, bad, requireCountryConfirmedUser as requireUser } from '@/lib/api';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';
import { resolveHealthProvider } from '@/lib/ai/providers/providerFactory';
import { describeModule11AiConfig } from '@/lib/ai/config';

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const gateway = new AIModelGateway(resolveHealthProvider());
    const health = await gateway.validateProviderHealth();
    return ok({ ...health, configuration: describeModule11AiConfig() });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Provider health check failed.', 500);
  }
}
