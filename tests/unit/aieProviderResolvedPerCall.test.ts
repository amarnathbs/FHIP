/**
 * AIE-1 — the AI provider is chosen per call, not when a module loads.
 *
 * Production, 2026-09-25: every payslip AI call failed with
 * PROVIDER_UNAVAILABLE -- the "no provider configured" stand-in -- while
 * AIE_AI_PROVIDER was 'openai' in Amplify, and every setting read at call
 * time (the per-document AI switch, the masking key) worked. All eight AIE
 * gateways built their provider at module load, which on the production
 * server evidently happened before the settings were visible. These tests
 * pin the per-call behaviour and forbid module-load construction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAieAiProvider, createLazyAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/payslip/schema';

const req = {
  systemPrompt: 's', userPrompt: 'u',
  schemaName: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, schemaVersion: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION,
  model: 'gpt-4o-mini', maxOutputTokens: 10,
};

/** The production runtime: not a test runner, and AIE_AI_PROVIDER not visible (yet). */
function productionRuntimeWithoutSettings() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITEST', '');
  vi.stubEnv('AIE_AI_PROVIDER', '');
  vi.stubEnv('AIE_OPENAI_API_KEY', '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a provider created before the settings are visible', () => {
  it('BUG (the old way): a provider built at "module load" stays the unconfigured stand-in forever', async () => {
    productionRuntimeWithoutSettings();
    const eager = createAieAiProvider();
    vi.stubEnv('AIE_AI_PROVIDER', 'openai');
    vi.stubEnv('AIE_OPENAI_API_KEY', 'sk-test-not-real');
    await expect(eager.generateStructured(req)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('FIX: the per-call provider sees the settings at call time and goes to OpenAI', async () => {
    productionRuntimeWithoutSettings();
    const lazy = createLazyAieAiProvider();
    vi.stubEnv('AIE_AI_PROVIDER', 'openai');
    vi.stubEnv('AIE_OPENAI_API_KEY', 'sk-test-not-real');
    const fetchMock = vi.fn(async () => { throw new Error('network stubbed in test'); });
    vi.stubGlobal('fetch', fetchMock);
    const err = await lazy.generateStructured(req).catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('api.openai.com');
    expect((err as { code?: string }).code).not.toBe('PROVIDER_UNAVAILABLE');
  });

  it('with AIE_AI_PROVIDER genuinely unset at call time, it still fails closed as unconfigured (no mock)', async () => {
    productionRuntimeWithoutSettings();
    const lazy = createLazyAieAiProvider();
    await expect(lazy.generateStructured(req)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('openai selected but no key: a typed AUTH refusal at call time, not a module-load crash', async () => {
    productionRuntimeWithoutSettings();
    const lazy = createLazyAieAiProvider(); // must not throw here
    vi.stubEnv('AIE_AI_PROVIDER', 'openai');
    await expect(lazy.generateStructured(req)).rejects.toMatchObject({ code: 'AUTH' });
  });
});

describe('no gateway builds its provider at module load', () => {
  it('every `new AieDocumentAiGateway(...)` in lib/ and app/ uses the per-call provider', () => {
    const root = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];
    let gateways = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        const hits = src.match(/new AieDocumentAiGateway\(\s*createAieAiProvider\(/g);
        if (hits) offenders.push(path.relative(root, p));
        gateways += (src.match(/new AieDocumentAiGateway\(\s*createLazyAieAiProvider\(/g) ?? []).length;
      }
    };
    walk(path.join(root, 'lib'));
    walk(path.join(root, 'app'));
    expect(offenders).toEqual([]);
    expect(gateways).toBeGreaterThanOrEqual(8); // anti-vacuity: the eight production gateways were actually found
  }, 60_000); // walks every source file; slow under a loaded full-suite run
});
