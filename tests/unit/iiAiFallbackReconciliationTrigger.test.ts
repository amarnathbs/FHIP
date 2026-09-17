// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Unit coverage for aiFallbackReconciliation.ts's trigger condition and
// caching. Never calls a real AI provider — a fake provider is injected via
// `providerOverride` in every test, per the task's own instruction to test
// this with a mock/fake provider only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  schemeReconciliationFailed,
  isAiFallbackReconciliationEnabled,
  getAiFallbackReconciliation,
  type AieMaskedReconciliationResult,
} from '@/lib/services/investment-intelligence/aiFallbackReconciliation';

const { adminTables } = vi.hoisted(() => ({
  adminTables: { current: {} as Record<string, Record<string, unknown>[]> },
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeFakeAdmin(adminTables.current),
}));

vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// A small, purpose-built fake that correctly handles insert().select().single()
// returning a single object (the shared tests/unit/support fake returns an
// array in this situation, which does not match this module's own
// `.single()` usage in documentProcessing.ts's openReconciliationCase).
function makeFakeAdmin(tables: Record<string, Record<string, unknown>[]>) {
  let nextId = 0;
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let filtered = rows.slice();
    let pendingInsert: Record<string, unknown> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;

    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      insert(payload: Record<string, unknown>) {
        pendingInsert = payload;
        return builder;
      },
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        return builder;
      },
      single() {
        if (pendingInsert) {
          const created = { id: `case-${nextId++}`, status: 'open', ...pendingInsert };
          rows.push(created);
          return Promise.resolve({ data: created, error: null });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (pendingUpdate) {
          for (const r of filtered) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  return { from };
}

const FAKE_RESULT: AieMaskedReconciliationResult = {
  correctedClosingUnits: '156.618',
  correctedLedgerSummary: 'AI-reconstructed ledger for the disputed period.',
  providerConfidence: 0.92,
};

describe('schemeReconciliationFailed', () => {
  it('is false when the position is certified and within tolerance', () => {
    expect(schemeReconciliationFailed({ status: 'certified', unitVarianceWithinTolerance: true })).toBe(false);
  });
  it('is true when certification status is failed', () => {
    expect(schemeReconciliationFailed({ status: 'failed', unitVarianceWithinTolerance: null })).toBe(true);
  });
  it('is true when unit variance is explicitly outside tolerance, regardless of status', () => {
    expect(schemeReconciliationFailed({ status: 'certified_with_warnings', unitVarianceWithinTolerance: false })).toBe(true);
  });
  it('is false when variance is simply unknown (null) and status is not failed', () => {
    expect(schemeReconciliationFailed({ status: 'pending', unitVarianceWithinTolerance: null })).toBe(false);
  });
});

describe('isAiFallbackReconciliationEnabled', () => {
  const ORIGINAL = process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
    else process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = ORIGINAL;
  });

  it('defaults OFF when unset', () => {
    delete process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
    expect(isAiFallbackReconciliationEnabled()).toBe(false);
  });
  it('stays OFF for any value other than the literal string "true"', () => {
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = 'TRUE';
    expect(isAiFallbackReconciliationEnabled()).toBe(false);
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = '1';
    expect(isAiFallbackReconciliationEnabled()).toBe(false);
  });
  it('is ON only when set to exactly "true"', () => {
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = 'true';
    expect(isAiFallbackReconciliationEnabled()).toBe(true);
  });
});

describe('getAiFallbackReconciliation — trigger condition and caching', () => {
  const ORIGINAL = process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
  beforeEach(() => {
    adminTables.current = {};
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
    else process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = ORIGINAL;
  });

  it('never calls the provider when the feature flag is disabled (the default)', async () => {
    delete process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED;
    const provider = vi.fn().mockResolvedValue(FAKE_RESULT);
    const outcome = await getAiFallbackReconciliation({
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'instrument-1',
      sourceDocumentId: 'doc-1',
      request: { maskedLedgerText: '[masked]', statementClosingUnits: '100' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('disabled');
    expect(provider).not.toHaveBeenCalled();
  });

  it('calls the provider exactly once on a genuine reconciliation failure when enabled, and persists a resolved case', async () => {
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = 'true';
    const provider = vi.fn().mockResolvedValue(FAKE_RESULT);
    const outcome = await getAiFallbackReconciliation({
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'instrument-1',
      sourceDocumentId: 'doc-1',
      request: { maskedLedgerText: '[masked]', statementClosingUnits: '156.618' },
      providerOverride: provider,
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe('corrected');
    if (outcome.outcome === 'corrected') {
      expect(outcome.result.correctedClosingUnits).toBe('156.618');
    }
    const cases = adminTables.current['ii_reconciliation_cases'] ?? [];
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe('resolved');
    expect(cases[0].discrepancy_type).toBe('ai_fallback_reconciliation_attempted');
  });

  it('does not call the provider again for the same position/document once cached — returns the cached result instead', async () => {
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = 'true';
    const provider = vi.fn().mockResolvedValue(FAKE_RESULT);
    const ctx = {
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'instrument-1',
      sourceDocumentId: 'doc-1',
      request: { maskedLedgerText: '[masked]', statementClosingUnits: '156.618' },
      providerOverride: provider,
    };
    const first = await getAiFallbackReconciliation(ctx);
    const second = await getAiFallbackReconciliation(ctx);
    expect(provider).toHaveBeenCalledTimes(1); // second call must be served from cache, not a fresh AI call
    expect(first.outcome).toBe('corrected');
    expect(second.outcome).toBe('cached');
    if (second.outcome === 'cached') {
      expect(second.result.correctedClosingUnits).toBe('156.618');
    }
  });

  it('reports "unavailable" (never a fabricated number) when no provider can be resolved', async () => {
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = 'true';
    const outcome = await getAiFallbackReconciliation({
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'instrument-1',
      sourceDocumentId: 'doc-1',
      request: { maskedLedgerText: '[masked]', statementClosingUnits: '100' },
      providerOverride: null,
    });
    expect(outcome.outcome).toBe('unavailable');
  });

  it('reports "still_failed" (not a fabricated number) when the provider itself throws', async () => {
    process.env.II_AI_FALLBACK_RECONCILIATION_ENABLED = 'true';
    const provider = vi.fn().mockRejectedValue(new Error('provider timeout'));
    const outcome = await getAiFallbackReconciliation({
      userId: 'user-1',
      accountId: 'account-1',
      instrumentId: 'instrument-1',
      sourceDocumentId: 'doc-1',
      request: { maskedLedgerText: '[masked]', statementClosingUnits: '100' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('still_failed');
  });
});
