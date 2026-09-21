// Investment Intelligence AI-fallback — pilot-cohort gate unreachability
// (2026-09-21 fix, M13A finding). Same fake-admin-client harness as
// tests/unit/iiAiFallbackDocumentExtractionTrigger.test.ts, extended to
// prove: (a) a non-cohort user's call never reaches the provider or writes a
// ii_ai_extraction_reviews row when enforcement is on, and (b) a
// cohort-approved user's call still works exactly as before — the
// legitimate path is not collateral damage of the fix.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const ENV_KEYS = ['II_AI_FALLBACK_ENABLED', 'II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'II_AI_FALLBACK_PILOT_COHORT_USER_IDS', 'II_AI_FALLBACK_PILOT_COHORT_EMAILS'] as const;
let saved: Record<string, string | undefined>;

describe('getAiFallbackDocumentExtraction — pilot-cohort gate', () => {
  beforeEach(() => {
    tables.current = {};
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('DENIAL: a non-cohort user is refused before the provider is ever called, and no review row is written', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'pilot-user-a';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'not-a-pilot-user',
      userEmail: 'nobody@example.com',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('cohort_denied');
    expect(provider).not.toHaveBeenCalled();
    expect(tables.current.ii_ai_extraction_reviews ?? []).toHaveLength(0);
  });

  it('DENIAL (fail-closed): enforcement on with a completely empty allowlist still denies — never silently allows all', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'anyone',
      userEmail: 'anyone@example.com',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('cohort_denied');
    expect(provider).not.toHaveBeenCalled();
  });

  it('LEGITIMATE PATH: a cohort-approved user still reaches the provider and gets a normal pending_review outcome', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'pilot-user-a';
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue({
      providerConfidence: 0.9,
      statementPeriodStartIso: null,
      statementPeriodEndIso: null,
      holdings: [
        { schemeName: 'SBI Contra Fund', isin: 'INF200K01362', amcName: 'SBI Mutual Fund', folioNumber: '31994093', costValue: 99000, marketValue: 104217.04, units: 280.802, asOfDateIso: '2026-09-11', transactions: [] },
      ],
    });
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'pilot-user-a',
      userEmail: 'pilot@example.com',
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('pending_review');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(tables.current.ii_ai_extraction_reviews).toHaveLength(1);
  });

  it('LEGITIMATE PATH: enforcement OFF (the default/current production state) still works for every user, unchanged', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    // II_AI_FALLBACK_PILOT_COHORT_ENFORCED intentionally left unset.
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue({
      providerConfidence: 0.9,
      statementPeriodStartIso: null,
      statementPeriodEndIso: null,
      holdings: [{ schemeName: 'X', isin: null, amcName: null, folioNumber: null, costValue: 1, marketValue: 1, units: 1, asOfDateIso: '2026-09-11', transactions: [] }],
    });
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'literally-any-user',
      userEmail: null,
      sourceDocumentId: 'doc-1',
      parseRunId: 'run-1',
      triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: '[masked]' },
      providerOverride: provider,
    });
    expect(outcome.outcome).toBe('pending_review');
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
