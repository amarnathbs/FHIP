/**
 * AIE-1 final production completion (2026-09-25) -- unit coverage for the
 * smaller safety controls added in this dispatch:
 *   - S3 quarantine object deletion + absence verification (outcome classes)
 *   - the raw-file backstop no longer rejecting documents with durable results
 *   - the provider factory never silently selecting the mock outside tests
 *   - the GPT-4o-mini-only model rule at the gateway
 *   - per-attempt idempotency keys in the adapters (defect D1's app half)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { deleteObjectFromS3, verifyS3ObjectAbsent } from '@/lib/aie/malware/s3RestClient';
import { decideRawFileBackstopAction } from '@/lib/financial-data-hub/domain/rawFileBackstop';
import { getAieAiProviderKind, isPermittedAieModel } from '@/lib/aie/config';
import { createAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';

const location = { bucket: 'fhip-aie-dev-01-879807128139-ap-southeast-2-an', region: 'ap-southeast-2' };
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

function fakeFetch(status: number, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = (async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(status === 204 || status === 404 || status === 405 ? null : '', { status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('S3 quarantine object deletion', () => {
  it('unversioned 204 -> deleted, sent as a plain DELETE', async () => {
    const f = fakeFetch(204);
    const r = await deleteObjectFromS3({ location, key: 'fdh3/u/d/a.bin', versionId: 'null', credentials, fetchImpl: f.impl });
    expect(r.outcome).toBe('deleted');
    expect(f.calls[0].method).toBe('DELETE');
    expect(f.calls[0].url).not.toContain('versionId=');
  });

  it("a delete marker with no version id is reported as delete_marker_created (bytes still retained), never 'deleted'", async () => {
    const f = fakeFetch(204, { 'x-amz-delete-marker': 'true' });
    const r = await deleteObjectFromS3({ location, key: 'fdh3/u/d/a.bin', versionId: null, credentials, fetchImpl: f.impl });
    expect(r.outcome).toBe('delete_marker_created');
  });

  it('a real version id makes the delete version-specific (permanent)', async () => {
    const f = fakeFetch(204);
    const r = await deleteObjectFromS3({ location, key: 'aie/u/d/a.bin', versionId: 'v123', credentials, fetchImpl: f.impl });
    expect(r.outcome).toBe('deleted');
    expect(f.calls[0].url).toContain('versionId=v123');
  });

  it('403 -> access_denied (distinct from missing)', async () => {
    const f = fakeFetch(403);
    expect((await deleteObjectFromS3({ location, key: 'k', credentials, fetchImpl: f.impl })).outcome).toBe('access_denied');
  });

  it('verification: 404 and 405 prove absence; 200 is present; 403 is UNVERIFIABLE, never absent', async () => {
    expect(await verifyS3ObjectAbsent({ location, key: 'k', credentials, fetchImpl: fakeFetch(404).impl })).toBe('absent');
    expect(await verifyS3ObjectAbsent({ location, key: 'k', versionId: 'v1', credentials, fetchImpl: fakeFetch(405).impl })).toBe('absent');
    expect(await verifyS3ObjectAbsent({ location, key: 'k', credentials, fetchImpl: fakeFetch(200).impl })).toBe('present');
    expect(await verifyS3ObjectAbsent({ location, key: 'k', credentials, fetchImpl: fakeFetch(403).impl })).toBe('unverifiable');
  });
});

describe('raw-file backstop with a durable structured result', () => {
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const base = { purgeStatus: 'not_required' as const, receivedAtIso: old, purgeDueAtIso: null };

  it('NEGATIVE CONTROL: without the flag an extracted document is still forced to rejected (the production behaviour of 23 Sep)', () => {
    const d = decideRawFileBackstopAction({ ...base, processingStatus: 'extracted' }, Date.now(), 50);
    expect(d?.forceProcessingStatus).toBe('rejected');
  });

  it('with a durable result the raw file is purged but the processing status is left alone', () => {
    for (const processingStatus of ['extracted', 'review_required', 'ready_for_approval', 'processing'] as const) {
      const d = decideRawFileBackstopAction({ ...base, processingStatus, hasDurableStructuredResult: true }, Date.now(), 50);
      expect(d, processingStatus).not.toBeNull();
      expect(d?.forceProcessingStatus, processingStatus).toBeNull();
      expect(d?.schedulePurgeNow, processingStatus).toBe(true);
    }
  });

  it('approved documents keep their existing purge_pending path', () => {
    const d = decideRawFileBackstopAction({ ...base, processingStatus: 'approved', hasDurableStructuredResult: true }, Date.now(), 50);
    expect(d?.forceProcessingStatus).toBe('purge_pending');
  });
});

describe('provider selection and model contract', () => {
  const savedProvider = process.env.AIE_AI_PROVIDER;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedVitest = process.env.VITEST;
  afterEach(() => {
    if (savedProvider === undefined) delete process.env.AIE_AI_PROVIDER; else process.env.AIE_AI_PROVIDER = savedProvider;
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
    if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
  });

  it('unset AIE_AI_PROVIDER outside the test runner is UNCONFIGURED (fails closed), never the mock', async () => {
    delete process.env.AIE_AI_PROVIDER;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.VITEST;
    expect(getAieAiProviderKind()).toBe('unconfigured');
    const provider = createAieAiProvider();
    expect(provider.providerName).toBe('unconfigured');
    await expect(provider.generateStructured({ systemPrompt: 's', userPrompt: 'u', schemaName: 'x', schemaVersion: '1', model: 'gpt-4o-mini', maxOutputTokens: 10 })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('explicit mock is still honoured; unset under the test runner is the mock', () => {
    process.env.AIE_AI_PROVIDER = 'mock';
    expect(getAieAiProviderKind()).toBe('mock');
    delete process.env.AIE_AI_PROVIDER;
    expect(getAieAiProviderKind()).toBe('mock'); // VITEST is set here
  });

  it('only gpt-4o-mini (alias or dated snapshot) is permitted', () => {
    expect(isPermittedAieModel('gpt-4o-mini')).toBe(true);
    expect(isPermittedAieModel('gpt-4o-mini-2024-07-18')).toBe(true);
    expect(isPermittedAieModel('gpt-4o')).toBe(false);
    expect(isPermittedAieModel('gpt-4.1-mini')).toBe(false);
  });

  it('the gateway blocks a non-permitted model before reserving budget or calling the provider', async () => {
    let providerCalls = 0;
    let reserveCalls = 0;
    const gw = new AieDocumentAiGateway(new MockAieProvider({ respond: () => { providerCalls++; return '{}'; } }), {
      isKillSwitchEnabled: () => true,
      costAdmission: {
        reserve: async () => { reserveCalls++; return { admitted: true, reservedUsd: 0.01 }; },
        settle: async () => undefined,
      },
    });
    const r = await gw.requestFieldCompletion({ systemPrompt: 's', maskedUserPrompt: 'u', schemaName: 'x', schemaVersion: '1', model: 'gpt-4o', maxOutputTokens: 10, requestedFields: [], idempotencyKey: 'k1' });
    expect(r.outcome).toBe('kill_switch_blocked');
    expect(providerCalls).toBe(0);
    expect(reserveCalls).toBe(0);
  });

  it('the gateway sizes the reservation from the actual prompt and output budget', async () => {
    let sizing: { promptChars?: number; maxOutputTokens?: number } | undefined;
    const gw = new AieDocumentAiGateway(new MockAieProvider({ respond: () => '{}' }), {
      isKillSwitchEnabled: () => true,
      costAdmission: {
        reserve: async (_m, _k, s) => { sizing = s; return { admitted: false, reservedUsd: 0 }; },
        settle: async () => undefined,
      },
    });
    await gw.requestFieldCompletion({ systemPrompt: 'abc', maskedUserPrompt: 'defgh', schemaName: 'x', schemaVersion: '1', model: 'gpt-4o-mini', maxOutputTokens: 4096, requestedFields: [], idempotencyKey: 'k2' });
    expect(sizing).toEqual({ promptChars: 8, maxOutputTokens: 4096 });
  });
});
