// Investment Intelligence — AI-fallback document extraction: accept/reject
// (2026-09-17 PO addendum). Exercises applyAiExtractionReview()/
// rejectAiExtractionReview() against a real folio+two-scheme fixture
// modelled directly on the PO's own SBI single-folio top-up statement
// (folio 31994093, L036G SBI Contra Fund, L101G SBI Multi Asset Allocation
// Fund — both already on file from an earlier CAS import), proving:
//   - the one real new transaction line (Purchase, Rs.999.95, 2.694 units)
//     is inserted as genuinely NEW;
//   - a re-run of the SAME accept is impossible (status guard) and a
//     same-fingerprint transaction is never duplicated;
//   - the second scheme (no transaction-level detail, already has history)
//     gets its valuation updated WITHOUT a fabricated transaction, and an
//     honest 'other' reconciliation note is opened instead;
//   - reject() never writes anything and reverts the document's status.
//
// recertifyPosition (documentProcessing.ts) is mocked — it is a deep,
// already-separately-tested certification/reconciliation-config pipeline;
// this test verifies THIS task's own new orchestration logic (dedup,
// opening-balance fallback vs honest note, status transitions), not
// re-proves certification math that has its own test coverage elsewhere.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recertifyPositionMock } = vi.hoisted(() => ({ recertifyPositionMock: vi.fn().mockResolvedValue({ ok: true, error: null }) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: recertifyPositionMock }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

const { tables } = vi.hoisted(() => ({ tables: { current: {} as Record<string, Record<string, unknown>[]> } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeAdmin(tables.current) }));

type Row = Record<string, unknown>;

function makeFakeAdmin(db: Record<string, Row[]>) {
  let nextId = 0;
  function from(table: string) {
    const rows = db[table] ?? (db[table] = []);
    let filtered = rows.slice();
    let pendingWrite: { verb: 'insert' | 'update' | 'upsert'; payload: Row; onConflict?: string } | null = null;

    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] !== val);
        return builder;
      },
      gte(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] as string) >= (val as string));
        return builder;
      },
      lte(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] as string) <= (val as string));
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      insert(payload: Row) {
        pendingWrite = { verb: 'insert', payload };
        return builder;
      },
      update(payload: Row) {
        pendingWrite = { verb: 'update', payload };
        return builder;
      },
      upsert(payload: Row, opts?: { onConflict?: string }) {
        pendingWrite = { verb: 'upsert', payload, onConflict: opts?.onConflict };
        return builder;
      },
      single() {
        return settle('single');
      },
      maybeSingle() {
        return settle('maybeSingle');
      },
      // fetchAllRows() (pagination.ts) always terminates after one page here
      // since the fixture's row counts are far under the real page size —
      // see fakeSupabaseClient.ts's own precedent for the same reasoning.
      range() {
        return settle('many');
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return settle('many').then(resolve, reject);
      },
    };

    function settle(shape: 'single' | 'maybeSingle' | 'many') {
      if (pendingWrite) {
        const { verb, payload, onConflict } = pendingWrite;
        if (verb === 'insert') {
          const created = { id: `gen-${nextId++}`, ...payload };
          rows.push(created);
          return Promise.resolve({ data: shape === 'many' ? [created] : created, error: null });
        }
        if (verb === 'update') {
          for (const r of filtered) Object.assign(r, payload);
          return Promise.resolve({ data: filtered, error: null });
        }
        // upsert: match by onConflict columns against the FULL table (not the
        // pre-write `filtered`, which was computed before any .eq() calls a
        // caller might chain after .upsert() — none of this codebase's own
        // upsert call sites do that, matching real Supabase usage).
        const conflictCols = (onConflict ?? '').split(',').filter(Boolean);
        const existing = conflictCols.length ? rows.find((r) => conflictCols.every((c) => r[c] === payload[c])) : undefined;
        if (existing) {
          Object.assign(existing, payload);
          return Promise.resolve({ data: [existing], error: null });
        }
        const created = { id: `gen-${nextId++}`, ...payload };
        rows.push(created);
        return Promise.resolve({ data: [created], error: null });
      }
      if (shape === 'many') return Promise.resolve({ data: filtered, error: null });
      const first = filtered[0] ?? null;
      return Promise.resolve({ data: first, error: null });
    }

    return builder;
  }
  return { from };
}

const USER_ID = 'user-1';
const ACCOUNT_ID = 'account-31994093';
const INSTRUMENT_CONTRA = 'instrument-l036g';
const INSTRUMENT_MULTI = 'instrument-l101g';
const SOURCE_DOC_ID = 'doc-sbi-topup';

function seedFixture() {
  tables.current = {
    ii_ai_extraction_reviews: [
      {
        id: 'review-1',
        user_id: USER_ID,
        source_document_id: SOURCE_DOC_ID,
        parse_run_id: 'run-1',
        trigger_reason: 'format_unrecognized',
        status: 'pending_review',
        provider_confidence: 0.9,
        statement_period_start: null,
        statement_period_end: null,
        extracted_holdings: [
          {
            schemeName: 'SBI Contra Fund - Regular Plan - Growth',
            isin: 'INF200K01362',
            amcName: 'SBI Mutual Fund',
            folioNumber: '31994093',
            costValue: 99000.0,
            marketValue: 104217.04,
            units: 280.802,
            asOfDateIso: '2026-09-11',
            transactions: [
              {
                dateIso: '2026-09-11',
                description: 'Purchase - Systematic Instalment No - 59',
                amount: 999.95,
                units: 2.694,
                navPrice: 371.1403,
                canonicalType: 'sip',
              },
            ],
          },
          {
            schemeName: 'SBI Multi Asset Allocation Fund - Regular Plan - Growth',
            isin: 'INF200KA1DY6',
            amcName: 'SBI Mutual Fund',
            folioNumber: '31994093',
            costValue: 32000.0,
            marketValue: 32272.42,
            units: 483.398,
            asOfDateIso: '2026-09-11',
            transactions: [],
          },
        ],
      },
    ],
    ii_source_documents: [{ id: SOURCE_DOC_ID, user_id: USER_ID, country_code: 'IN', owner_member_id: null, status: 'ai_review_pending' }],
    ii_accounts: [{ id: ACCOUNT_ID, user_id: USER_ID, institution_name: 'SBI Mutual Fund', folio_number: '31994093', status: 'active' }],
    ii_instruments: [
      { id: INSTRUMENT_CONTRA, instrument_name: 'SBI Contra Fund - Regular Plan - Growth', amc_name: 'SBI Mutual Fund', plan_type: 'regular', option_type: 'growth', country_of_domicile: 'IN', is_active: true },
      { id: INSTRUMENT_MULTI, instrument_name: 'SBI Multi Asset Allocation Fund - Regular Plan - Growth', amc_name: 'SBI Mutual Fund', plan_type: 'regular', option_type: 'growth', country_of_domicile: 'IN', is_active: true },
    ],
    ii_instrument_identifiers: [
      { instrument_id: INSTRUMENT_CONTRA, identifier_scheme: 'isin', identifier_value: 'INF200K01362', country_code: 'IN', is_active: true },
      { instrument_id: INSTRUMENT_MULTI, identifier_scheme: 'isin', identifier_value: 'INF200KA1DY6', country_code: 'IN', is_active: true },
    ],
    ii_scheme_alias_map: [],
    // Both schemes already have real prior history from the earlier full
    // CAS import — the exact scenario the PO's fixture is meant to exercise.
    ii_transactions: [
      { id: 'prior-txn-contra-1', user_id: USER_ID, account_id: ACCOUNT_ID, instrument_id: INSTRUMENT_CONTRA, transaction_fingerprint: 'prior-fp-contra-1', status: 'parsed', transaction_date: '2026-08-11' },
      { id: 'prior-txn-multi-1', user_id: USER_ID, account_id: ACCOUNT_ID, instrument_id: INSTRUMENT_MULTI, transaction_fingerprint: 'prior-fp-multi-1', status: 'parsed', transaction_date: '2026-08-11' },
    ],
    ii_transaction_source_links: [],
    ii_holding_snapshots: [],
    ii_reconciliation_cases: [],
  };
}

describe('applyAiExtractionReview — real SBI single-folio top-up fixture', () => {
  beforeEach(() => {
    seedFixture();
    recertifyPositionMock.mockClear();
  });

  it('inserts the one genuinely new transaction line and resolves BOTH schemes to their existing account/instruments (not new ones)', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    const result = await applyAiExtractionReview(USER_ID, 'review-1');

    expect(result.ok).toBe(true);
    expect(result.summary?.accountsFound).toBe(1); // same folio, not two
    expect(result.summary?.schemesFound).toBe(2);
    expect(result.summary?.newTransactionsCount).toBe(1); // the one real Purchase line
    expect(result.summary?.duplicateTransactionsLinked).toBe(0);

    const contraTxns = tables.current.ii_transactions.filter((t) => t.instrument_id === INSTRUMENT_CONTRA);
    expect(contraTxns).toHaveLength(2); // 1 prior + 1 new
    const newTxn = contraTxns.find((t) => t.id !== 'prior-txn-contra-1')!;
    expect(newTxn.gross_amount).toBe('999.95');
    expect(newTxn.account_id).toBe(ACCOUNT_ID); // resolved to the EXISTING account, no duplicate account created
  });

  it('does not fabricate a transaction for the second scheme (existing history, no transaction-level detail) — updates the valuation and opens an honest note instead', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    await applyAiExtractionReview(USER_ID, 'review-1');

    const multiTxns = tables.current.ii_transactions.filter((t) => t.instrument_id === INSTRUMENT_MULTI);
    expect(multiTxns).toHaveLength(1); // still just the one prior transaction — nothing fabricated

    const snapshot = tables.current.ii_holding_snapshots.find((s) => s.instrument_id === INSTRUMENT_MULTI);
    expect(snapshot).toBeDefined();
    expect(snapshot?.units).toBe('483.398');
    expect(snapshot?.value).toBe('32272.42');

    const notes = tables.current.ii_reconciliation_cases.filter((c) => c.discrepancy_type === 'other');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('re-running accept on an already-accepted review is refused (no double-write)', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    const first = await applyAiExtractionReview(USER_ID, 'review-1');
    expect(first.ok).toBe(true);
    const countAfterFirst = tables.current.ii_transactions.length;

    const second = await applyAiExtractionReview(USER_ID, 'review-1');
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already been accepted/);
    expect(tables.current.ii_transactions.length).toBe(countAfterFirst); // nothing new written
  });

  it('marks the review accepted and the source document parsed', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    await applyAiExtractionReview(USER_ID, 'review-1');
    const review = tables.current.ii_ai_extraction_reviews.find((r) => r.id === 'review-1');
    expect(review?.status).toBe('accepted');
    const doc = tables.current.ii_source_documents.find((d) => d.id === SOURCE_DOC_ID);
    expect(doc?.status).toBe('parsed');
  });

  it('calls recertifyPosition for both touched positions (reuses the existing certification pipeline, never re-implements it)', async () => {
    const { applyAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    await applyAiExtractionReview(USER_ID, 'review-1');
    expect(recertifyPositionMock).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, INSTRUMENT_CONTRA);
    expect(recertifyPositionMock).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, INSTRUMENT_MULTI);
  });
});

describe('rejectAiExtractionReview', () => {
  beforeEach(() => {
    seedFixture();
  });

  it('never writes a transaction/snapshot and reverts the document to its honest pre-AI-fallback status', async () => {
    const { rejectAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    const result = await rejectAiExtractionReview(USER_ID, 'review-1');
    expect(result.ok).toBe(true);

    expect(tables.current.ii_transactions).toHaveLength(2); // unchanged — the two prior rows only
    expect(tables.current.ii_holding_snapshots).toHaveLength(0);

    const review = tables.current.ii_ai_extraction_reviews.find((r) => r.id === 'review-1');
    expect(review?.status).toBe('rejected');
    const doc = tables.current.ii_source_documents.find((d) => d.id === SOURCE_DOC_ID);
    expect(doc?.status).toBe('unsupported'); // trigger_reason was 'format_unrecognized'
  });

  it('refuses to reject a review that has already been decided', async () => {
    const { applyAiExtractionReview, rejectAiExtractionReview } = await import('@/lib/services/investment-intelligence/aiExtractionReviewApply');
    await applyAiExtractionReview(USER_ID, 'review-1');
    const result = await rejectAiExtractionReview(USER_ID, 'review-1');
    expect(result.ok).toBe(false);
  });
});
