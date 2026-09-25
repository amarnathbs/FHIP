/**
 * AIE-1 — a failed provider call must say WHY, safely.
 *
 * The first production payslip AI attempts (2026-09-25) recorded a bare
 * 'provider_error' with no request id: the gateway discarded the thrown
 * error, so a missing key, a network failure and a local exception all looked
 * identical and production could not be diagnosed.
 *
 * The gateway now returns a CATEGORY code (identifier tokens only) that the
 * payslip path records on its audit event, and writes the sanitised message
 * to the server log. GW-10 still holds: no raw error text reaches the caller.
 */

import { describe, expect, it, vi } from 'vitest';
import { AieDocumentAiGateway, describeProviderFailure } from '@/lib/aie/provider/gateway';
import { ProviderError } from '@/lib/ai/providers/types';
import type { AieAiProvider } from '@/lib/aie/provider/types';

function throwingProvider(err: unknown): AieAiProvider {
  return {
    providerName: 'test',
    generateStructured: async () => { throw err; },
  } as unknown as AieAiProvider;
}

function gateway(provider: AieAiProvider) {
  return new AieDocumentAiGateway(provider, {
    isKillSwitchEnabled: () => true,
    costAdmission: {
      reserve: async () => ({ admitted: true, reservedUsd: 0.01 }),
      settle: async () => undefined,
    },
  });
}

const request = (key: string) => ({
  systemPrompt: 's', maskedUserPrompt: 'u', schemaName: 'x', schemaVersion: '1',
  model: 'gpt-4o-mini', maxOutputTokens: 10, requestedFields: [], idempotencyKey: key,
});

function networkFailure() {
  const cause = Object.assign(new Error('Connect Timeout Error to internal-host-1.example.internal'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('describeProviderFailure', () => {
  it('a ProviderError -> its code; the message stays in the log detail', () => {
    expect(describeProviderFailure(new ProviderError('AUTH', 'OpenAI rejected the AIE API credential (401/403).')))
      .toEqual({ code: 'AUTH', detail: 'ProviderError: OpenAI rejected the AIE API credential (401/403).' });
  });

  it('a network failure -> NON_PROVIDER_ERROR:<class>:<cause code>, with the full text only in the detail', () => {
    const d = describeProviderFailure(networkFailure());
    expect(d.code).toBe('NON_PROVIDER_ERROR:TypeError:UND_ERR_CONNECT_TIMEOUT');
    expect(d.detail).toBe('TypeError: fetch failed (cause ConnectTimeoutError UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error to internal-host-1.example.internal)');
  });

  it('the detail redacts anything shaped like an API key, is one line and is bounded', () => {
    const d = describeProviderFailure(new Error(`bad key sk-proj-${'A'.repeat(40)}\n${'x'.repeat(500)}`));
    expect(d.detail).not.toMatch(/sk-proj-A/);
    expect(d.detail).toContain('sk-[redacted]');
    expect(d.detail).not.toContain('\n');
    expect(d.detail.length).toBeLessThanOrEqual(240);
  });

  it('never folds free text into the code (an exotic error name is dropped)', () => {
    const e = Object.assign(new Error('x'), { name: 'Weird name with spaces' });
    expect(describeProviderFailure(e).code).toBe('NON_PROVIDER_ERROR');
  });
});

describe('the gateway returns the category -- and only the category -- when the provider throws', () => {
  it('ProviderError -> failureCode is its code; outcome unchanged; the message is logged, not returned', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await gateway(throwingProvider(new ProviderError('INVALID_REQUEST', 'OpenAI returned 400.'))).requestFieldCompletion(request('k-a'));
    expect(r.outcome).toBe('provider_error');
    expect(r.failureCode).toBe('INVALID_REQUEST');
    expect(JSON.stringify(r)).not.toContain('OpenAI returned 400.');
    expect(log.mock.calls.some((c) => String(c[0]).includes('INVALID_REQUEST -- ProviderError: OpenAI returned 400.'))).toBe(true);
    log.mockRestore();
  });

  it('a network failure -> category with cause code; the host name never reaches the caller (GW-10)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await gateway(throwingProvider(networkFailure())).requestFieldCompletion(request('k-b'));
    expect(r.outcome).toBe('provider_error');
    expect(r.failureCode).toBe('NON_PROVIDER_ERROR:TypeError:UND_ERR_CONNECT_TIMEOUT');
    expect(JSON.stringify(r)).not.toContain('internal-host-1.example.internal');
    expect(log.mock.calls.some((c) => String(c[0]).includes('internal-host-1.example.internal'))).toBe(true);
    log.mockRestore();
  });
});
