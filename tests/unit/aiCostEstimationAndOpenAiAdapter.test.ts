import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIProviderAdapter, OPENAI_FALLBACK_PRICING_PER_1K } from '@/lib/ai/providers/openaiProvider';
import { ProviderError } from '@/lib/ai/providers/types';
import { MockAIProvider } from '@/lib/ai/providers/mockProvider';
import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';

// R2 (2026-09-22): this file predates the real adapter. Its three original
// intents — no network call from a unit test, fail closed without a key,
// never leak the key — are preserved; the "never spends a token even with a
// key" assertion (true of the 11.0 stub by construction) is now proven by
// injecting a fetch double that records every call instead.

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

  it('OpenAIProviderAdapter.estimateCost prices the verified model per 1K tokens (R2 corrected the 11.0 per-1M/per-1K mix-up) without the network', () => {
    const adapter = new OpenAIProviderAdapter(() => { throw new Error('network must not be called'); });
    const cost = adapter.estimateCost(1000, 1000, 'gpt-4o-mini');
    // $0.15/1M in + $0.60/1M out => 1K in + 1K out = $0.00075
    expect(cost.estimatedCostUsd).toBeCloseTo(0.00075, 10);
    expect(OPENAI_FALLBACK_PRICING_PER_1K['gpt-4o-mini'].verified_on).toBe('2026-09-22');
  });

  it('an unpriced/unknown model yields NaN (fails closed at the admission ceiling), never a fabricated number', () => {
    const adapter = new OpenAIProviderAdapter(() => { throw new Error('network must not be called'); });
    expect(Number.isNaN(adapter.estimateCost(1000, 500, 'gpt-mini').estimatedCostUsd)).toBe(true);
  });
});

describe('OpenAIProviderAdapter — credential handling (no network in any unit test)', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.MODULE11_AI_MODEL;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODULE11_AI_MODEL;
  });
  afterEach(() => {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey; else delete process.env.OPENAI_API_KEY;
    if (originalModel !== undefined) process.env.MODULE11_AI_MODEL = originalModel; else delete process.env.MODULE11_AI_MODEL;
  });

  it('fails closed with an AUTH error when no API key is configured (spec 51-I: provider key missing) — fetch never called', async () => {
    const fetchSpy = vi.fn();
    const adapter = new OpenAIProviderAdapter(fetchSpy);
    await expect(
      adapter.generateStructured({ systemPrompt: '', userPrompt: '', taskType: 'score_explanation', model: 'gpt-4o-mini', maxOutputTokens: 100, responseSchema: 'ai_response_envelope' })
    ).rejects.toThrow(ProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses any model other than the configured Module 11 model BEFORE any network call', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-for-unit-test-only';
    const fetchSpy = vi.fn();
    const adapter = new OpenAIProviderAdapter(fetchSpy);
    await expect(
      adapter.generateStructured({ systemPrompt: '', userPrompt: '', taskType: 'score_explanation', model: 'gpt-4.1', maxOutputTokens: 100, responseSchema: 'ai_response_envelope' })
    ).rejects.toThrow(/not the configured Module 11 model/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validateProviderHealth() without a key reports unhealthy and never leaks a key value; with a key it probes the zero-token models endpoint only', async () => {
    const adapter = new OpenAIProviderAdapter(vi.fn());
    const noKey = await adapter.validateProviderHealth();
    expect(noKey.healthy).toBe(false);

    process.env.OPENAI_API_KEY = 'sk-test-key-for-unit-test-only';
    const calls: string[] = [];
    const fetchDouble = vi.fn(async (url: string) => { calls.push(url); return new Response('{}', { status: 200 }); });
    const withKey = await new OpenAIProviderAdapter(fetchDouble).validateProviderHealth();
    expect(withKey.healthy).toBe(true);
    expect(withKey.detail).not.toContain('sk-test-key');
    expect(calls).toEqual(['https://api.openai.com/v1/models/gpt-4o-mini']);
    expect(calls.some((u) => u.includes('chat/completions'))).toBe(false);
  });
});
