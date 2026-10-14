// Investment Intelligence AI fallback -- the Premium-entitlement gate that
// replaced the II-specific pilot allowlist (14-10-2026).
//
// UNIT-TESTED with the same fake-admin harness as the earlier cohort test it
// supersedes. Proves, for the PROVIDER-REACHING path of the II fallback:
//   (a) a Free / expired / unreadable-entitlement user is refused before the
//       request is built or the provider is touched, and nothing is written;
//   (b) a Premium user who was never on any pilot list succeeds;
//   (c) a former pilot user who is NOT Premium is refused even though the old
//       variables still name them;
//   (d) work already on file (a pending or decided review) is still returned to
//       a user who has since been downgraded -- no new chargeable operation, and
//       no lost data;
//   (e) the kill switch still wins over Premium.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { premiumAi } from '../support/premiumAiAccessMock';

vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()),
);

// The first dynamic import pulls in the whole II provider chain; allow for a cold transform.
vi.setConfig({ testTimeout: 60000 });

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

const holdings = [
  { schemeName: 'SBI Contra Fund', isin: 'INF200K01362', amcName: 'SBI Mutual Fund', folioNumber: '31994093', costValue: 99000, marketValue: 104217.04, units: 280.802, asOfDateIso: '2026-09-11', transactions: [] },
];
const providerResult = { providerConfidence: 0.9, statementPeriodStartIso: null, statementPeriodEndIso: null, holdings };

function ctx(userId: string, provider: unknown, extra: Record<string, unknown> = {}) {
  return {
    userId,
    sourceDocumentId: 'doc-1',
    parseRunId: 'run-1',
    triggerReason: 'format_unrecognized' as const,
    request: { maskedDocumentText: '[masked]' },
    providerOverride: provider as never,
    ...extra,
  };
}

describe('getAiFallbackDocumentExtraction -- Premium gate', () => {
  beforeEach(() => {
    tables.current = {};
    premiumAi.reset();
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.II_AI_FALLBACK_ENABLED = 'true';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('DENIAL: a Free user is refused before the provider is ever called, and no review row is written', async () => {
    premiumAi.setTier('free-user', 'free');
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    const outcome = await getAiFallbackDocumentExtraction(ctx('free-user', provider));
    expect(outcome.outcome).toBe('premium_required');
    expect(provider).not.toHaveBeenCalled();
    expect(tables.current.ii_ai_extraction_reviews ?? []).toHaveLength(0);
    expect(premiumAi.asked).toEqual(['free-user']);
  });

  it('DENIAL: an expired Premium entitlement is refused (downgrade stops NEW execution)', async () => {
    premiumAi.setTier('lapsed-user', 'expired');
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    expect((await getAiFallbackDocumentExtraction(ctx('lapsed-user', provider))).outcome).toBe('premium_required');
    expect(provider).not.toHaveBeenCalled();
  });

  it('DENIAL (fail closed): an unreadable entitlement is refused as entitlement_unavailable, never allowed', async () => {
    premiumAi.setTier('u', 'unavailable');
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    expect((await getAiFallbackDocumentExtraction(ctx('u', provider))).outcome).toBe('entitlement_unavailable');
    expect(provider).not.toHaveBeenCalled();
  });

  it('FORMER PILOT, NOT PREMIUM: refused even though every old II pilot variable still lists them', async () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'former-pilot';
    process.env.II_AI_FALLBACK_PILOT_COHORT_EMAILS = 'former.pilot@example.com';
    premiumAi.setTier('former-pilot', 'free');
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    expect((await getAiFallbackDocumentExtraction(ctx('former-pilot', provider))).outcome).toBe('premium_required');
    expect(provider).not.toHaveBeenCalled();
  });

  it('PREMIUM OUTSIDE THE FORMER COHORT: reaches the provider and gets a normal pending_review outcome (never an auto-write)', async () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true'; // old variables present and naming someone else: inert
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'somebody-else';
    premiumAi.setTier('premium-new-user', 'premium');
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue(providerResult);
    const outcome = await getAiFallbackDocumentExtraction(ctx('premium-new-user', provider));
    expect(outcome.outcome).toBe('pending_review');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(tables.current.ii_ai_extraction_reviews).toHaveLength(1);
    expect(tables.current.ii_ai_extraction_reviews[0].user_id).toBe('premium-new-user');
    expect(tables.current.ii_ai_extraction_reviews[0].status).toBe('pending_review');
  });

  it('ISOLATION: two independent Premium users each get their own review row, owned by themselves', async () => {
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue(providerResult);
    await getAiFallbackDocumentExtraction(ctx('premium-a', provider, { sourceDocumentId: 'doc-a' }));
    await getAiFallbackDocumentExtraction(ctx('premium-b', provider, { sourceDocumentId: 'doc-b' }));
    const owners = (tables.current.ii_ai_extraction_reviews ?? []).map((r) => `${r.user_id}:${r.source_document_id}`).sort();
    expect(owners).toEqual(['premium-a:doc-a', 'premium-b:doc-b']);
  });

  it('REPLAY: a repeat for the same document returns the existing review and makes NO second provider call', async () => {
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue(providerResult);
    const first = await getAiFallbackDocumentExtraction(ctx('premium-a', provider));
    const second = await getAiFallbackDocumentExtraction(ctx('premium-a', provider));
    expect(first.outcome).toBe('pending_review');
    expect(second.outcome).toBe('already_pending');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(tables.current.ii_ai_extraction_reviews).toHaveLength(1);
  });

  it('LIFECYCLE: a user downgraded AFTER the AI read still gets their pending review back (no new chargeable work, no lost data)', async () => {
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue(providerResult);
    await getAiFallbackDocumentExtraction(ctx('premium-a', provider));
    premiumAi.setTier('premium-a', 'free'); // plan ends
    const again = await getAiFallbackDocumentExtraction(ctx('premium-a', provider));
    expect(again.outcome).toBe('already_pending');
    expect(provider).toHaveBeenCalledTimes(1);
    // ... but a DIFFERENT document of the now-Free user cannot start a new AI read.
    const other = await getAiFallbackDocumentExtraction(ctx('premium-a', provider, { sourceDocumentId: 'doc-2' }));
    expect(other.outcome).toBe('premium_required');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('TENANCY: another user\'s review on the same document id is never returned', async () => {
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn().mockResolvedValue(providerResult);
    await getAiFallbackDocumentExtraction(ctx('premium-a', provider, { sourceDocumentId: 'shared-id' }));
    const b = await getAiFallbackDocumentExtraction(ctx('premium-b', provider, { sourceDocumentId: 'shared-id' }));
    expect(b.outcome).toBe('pending_review'); // its own, not a's
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('MALWARE PRECONDITION: with the real scan off and no DEV override, nothing is sent -- Premium does not matter', async () => {
    const prev = { real: process.env.AIE_REAL_MALWARE_SCAN_ENABLED, ovr: process.env.AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN };
    delete process.env.AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN;
    delete process.env.AIE_REAL_MALWARE_SCAN_ENABLED;
    try {
      const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
      const provider = vi.fn().mockResolvedValue(providerResult);
      expect((await getAiFallbackDocumentExtraction(ctx('premium-a', provider))).outcome).toBe('malware_scan_not_enforced');
      expect(provider).not.toHaveBeenCalled();
      process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
      expect((await getAiFallbackDocumentExtraction(ctx('premium-a', provider))).outcome).toBe('pending_review');
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      for (const [k, v] of [['AIE_REAL_MALWARE_SCAN_ENABLED', prev.real], ['AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN', prev.ovr]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('KILL SWITCH: Premium does not override II_AI_FALLBACK_ENABLED=false -- no entitlement read, no provider call', async () => {
    delete process.env.II_AI_FALLBACK_ENABLED;
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const provider = vi.fn();
    expect((await getAiFallbackDocumentExtraction(ctx('premium-a', provider))).outcome).toBe('disabled');
    expect(provider).not.toHaveBeenCalled();
    expect(premiumAi.asked).toEqual([]);
  });
});
