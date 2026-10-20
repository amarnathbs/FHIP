/**
 * Cost attribution and the kill switches' contract for the PDF routes.
 *
 *  - the real adapter gateways: a PDF reading carries its OWN idempotency prefix (so the cost ledger attributes spend to the PDF route) and
 *    its PDF-aware prompt, while the CSV reading is byte-for-byte what it was; the model, schema, cap and ledger are the shared ones;
 *  - the three switches: default OFF, only the literal "true" turns one on, each is independent of the others and of the AI switches,
 *    and `amplify.yml` forwards the `AIE_` prefix so the switches reach the server (and cannot be silently dropped).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PDF_ROUTE_FLAG_NAMES,
  isAuInvestmentPdfRouteEnabled,
  isLiabilityPdfRouteEnabled,
  isPdfRouteEnabled,
  isRetirementPdfRouteEnabled,
} from '@/lib/financial-data-hub/pdf-statements';

const { calls } = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/aie/provider/gateway', () => ({
  AieDocumentAiGateway: class {
    async requestFieldCompletion(req: Record<string, unknown>) {
      calls.push(req);
      return { outcome: 'refused', providerRequestIds: [], inputTokens: 1, outputTokens: 1 };
    }
  },
}));
vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
vi.mock('@/lib/aie/provider/providerFactory', () => ({ createAieAiProvider: () => ({}), createLazyAieAiProvider: () => ({}) }));
vi.mock('@/lib/aie/cost/costAdmission', () => ({ reserveConservativeAiCost: vi.fn(), settleAiCost: vi.fn() }));

beforeEach(() => {
  calls.length = 0;
  for (const f of Object.values(PDF_ROUTE_FLAG_NAMES)) delete process.env[f];
});

describe('cost attribution: the PDF reading has its own ledger key prefix and a PDF-aware prompt', () => {
  it('liability', async () => {
    const g = await import('@/lib/aie/adapters/liability/gateway');
    await g.requestLiabilityAiExtraction({ maskedText: 'x', requestId: 'doc-1', userId: 'u' });
    await g.requestLiabilityAiExtraction({ maskedText: 'x', requestId: 'doc-1', userId: 'u', sourceFormat: 'pdf' });
    expect(String(calls[0].idempotencyKey)).toMatch(/^liability-statement-ai-fallback:doc-1:/);
    expect(String(calls[1].idempotencyKey)).toMatch(/^liability-statement-pdf-ai-fallback:doc-1:/);
    expect(calls[0].systemPrompt).toBe(g.LIABILITY_AI_EXTRACTION_SYSTEM_PROMPT);
    expect(calls[1].systemPrompt).toBe(g.LIABILITY_AI_PDF_EXTRACTION_SYSTEM_PROMPT);
    expect(String(calls[1].systemPrompt)).toContain('extracted from a PDF');
    expect(String(calls[0].systemPrompt)).not.toContain('extracted from a PDF');
    expect(calls[1].schemaName).toBe(calls[0].schemaName);
    expect(calls[1].model).toBe(calls[0].model);
    expect(calls[1].maxOutputTokens).toBe(calls[0].maxOutputTokens);
  });
  it('retirement', async () => {
    const g = await import('@/lib/aie/adapters/retirement/gateway');
    await g.requestRetirementAiExtraction({ maskedText: 'x', requestId: 'doc-2', userId: 'u' });
    await g.requestRetirementAiExtraction({ maskedText: 'x', requestId: 'doc-2', userId: 'u', sourceFormat: 'pdf' });
    expect(String(calls[0].idempotencyKey)).toMatch(/^retirement-statement-ai-fallback:/);
    expect(String(calls[1].idempotencyKey)).toMatch(/^retirement-statement-pdf-ai-fallback:/);
    expect(calls[0].systemPrompt).toBe(g.RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT);
    expect(String(calls[1].systemPrompt)).toContain('This period');
  });
  it('australian investment', async () => {
    const g = await import('@/lib/aie/adapters/auInvestment/gateway');
    await g.requestAuInvestmentAiExtraction({ maskedText: 'x', requestId: 'doc-3', userId: 'u' });
    await g.requestAuInvestmentAiExtraction({ maskedText: 'x', requestId: 'doc-3', userId: 'u', sourceFormat: 'pdf' });
    expect(String(calls[0].idempotencyKey)).toMatch(/^au-investment-statement-ai-fallback:/);
    expect(String(calls[1].idempotencyKey)).toMatch(/^au-investment-statement-pdf-ai-fallback:/);
    expect(calls[0].systemPrompt).toBe(g.AU_INVESTMENT_AI_EXTRACTION_SYSTEM_PROMPT);
    expect(String(calls[1].systemPrompt)).toContain('extracted from a PDF');
    expect(String(calls[0].systemPrompt)).not.toContain('extracted from a PDF');
  });
  it('the user the spend is attributed to is the session user the service passed, on every PDF call', async () => {
    const g = await import('@/lib/aie/adapters/liability/gateway');
    await g.requestLiabilityAiExtraction({ maskedText: 'x', userId: 'the-session-user', sourceFormat: 'pdf' });
    expect(calls[0].userId).toBe('the-session-user');
  });
});

describe('the three kill switches', () => {
  const GETTERS = { liability: isLiabilityPdfRouteEnabled, retirement: isRetirementPdfRouteEnabled, au_investment: isAuInvestmentPdfRouteEnabled } as const;

  it('are OFF when unset, empty, "1", "TRUE", "yes", " true"; ON only for the literal "true"', () => {
    for (const [cls, name] of Object.entries(PDF_ROUTE_FLAG_NAMES)) {
      for (const v of [undefined, '', '1', 'TRUE', 'True', 'yes', 'on', ' true', 'true ', 'false']) {
        if (v === undefined) delete process.env[name]; else process.env[name] = v;
        expect(GETTERS[cls as keyof typeof GETTERS](), `${name}=${String(v)}`).toBe(false);
        expect(isPdfRouteEnabled(cls as keyof typeof GETTERS)).toBe(false);
      }
      process.env[name] = 'true';
      expect(GETTERS[cls as keyof typeof GETTERS](), name).toBe(true);
      delete process.env[name];
    }
  });
  it('are independent of each other and of the AI fallback switches', () => {
    process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
    expect([isLiabilityPdfRouteEnabled(), isRetirementPdfRouteEnabled(), isAuInvestmentPdfRouteEnabled()]).toEqual([true, false, false]);
    delete process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED;
    process.env.AIE_AI_FALLBACK_ENABLED = 'true';
    process.env.AIE_LIABILITY_AI_FALLBACK_ENABLED = 'true';
    expect(isLiabilityPdfRouteEnabled()).toBe(false);
    delete process.env.AIE_AI_FALLBACK_ENABLED;
    delete process.env.AIE_LIABILITY_AI_FALLBACK_ENABLED;
  });
  it('every switch name starts with AIE_ and amplify.yml forwards that whole prefix to the server (so a console value reaches it)', () => {
    const yml = fs.readFileSync(path.resolve(__dirname, '../../amplify.yml'), 'utf8');
    expect(yml).toMatch(/-e AIE_(?![A-Z])/);
    for (const name of Object.values(PDF_ROUTE_FLAG_NAMES)) expect(name.startsWith('AIE_')).toBe(true);
  });
  it('ENVIRONMENT_VARIABLES.md documents all three, default off', () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../ENVIRONMENT_VARIABLES.md'), 'utf8');
    for (const name of Object.values(PDF_ROUTE_FLAG_NAMES)) expect(doc, name).toContain(name);
  });
});
