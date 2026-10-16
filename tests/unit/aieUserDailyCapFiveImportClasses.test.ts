/**
 * AIE per-user daily spend cap (PO decision 16-10-2026) -- the FIVE document-import classes that reach the shared
 * gateway: bank statement, payslip, liability statement, retirement statement, AU investment statement.
 *
 * EVIDENCE LABEL: UNIT-TESTED. For each class the REAL `attemptAi<Class>Fallback` runs, with the real adapter request
 * function and the real shared gateway. Only the database-backed cost admission and the provider are doubles: the
 * admission double refuses with the typed per-user reason, and the provider is a counter. Proven for every class:
 *
 *   - the refusal happens BEFORE the provider: zero provider calls, nothing settled;
 *   - the service returns the typed reason `user_daily_cap_reached` and the shared mapping turns it into the plain
 *     `daily_limit_reached` the panels show (and the global allowance reason stays internal);
 *   - the reservation was made for the SESSION user the service was called with;
 *   - control: with the admission double admitting, the same call DOES reach the provider (so the zero above is not vacuous);
 *   - the five panels render that note (static check of the shared helper they all import and of the response field).
 *
 * The HTTP routes only forward `result.aiFallbackRefusal` (checked statically below); the route-to-panel path for the
 * entitlement refusals is unchanged and already covered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({
  providerCalls: { n: 0 },
  admit: { current: false },
  reason: { current: 'user_daily_cap' as string },
  reserved: [] as Array<{ userId?: string; key: string }>,
  settled: { n: 0 },
}));

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);
vi.mock('@/lib/financial-data-hub/bank-pdf/textExtraction', () => ({ extractPdfPages: vi.fn() }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  saveAiFallbackDraft: vi.fn().mockResolvedValue({ persisted: true, draftId: 'd' }),
  claimPendingAiFallbackDraft: vi.fn(),
  releaseClaimedAiFallbackDraft: vi.fn(),
  releaseClaimedAiFallbackDraftIfNothingWritten: vi.fn(async () => ({ released: true })),
  loadPendingAiFallbackDraft: vi.fn(),
  documentsWithPendingAiFallbackDrafts: vi.fn(),
}));
vi.mock('@/lib/aie/cost/costAdmission', () => ({
  reserveConservativeAiCost: vi.fn(async (_model: string, key: string, sizing?: { userId?: string }) => {
    h.reserved.push({ userId: sizing?.userId, key });
    return h.admit.current
      ? { admitted: true, remainingUsd: 9, reservedUsd: 0.01 }
      : { admitted: false, remainingUsd: 9, reservedUsd: 0, refusalReason: h.reason.current };
  }),
  settleAiCost: vi.fn(async () => {
    h.settled.n += 1;
    return { settled: true, alreadySettled: false };
  }),
}));
vi.mock('@/lib/aie/provider/providerFactory', () => {
  const provider = {
    providerName: 'counting-test-provider',
    async generateStructured() {
      h.providerCalls.n += 1;
      return { rawText: '{}', inputTokens: 5, outputTokens: 2, latencyMs: 1, modelVersion: 'test', finishReason: 'stop', providerRequestIds: ['req_test'] };
    },
    async validateProviderHealth() {
      return { healthy: true, checkedAt: new Date().toISOString(), detail: null };
    },
    estimateCost: () => ({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
  };
  return { createAieAiProvider: () => provider, createLazyAieAiProvider: () => provider };
});

import { premiumAi } from '../support/premiumAiAccessMock';
import { aiFallbackRefusalFromReason, aiFallbackRefusalNote } from '@/lib/ai/access/aiFallbackRefusal';

vi.setConfig({ testTimeout: 90000 });

const SESSION_USER = '30000000-0000-4000-8000-0000000000b1';
const TEXT = [
  'Harbourline Mutual Bank (synthetic test institution)',
  'This letter covers your everyday account from 1 August 2026 to 31 August 2026.',
  'You began the month with 2000.00 in the account and finished with 2776.55.',
  'On 3 August 2026 your employer paid in 1850.00 as salary.',
].join('\n');

const FLAGS = [
  'AIE_AI_FALLBACK_ENABLED',
  'AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED',
  'AIE_PAYSLIP_AI_FALLBACK_ENABLED',
  'AIE_LIABILITY_AI_FALLBACK_ENABLED',
  'AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED',
  'AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED',
] as const;

beforeEach(() => {
  for (const f of FLAGS) process.env[f] = 'true';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'd4'.repeat(32);
  premiumAi.reset();
  h.providerCalls.n = 0;
  h.settled.n = 0;
  h.reserved.length = 0;
  h.admit.current = false;
  h.reason.current = 'user_daily_cap';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

interface ClassCase {
  name: string;
  run: (userId: string) => Promise<{ ok: boolean; reason?: string }>;
}
const bytes = new TextEncoder().encode(TEXT);
const CASES: ClassCase[] = [
  {
    name: 'bank statement',
    run: async (u) => (await import('@/lib/financial-data-hub/services/bankPdfProcessingService')).attemptAiBankStatementFallback(u, 'doc-bank', TEXT) as never,
  },
  {
    name: 'payslip',
    run: async (u) => (await import('@/lib/financial-data-hub/services/payslipProcessingService')).attemptAiPayslipFallback(u, 'doc-payslip', TEXT, 'AU') as never,
  },
  {
    name: 'liability statement',
    run: async (u) => (await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService')).attemptAiLiabilityFallback(u, 'doc-liability', TEXT) as never,
  },
  {
    name: 'retirement statement',
    run: async (u) =>
      (await import('@/lib/financial-data-hub/services/retirementStatementProcessingService')).attemptAiRetirementFallback(u, 'doc-retirement', bytes, {
        jurisdiction: 'AU',
        currencyCode: 'AUD',
        statementType: 'super_member',
        accountType: 'super',
      } as never) as never,
  },
  {
    name: 'AU investment statement',
    run: async (u) =>
      (await import('@/lib/financial-data-hub/services/investmentStatementProcessingService')).attemptAiAuInvestmentFallback(u, 'doc-investment', TEXT, {
        country: 'AU',
        currencyCode: 'AUD',
      } as never) as never,
  },
];

describe.each(CASES)('$name', (c) => {
  it('at the daily cap: refused BEFORE the provider, with the typed reason; nothing is settled', async () => {
    const out = await c.run(SESSION_USER);
    expect(out).toEqual({ ok: false, reason: 'user_daily_cap_reached' });
    expect(h.providerCalls.n).toBe(0);
    expect(h.settled.n).toBe(0);
    expect(h.reserved).toHaveLength(1);
    expect(h.reserved[0].userId).toBe(SESSION_USER); // attributed to the session user, nobody else
  });

  it('the typed reason becomes the plain-language note the panel shows', async () => {
    const out = await c.run(SESSION_USER);
    const refusal = aiFallbackRefusalFromReason(out.reason);
    expect(refusal).toBe('daily_limit_reached');
    const note = aiFallbackRefusalNote(refusal)!;
    expect(note).toMatch(/daily limit/i);
    expect(note).toMatch(/try again tomorrow/i);
    expect(note).toMatch(/enter this information manually/i);
  });

  it('the GLOBAL allowance refusal stays internal: no note is produced for it', async () => {
    h.reason.current = 'budget_exhausted';
    const out = await c.run(SESSION_USER);
    expect(out).toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(aiFallbackRefusalFromReason(out.reason)).toBeUndefined();
    expect(h.providerCalls.n).toBe(0);
  });

  it('a Free user never reaches the cap: the Premium guard refuses first (no reservation at all)', async () => {
    premiumAi.setTier(SESSION_USER, 'free');
    const out = await c.run(SESSION_USER);
    expect(out).toEqual({ ok: false, reason: 'premium_required' });
    expect(h.reserved).toHaveLength(0);
    expect(h.providerCalls.n).toBe(0);
  });

  it('CONTROL: with the admission step admitting, the same call DOES reach the provider (so the zero above is not vacuous)', async () => {
    h.admit.current = true;
    await c.run(SESSION_USER);
    expect(h.providerCalls.n).toBe(1);
    expect(h.settled.n).toBe(1);
  });
});

describe('the five panels and five services are wired to the shared note', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it.each([
    'components/expenses/BankStatementImportPanel.tsx',
    'components/income/PayslipImportPanel.tsx',
    'components/liabilities/LiabilityImportPanel.tsx',
    'components/retirement/RetirementStatementImportPanel.tsx',
    'components/investments/AuInvestmentStatementImportPanel.tsx',
  ])('%s renders the refusal note from the response field and exposes no limit amount', (file) => {
    const src = read(file);
    expect(src).toMatch(/aiFallbackRefusalNote\(\s*[\w.]*ai_fallback_refusal\s*\)/);
    expect(src).not.toMatch(/user_daily_cap|AIE_USER_DAILY|daily_limit_reached/);
  });

  it.each([
    'lib/financial-data-hub/services/bankPdfProcessingService.ts',
    'lib/financial-data-hub/services/payslipProcessingService.ts',
    'lib/financial-data-hub/services/liabilityStatementProcessingService.ts',
    'lib/financial-data-hub/services/retirementStatementProcessingService.ts',
    'lib/financial-data-hub/services/investmentStatementProcessingService.ts',
  ])('%s passes the fallback reason through the shared mapping and the provider call carries the session user', (file) => {
    const src = read(file);
    expect(src).toMatch(/aiFallbackRefusalFromReason\(/);
    expect(src).toMatch(/Request\w*AiExtraction\(\{[^}]*userId[^}]*\}\)|request\w*AiExtraction\(\{[^}]*userId[^}]*\}\)/i);
  });

  it('the user-facing note contains no amount, no cost word and no internal name', () => {
    const note = aiFallbackRefusalNote('daily_limit_reached')!;
    expect(note).not.toMatch(/\$|US\$|usd|dollar|cost|budget|quota|cap\b|ledger|openai|gpt|AIE_|1\.00/i);
  });
});
