// Module 11 remediation R2 — the ONE place a registry model row is turned
// into a concrete AIProvider instance (brief sections 12-14). Route
// handlers, the scheduler and the health endpoint all resolve providers
// here; none of them import an adapter class directly, and every provider
// instance produced here is only ever handed to AIModelGateway (or to the
// batch orchestrator's cost-estimation delegate) — never called directly.
//
// FAIL-CLOSED RULES:
//   * A model row whose provider is not the CONFIGURED provider is refused
//     (MODULE11_AI_PROVIDER=mock + an openai row, or vice versa). This is
//     what makes flipping MODULE11_AI_PROVIDER a genuine switch: it is not
//     enough for a real row to be active+approved — the environment must
//     ALSO say "openai".
//   * An unknown provider string is refused, never mapped to a default.

import '@/lib/serverOnly';
import type { AIProvider } from '@/lib/ai/providers/types';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import { MockAIProvider } from '@/lib/ai/providers/mockProvider';
import { MockInsightPackProvider, MockBatchInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import { OpenAIProviderAdapter } from '@/lib/ai/providers/openaiProvider';
import { OpenAIBatchProvider } from '@/lib/ai/providers/openaiBatchProvider';
import { SyncFanoutBatchProvider } from '@/lib/ai/providers/syncFanoutBatchProvider';
import type { BatchCapableProvider } from '@/lib/ai/insightPack/batchTypes';
import { getModule11AiProvider, getModule11BatchMode } from '@/lib/ai/config';

export class ProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderResolutionError';
  }
}

/**
 * The providerFactory shape AIPersonalisedInsightPackService /
 * AIInsightPackBatchOrchestrator take. For 'mock' it returns the
 * deterministic pack mock (valid behaviour); for 'openai' the real adapter.
 */
export function resolvePackProvider(ctx: FinancialContextObject, model: ModelRegistryRow): AIProvider {
  const configured = getModule11AiProvider();
  if (model.provider !== configured) {
    throw new ProviderResolutionError(
      `Model row "${model.provider}/${model.model_identifier}" does not match the configured Module 11 provider "${configured}"; refusing to resolve a provider.`
    );
  }
  switch (model.provider) {
    case 'mock':
      return new MockInsightPackProvider(ctx, 'valid');
    case 'openai':
      return new OpenAIProviderAdapter();
    default:
      throw new ProviderResolutionError(`No provider adapter is registered for provider "${model.provider}".`);
  }
}

/**
 * Brief section 14 — the provider the health endpoint probes: whatever the
 * environment is configured to run, resolved through the same
 * configuration the generation path uses.
 */
export function resolveHealthProvider(): AIProvider {
  return getModule11AiProvider() === 'openai' ? new OpenAIProviderAdapter() : new MockAIProvider();
}

/**
 * R3 — the batch-capable provider for the scheduler / batch orchestrator.
 * 'mock' -> the in-process MockBatchInsightPackProvider; 'openai' -> the
 * real OpenAIBatchProvider (Files + Batches API). Same configuration
 * switch as the synchronous path, so one env var moves both.
 */
export function resolveBatchProvider(): BatchCapableProvider {
  if (getModule11AiProvider() !== 'openai') return new MockBatchInsightPackProvider();
  return getModule11BatchMode() === 'provider_batch' ? new OpenAIBatchProvider() : new SyncFanoutBatchProvider(new OpenAIProviderAdapter());
}
