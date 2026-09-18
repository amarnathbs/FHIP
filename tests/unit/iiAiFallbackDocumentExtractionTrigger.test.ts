// Investment Intelligence — generalized AI-fallback trigger (2026-09-17 PO
// addendum): parse failed OR format unrecognized OR reconciliation failed.
// This file covers the two EARLIER, document-level trigger reasons
// (format_unrecognized / parse_failed); reconciliation_failed is covered by
// iiAiFallbackReconciliationTrigger.test.ts. Never calls a real AI
// provider — every test injects a fake provider via `providerOverride`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { documentAiFallbackTriggerReason } from '@/lib/services/investment-intelligence/aiFallbackDocumentExtraction';

const { tables } = vi.hoisted(() => ({ tables: { current: {} as Record<string, Record<string, unknown>[]> } }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeFakeAdmin(tables.current),
}));

function makeFakeAdmin(db: Record<string, Record<string, unknown>[]>) {
  let nextId = 0;
  function from(table: string) {
    const rows = db[table] ?? (db[table] = []);
    let filtered = rows.slice();
    let pendingInsert: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      insert(payload: Record<string, unknown>) {
        pendingInsert = payload;
        return builder;
      },
      single() {
        if (pendingInsert) {
          const created = { id: `gen-${nextId++}`, ...pendingInsert };
          rows.push(created);
          return Promise.resolve({ data: created, error: null });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  return { from };
}

describe('documentAiFallbackTriggerReason', () => {
  it('is "format_unrecognized" when the deterministic parser could not identify the document at all', () => {
    expect(documentAiFallbackTriggerReason({ parserRecognizedFormat: false, validationOk: null })).toBe('format_unrecognized');
  });
  it('is "parse_failed" when a parser was identified but its own validation rejected the result', () => {
    expect(documentAiFallbackTriggerReason({ parserRecognizedFormat: true, validationOk: false })).toBe('parse_failed');
  });
  it('is null when parsing succeeded — no fallback needed at the document level', () => {
    expect(documentAiFallbackTriggerReason({ parserRecognizedFormat: true, validationOk: true })).toBeNull();
  });
});

describe('getAiFallbackDocumentExtraction', () => {
  const ORIGINAL = process.env.II_AI_FALLBACK_ENABLED;
  beforeEach(() => {
    tables.current = {};
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.II_AI_FALLBACK_ENABLED;
    else process.env.II_AI_FALLBACK_ENABLED = ORIGINAL;
  });

  it('never calls the provider when disabled (the default) — a genuinely unrecognized format still needs the honest failure path', async () => {
    delete process.env.II_AI_FALLBACK_ENABLED;
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'user-1',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('disabled');
    expect(provider).not.toHaveBeenCalled();
  });

  it('stages a pending review when the provider produces usable data (scheme, cost, market value, positive units)', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue({
      providerConfidence: 0.88,
      statementPeriodStartIso: null,
      statementPeriodEndIso: null,
      holdings: [
        { schemeName: 'SBI Contra Fund', isin: 'INF200K01362', amcName: 'SBI Mutual Fund', folioNumber: '31994093', costValue: 99000, marketValue: 104217.04, units: 280.802, asOfDateIso: '2026-09-11', transactions: [] },
      ],
    });
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'user-1',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('pending_review');
    expect(provider).toHaveBeenCalledTimes(1);
    if (outcome.outcome === 'pending_review') {
      expect(outcome.holdings).toHaveLength(1);
      expect(tables.current.ii_ai_extraction_reviews).toHaveLength(1);
      expect(tables.current.ii_ai_extraction_reviews[0].status).toBe('pending_review');
    }
  });

  it('does not re-call the provider on a reprocess click once a review is already pending for this document', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue({
      providerConfidence: 0.88,
      statementPeriodStartIso: null,
      statementPeriodEndIso: null,
      holdings: [{ schemeName: 'X', isin: null, amcName: null, folioNumber: null, costValue: 1, marketValue: 1, units: 1, asOfDateIso: '2026-09-11', transactions: [] }],
    });
    const ctx = { userId: 'user-1', sourceDocumentId: 'doc-1', parseRunId: 'run-1', triggerReason: 'format_unrecognized' as const, request: { maskedDocumentText: '[masked]' }, providerOverride: provider };
    const first = await getAiFallbackDocumentExtraction(ctx);
    const second = await getAiFallbackDocumentExtraction(ctx);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe('pending_review');
    expect(second.outcome).toBe('already_pending');
  });

  it('reports "no_usable_data" (never a fabricated holding) when the provider returns nothing meeting the minimum bar', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue({ providerConfidence: 0.1, statementPeriodStartIso: null, statementPeriodEndIso: null, holdings: [] });
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'user-1',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'parse_failed',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('no_usable_data');
    expect(tables.current.ii_ai_extraction_reviews ?? []).toHaveLength(0);
  });

  it('reports "unavailable" (never a fabricated result) when no provider can be resolved', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'user-1',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: null,
    });
    expect(outcome.outcome).toBe('unavailable');
  });
});
