import { describe, it, expect, vi } from 'vitest';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME, AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION } from '@/lib/aie/schema/schemaRegistry';
import { ProviderError } from '@/lib/ai/providers/types';

function baseRequest(overrides: Partial<Parameters<AieDocumentAiGateway['requestFieldCompletion']>[0]> = {}) {
  return {
    systemPrompt: 'extract only requested fields',
    maskedUserPrompt: 'account: [MASKED:tax_id:abcxxxxx:1] balance: 100.00',
    schemaName: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME,
    schemaVersion: AIE_GENERIC_FIELD_COMPLETION_SCHEMA_VERSION,
    model: 'test-model',
    maxOutputTokens: 256,
    requestedFields: ['account_number'],
    idempotencyKey: 'test-key-1',
    ...overrides,
  };
}

describe('AIE-1.1 AI gateway — the one choke point (GW-01..12, PAY-01..12)', () => {
  it('P9/GW-03: blocks every call when the kill switch is off (production-safe default)', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => false });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('kill_switch_blocked');
  });

  it('P1/PAY-04: refuses to send a payload that still contains an unmasked PII pattern, even with the kill switch on', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion(baseRequest({ maskedUserPrompt: 'PAN: ABCDE1234F was left unmasked by a caller bug' }));
    expect(result.outcome).toBe('unmasked_pii_detected');
  });

  it('returns a validated result on a schema-valid provider response', async () => {
    const provider = new MockAieProvider({
      respond: () => JSON.stringify({ fields: [{ fieldName: 'account_number', value: '12345', nullReason: null, sourceReferenceId: 'p1' }] }),
    });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('success');
    expect(result.data).toBeDefined();
  });

  it('P3: a schema-invalid (hallucinated-shape) provider response is rejected, never passed through', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ totallyWrongShape: true }) });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('schema_rejected');
    expect(result.errorCodes?.length).toBeGreaterThan(0);
  });

  it('maps a thrown ProviderError to a typed, privacy-safe outcome rather than leaking the raw error (GW-10)', async () => {
    const provider = new MockAieProvider({
      respond: () => {
        throw new ProviderError('TIMEOUT', 'connection timed out to internal-host-1.example.internal');
      },
    });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('timeout');
    expect(JSON.stringify(result)).not.toContain('internal-host-1.example.internal');
  });

  it('adversarial: a content_filter/refusal finish reason is a typed refusal, not parsed as data', async () => {
    const provider: import('@/lib/aie/provider/types').AieAiProvider = {
      providerName: 'mock',
      generateStructured: async () => ({ rawText: '{}', inputTokens: 1, outputTokens: 1, latencyMs: 1, modelVersion: 'x', finishReason: 'content_filter' }),
      validateProviderHealth: async () => ({ healthy: true, checkedAt: new Date().toISOString(), detail: null }),
      estimateCost: () => ({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    };
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('refused');
  });

  it('CST-05/concurrency: concurrent calls sharing an idempotency key collapse to exactly one provider invocation', async () => {
    let calls = 0;
    const provider = new MockAieProvider({
      respond: () => {
        calls += 1;
        return JSON.stringify({ fields: [] });
      },
    });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const req = baseRequest({ idempotencyKey: 'shared-key' });
    const [a, b, c, d, e, f] = await Promise.all([
      gateway.requestFieldCompletion(req),
      gateway.requestFieldCompletion(req),
      gateway.requestFieldCompletion(req),
      gateway.requestFieldCompletion(req),
      gateway.requestFieldCompletion(req),
      gateway.requestFieldCompletion(req),
    ]);
    expect(calls).toBe(1);
    for (const r of [a, b, c, d, e, f]) expect(r.outcome).toBe('success');
  });

  it('a DIFFERENT idempotency key is never collapsed with another key', async () => {
    let calls = 0;
    const provider = new MockAieProvider({
      respond: () => {
        calls += 1;
        return JSON.stringify({ fields: [] });
      },
    });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    await Promise.all([gateway.requestFieldCompletion(baseRequest({ idempotencyKey: 'key-a' })), gateway.requestFieldCompletion(baseRequest({ idempotencyKey: 'key-b' }))]);
    expect(calls).toBe(2);
  });

  it('calls recordAttempt exactly once per genuinely-attempted call, never for a collapsed duplicate', async () => {
    const recordAttempt = vi.fn(async () => undefined);
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true, recordAttempt });
    const req = baseRequest({ idempotencyKey: 'record-once-key' });
    await Promise.all([gateway.requestFieldCompletion(req), gateway.requestFieldCompletion(req)]);
    expect(recordAttempt).toHaveBeenCalledTimes(1);
  });
});

describe('AIE-1 closure mission (section 8) — atomic cost admission wired through the gateway', () => {
  it('refuses the reservation -> provider is NEVER called, outcome is budget_exhausted, no recordAttempt', async () => {
    const generate = vi.fn(async () => ({ rawText: JSON.stringify({ fields: [] }), inputTokens: 1, outputTokens: 1, latencyMs: 1, modelVersion: 'x', finishReason: 'stop' as const }));
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    provider.generateStructured = generate;
    const recordAttempt = vi.fn(async () => undefined);
    const settle = vi.fn<(params: { reservedUsd: number; actualInputTokens: number; actualOutputTokens: number; model: string; treatAsFullReservedCost?: boolean }) => Promise<void>>(async () => undefined);
    const gateway = new AieDocumentAiGateway(provider, {
      isKillSwitchEnabled: () => true,
      recordAttempt,
      costAdmission: { reserve: async () => ({ admitted: false, reservedUsd: 0 }), settle },
    });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('budget_exhausted');
    expect(generate).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('admits the reservation -> provider is called and the reservation is settled against actual usage', async () => {
    const provider = new MockAieProvider({
      respond: () => JSON.stringify({ fields: [{ fieldName: 'account_number', value: '12345', nullReason: null, sourceReferenceId: 'p1' }] }),
    });
    const settle = vi.fn<(params: { reservedUsd: number; actualInputTokens: number; actualOutputTokens: number; model: string; treatAsFullReservedCost?: boolean }) => Promise<void>>(async () => undefined);
    const gateway = new AieDocumentAiGateway(provider, {
      isKillSwitchEnabled: () => true,
      costAdmission: { reserve: async () => ({ admitted: true, reservedUsd: 0.001234 }), settle },
    });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('success');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toMatchObject({ reservedUsd: 0.001234, treatAsFullReservedCost: false });
  });

  it('settles a TIMEOUT at the full reserved amount (uncertain charge, section 8), not assumed zero', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    provider.generateStructured = async () => {
      throw new ProviderError('TIMEOUT', 'boom');
    };
    const settle = vi.fn<(params: { reservedUsd: number; actualInputTokens: number; actualOutputTokens: number; model: string; treatAsFullReservedCost?: boolean }) => Promise<void>>(async () => undefined);
    const gateway = new AieDocumentAiGateway(provider, {
      isKillSwitchEnabled: () => true,
      costAdmission: { reserve: async () => ({ admitted: true, reservedUsd: 0.05 }), settle },
    });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('timeout');
    expect(settle).toHaveBeenCalledWith({ reservedUsd: 0.05, actualInputTokens: 0, actualOutputTokens: 0, model: 'test-model', treatAsFullReservedCost: true });
  });

  it('settles a genuine (non-timeout) provider error at zero actual cost, not the full reservation', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    provider.generateStructured = async () => {
      throw new ProviderError('AUTH', 'bad key');
    };
    const settle = vi.fn<(params: { reservedUsd: number; actualInputTokens: number; actualOutputTokens: number; model: string; treatAsFullReservedCost?: boolean }) => Promise<void>>(async () => undefined);
    const gateway = new AieDocumentAiGateway(provider, {
      isKillSwitchEnabled: () => true,
      costAdmission: { reserve: async () => ({ admitted: true, reservedUsd: 0.05 }), settle },
    });
    await gateway.requestFieldCompletion(baseRequest());
    expect(settle).toHaveBeenCalledWith({ reservedUsd: 0.05, actualInputTokens: 0, actualOutputTokens: 0, model: 'test-model', treatAsFullReservedCost: false });
  });

  it('with no costAdmission configured at all, behaves exactly as before (backward compatible)', async () => {
    const provider = new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) });
    const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion(baseRequest());
    expect(result.outcome).toBe('success');
  });
});
