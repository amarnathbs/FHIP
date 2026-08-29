import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '@/lib/ai/providers/openaiProvider';
import { ProviderError } from '@/lib/ai/providers/types';
import { MockAIProvider } from '@/lib/ai/providers/mockProvider';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';

describe('Cost preparation (spec section 55) — no paid call required', () => {
  it('MockAIProvider always estimates zero cost regardless of token volume', () => {
    const provider = new MockAIProvider();
    expect(provider.estimateCost(1_000_000, 500_000, 'mock-standard-1').estimatedCostUsd).toBe(0);
  });

  it('AIModelGateway.estimateUsage delegates to the provider without making a network call', () => {
    const gateway = new AIModelGateway(new MockAIProvider());
    const estimate = gateway.estimateUsage('system prompt text', 'user prompt text', 'mock-standard-1');
    expect(estimate.estimatedCostUsd).toBe(0);
    expect(estimate.inputTokens).toBeGreaterThan(0);
  });

  it('OpenAIProviderAdapter.estimateCost computes a non-zero indicative cost without ever calling the network', () => {
    const adapter = new OpenAIProviderAdapter();
    const cost = adapter.estimateCost(1000, 500, 'gpt-mini');
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe('OpenAIProviderAdapter (spec section 26 — architecture-proof only, no live user-facing call in 11.0)', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  });

  it('fails closed with an AUTH error when no API key is configured (spec 51-I: provider key missing)', async () => {
    const adapter = new OpenAIProviderAdapter();
    await expect(
      adapter.generateStructured({ systemPrompt: '', userPrompt: '', taskType: 'score_explanation', model: 'gpt-mini', maxOutputTokens: 100, responseSchema: 'ai_response_envelope' })
    ).rejects.toThrow(ProviderError);
  });

  it('never spends a token even when an API key IS configured — Module 11.0 does not activate any real provider call', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-for-architecture-proof-only';
    const adapter = new OpenAIProviderAdapter();
    await expect(
      adapter.generateStructured({ systemPrompt: '', userPrompt: '', taskType: 'score_explanation', model: 'gpt-mini', maxOutputTokens: 100, responseSchema: 'ai_response_envelope' })
    ).rejects.toThrow(/not activated in Module 11\.0/);
  });

  it('reports unhealthy in validateProviderHealth() since it is not activated, without leaking the key', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-for-architecture-proof-only';
    const adapter = new OpenAIProviderAdapter();
    const health = await adapter.validateProviderHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).not.toContain('sk-test-key-for-architecture-proof-only');
  });
});
