/**
 * AIE per-user daily cap -- the Investment Intelligence statement path (the sixth caller of the shared gateway).
 * EVIDENCE LABEL: UNIT-TESTED. The provider is injected; no database or provider is touched.
 *
 *   - the provider function is handed the SESSION user (so the real provider can attribute the reservation);
 *   - a cap refusal comes back as `daily_limit_reached` (no staged review, nothing written);
 *   - the failure message shown on the statement upload names no amount or internal term and offers manual entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);
const { tables } = vi.hoisted(() => ({ tables: { current: {} as Record<string, Record<string, unknown>[]> } }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const rows = tables.current[table] ?? (tables.current[table] = []);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'eq']) b[m] = () => b;
      b.insert = (payload: Record<string, unknown>) => {
        rows.push({ id: 'staged-1', ...payload });
        return b;
      };
      b.single = () => Promise.resolve({ data: rows[rows.length - 1] ?? null, error: null });
      b.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return b;
    },
  }),
}));

import { premiumAi } from '../support/premiumAiAccessMock';
import { getAiFallbackDocumentExtraction, IiAiProviderOutcomeError } from '@/lib/services/investment-intelligence/aiFallbackDocumentExtraction';

const USER = '40000000-0000-4000-8000-0000000000c1';
const ORIGINAL = process.env.II_AI_FALLBACK_ENABLED;

beforeEach(() => {
  tables.current = {};
  premiumAi.reset();
  process.env.II_AI_FALLBACK_ENABLED = 'true';
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.II_AI_FALLBACK_ENABLED;
  else process.env.II_AI_FALLBACK_ENABLED = ORIGINAL;
});

const ctx = (providerOverride: never) => ({
  userId: USER,
  sourceDocumentId: 'doc-1',
  parseRunId: null,
  triggerReason: 'format_unrecognized' as const,
  request: { maskedDocumentText: '[masked]' },
  providerOverride,
});
const evidence = { idempotencyKey: 'k', providerRequestIds: [], model: 'gpt-4o-mini' };

describe('Investment Intelligence AI reading and the per-user daily cap', () => {
  it('hands the provider the session user', async () => {
    const provider = vi.fn(async () => {
      throw new IiAiProviderOutcomeError('schema_rejected', evidence);
    });
    await getAiFallbackDocumentExtraction(ctx(provider as never));
    expect(provider).toHaveBeenCalledTimes(1);
    expect((provider.mock.calls[0] as unknown[])[1]).toEqual({ userId: USER });
  });

  it('a per-user cap refusal is daily_limit_reached, and nothing is staged', async () => {
    const provider = vi.fn(async () => {
      throw new IiAiProviderOutcomeError('user_daily_cap_reached', evidence);
    });
    const out = await getAiFallbackDocumentExtraction(ctx(provider as never));
    expect(out).toEqual({ outcome: 'daily_limit_reached' });
    expect(tables.current['ii_ai_extraction_reviews'] ?? []).toEqual([]);
  });

  it('the global allowance refusal is NOT turned into the daily-limit outcome (it stays a generic failure)', async () => {
    const provider = vi.fn(async () => {
      throw new IiAiProviderOutcomeError('budget_exhausted', evidence);
    });
    const out = await getAiFallbackDocumentExtraction(ctx(provider as never));
    expect(out.outcome).toBe('still_failed');
  });

  it('a Free user is refused by the Premium guard before the provider is asked (the cap is never consulted)', async () => {
    premiumAi.setTier(USER, 'free');
    const provider = vi.fn();
    const out = await getAiFallbackDocumentExtraction(ctx(provider as never));
    expect(out.outcome).toBe('premium_required');
    expect(provider).not.toHaveBeenCalled();
  });

  it('the message shown on the statement upload is plain: daily limit, try tomorrow, enter manually, no amount or internal term', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'lib/services/investment-intelligence/documentProcessing.ts'), 'utf8');
    const m = src.match(/case 'daily_limit_reached':[\s\S]*?return `([^`]*)`/);
    expect(m).not.toBeNull();
    const text = m![1].replace('${baseMessage}', 'BASE');
    expect(text).toMatch(/daily limit/i);
    expect(text).toMatch(/try again tomorrow/i);
    expect(text).toMatch(/manually/i);
    expect(text).not.toMatch(/\$|usd|cost|budget|quota|ledger|openai|gpt|AIE_/i);
  });
});
