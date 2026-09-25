// Investment Intelligence AI review -- accept is claimed ONCE (2026-09-25,
// other-PDF AI proof). Written to FAIL on origin/main 8b6692c.
//
// The old applyAiExtractionReview read the review's status, wrote every
// canonical row, and only then set status='accepted'. Two concurrent accepts
// (double click, a replayed request) both passed the read and both wrote.
// The fixed code claims the review with one conditional update
// (pending_review -> accepted) BEFORE any canonical write.
//
// The fake database here evaluates filters LAZILY, at the moment the query
// settles, which is what a real conditional UPDATE does atomically. (The
// eager-filter fakes elsewhere snapshot rows when the query is built, so they
// cannot model this race either way.)
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recertifyPositionMock, purgeMock } = vi.hoisted(() => ({
  recertifyPositionMock: vi.fn().mockResolvedValue({ ok: true, error: null }),
  purgeMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: recertifyPositionMock }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/investment-intelligence/sourceDocumentPurge', () => ({ purgeSourceDocumentStorage: purgeMock }));

const { tables } = vi.hoisted(() => ({ tables: { current: {} as Record<string, Record<string, unknown>[]> } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeLazyFakeAdmin(tables.current) }));

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

function makeLazyFakeAdmin(db: Record<string, Row[]>) {
  let nextId = 0;
  function from(table: string) {
    const rows = db[table] ?? (db[table] = []);
    const filters: Filter[] = [];
    let pendingWrite: { verb: 'insert' | 'update' | 'upsert'; payload: Row; onConflict?: string } | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      gte(col: string, val: unknown) { filters.push((r) => (r[col] as string) >= (val as string)); return builder; },
      lte(col: string, val: unknown) { filters.push((r) => (r[col] as string) <= (val as string)); return builder; },
      is(col: string, val: unknown) { filters.push((r) => (r[col] ?? null) === val); return builder; },
      insert(payload: Row) { pendingWrite = { verb: 'insert', payload }; return builder; },
      update(payload: Row) { pendingWrite = { verb: 'update', payload }; return builder; },
      upsert(payload: Row, opts?: { onConflict?: string }) { pendingWrite = { verb: 'upsert', payload, onConflict: opts?.onConflict }; return builder; },
      single() { return settle('single'); },
      maybeSingle() { return settle('maybeSingle'); },
      range() { return settle('many'); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return settle('many').then(resolve, reject); },
    };
    function settle(shape: 'single' | 'maybeSingle' | 'many') {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (pendingWrite) {
        const { verb, payload, onConflict } = pendingWrite;
        if (verb === 'insert') {
          const created = { id: `gen-${nextId++}`, ...payload };
          rows.push(created);
          return Promise.resolve({ data: shape === 'many' ? [created] : created, error: null });
        }
        if (verb === 'update') {
          for (const r of matched) Object.assign(r, payload);
          return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
        }
        const cols = (onConflict ?? '').split(',').filter(Boolean);
        const existing = cols.length ? rows.find((r) => cols.every((c) => r[c] === payload[c])) : undefined;
        if (existing) return Promise.resolve({ data: [existing], error: null });
        const created = { id: `gen-${nextId++}`, ...payload };
        rows.push(created);
        return Promise.resolve({ data: [created], error: null });
      }
      if (shape === 'many') return Promise.resolve({ data: matched, error: null });
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    }
    return builder;
  }
  return { from };
}

const USER_ID = 'user-claim';
const DOC_ID = 'doc-claim';

function seed() {
  tables.current = {
    ii_ai_extraction_reviews: [{
      id: 'review-claim', user_id: USER_ID, source_document_id: DOC_ID, parse_run_id: 'run-1',
      trigger_reason: 'format_unrecognized', status: 'pending_review', provider_confidence: 1,
      statement_period_start: null, statement_period_end: null,
      extracted_holdings: [{
        schemeName: 'Synthetic Growth Fund - Direct Plan', isin: 'INF000S00001', amcName: 'Synthetic AMC', folioNumber: 'SYN-FOLIO-1',
        costValue: 5000, marketValue: 5250, units: 100, asOfDateIso: '2026-08-31',
        transactions: [{ dateIso: '2026-08-05', description: 'Purchase', amount: 5000, units: 100, navPrice: 50, canonicalType: 'purchase' }],
      }],
    }],
    ii_source_documents: [{ id: DOC_ID, user_id: USER_ID, country_code: 'IN', owner_member_id: null, status: 'ai_review_pending', storage_path: 'u/doc.pdf', storage_purged_at: null }],
    ii_accounts: [], ii_instruments: [], ii_instrument_identifiers: [], ii_scheme_alias_map: [],
    ii_transactions: [], ii_transaction_source_links: [], ii_holding_snapshots: [], ii_reconciliation_cases: [],
  };
}

describe('applyAiExtractionReview: claimed exactly once', () => {
  beforeEach(() => {
    seed();
    purgeMock.mockClear();
  });

  it('two concurrent accepts: exactly one writes; the other is refused as already decided and writes nothing', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    const [a, b] = await Promise.all([applyAiExtractionReview(USER_ID, 'review-claim'), applyAiExtractionReview(USER_ID, 'review-claim')]);
    const oks = [a, b].filter((r) => r.ok);
    const refused = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].code).toBe('already_decided');
    expect(tables.current.ii_transactions).toHaveLength(1);
    expect(tables.current.ii_holding_snapshots).toHaveLength(1);
    expect(tables.current.ii_ai_extraction_reviews[0].status).toBe('accepted');
  });

  it('a replayed accept after success is refused with already_decided and writes nothing', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    expect((await applyAiExtractionReview(USER_ID, 'review-claim')).ok).toBe(true);
    const before = tables.current.ii_transactions.length;
    const replay = await applyAiExtractionReview(USER_ID, 'review-claim');
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe('already_decided');
    expect(tables.current.ii_transactions.length).toBe(before);
  });

  it('accept purges the original statement file once the user has decided (the staged review needs no PDF)', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    await applyAiExtractionReview(USER_ID, 'review-claim');
    expect(purgeMock).toHaveBeenCalledWith(expect.anything(), DOC_ID, 'u/doc.pdf');
  });

  it('reject also purges, and cannot flip an already-accepted review', async () => {
    const { applyAiExtractionReview, rejectAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    await applyAiExtractionReview(USER_ID, 'review-claim');
    const r = await rejectAiExtractionReview(USER_ID, 'review-claim');
    expect(r.ok).toBe(false);
    expect(tables.current.ii_ai_extraction_reviews[0].status).toBe('accepted');

    seed();
    purgeMock.mockClear();
    const r2 = await rejectAiExtractionReview(USER_ID, 'review-claim');
    expect(r2.ok).toBe(true);
    expect(purgeMock).toHaveBeenCalledWith(expect.anything(), DOC_ID, 'u/doc.pdf');
    expect(tables.current.ii_transactions).toHaveLength(0);
  });
});
