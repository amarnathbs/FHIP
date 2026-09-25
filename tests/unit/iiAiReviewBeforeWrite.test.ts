// Investment Intelligence AI fallback -- REVIEW BEFORE WRITE (2026-09-25,
// other-PDF AI proof). Written to FAIL on origin/main 8b6692c:
//
//   1. A usable AI read used to be auto-applied straight into canonical ii_*
//      rows (the 2026-09-20 design). The apply module is mocked here to
//      succeed, so on the old code the document comes back 'parsed' and the
//      apply step is invoked; the fixed code must stop at 'ai_review_pending'
//      and never invoke it.
//   2. The document text used to be masked EAGERLY, before any gate, and
//      maskText throws without AIE_MASK_TOKEN_ENCRYPTION_KEY (production has
//      none) -- so an unrecognised statement with any PII crashed processing
//      even with II AI switched off.
//   3. No model / request id / token count was recorded for an II AI call.
//
// Synthetic text only; no real provider is ever called.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { auditMock, applyMock, downloadMock } = vi.hoisted(() => ({
  auditMock: vi.fn().mockResolvedValue({ error: null }),
  applyMock: vi.fn().mockResolvedValue({ ok: true, error: null, summary: { accountsFound: 1, schemesFound: 1, newTransactionsCount: 1, duplicateTransactionsLinked: 0, missingTransactionsCount: 0 } }),
  downloadMock: vi.fn(),
}));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: auditMock }));
vi.mock('@/lib/services/investment-intelligence/storage', () => ({ downloadSourceDocumentObject: downloadMock }));
vi.mock('@/lib/services/investment-intelligence/aiExtractionReviewApply', () => ({ applyAiExtractionReview: applyMock, rejectAiExtractionReview: vi.fn() }));

const { tables } = vi.hoisted(() => ({ tables: { current: {} as Record<string, Record<string, unknown>[]> } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeAdmin(tables.current) }));

type Row = Record<string, unknown>;

function makeFakeAdmin(db: Record<string, Row[]>) {
  let nextId = 0;
  function from(table: string) {
    const rows = db[table] ?? (db[table] = []);
    let filtered = rows.slice();
    let pendingWrite: { verb: 'insert' | 'update'; payload: Row } | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq(col: string, val: unknown) { filtered = filtered.filter((r) => r[col] === val); return builder; },
      in(col: string, vals: unknown[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return builder; },
      insert(payload: Row) { pendingWrite = { verb: 'insert', payload }; return builder; },
      update(payload: Row) { pendingWrite = { verb: 'update', payload }; return builder; },
      single() { return settle('single'); },
      maybeSingle() { return settle('maybeSingle'); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return settle('many').then(resolve, reject); },
    };
    function settle(shape: 'single' | 'maybeSingle' | 'many') {
      if (pendingWrite) {
        if (pendingWrite.verb === 'insert') {
          const created = { id: `gen-${nextId++}`, ...pendingWrite.payload };
          rows.push(created);
          return Promise.resolve({ data: shape === 'many' ? [created] : created, error: null });
        }
        for (const r of filtered) Object.assign(r, pendingWrite.payload);
        return Promise.resolve({ data: filtered, error: null });
      }
      if (shape === 'many') return Promise.resolve({ data: filtered, error: null });
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    }
    return builder;
  }
  return { from };
}

const USER_ID = 'user-ii-rbw';
const DOC_ID = 'doc-ii-rbw';

// Synthetic, deliberately unrecognisable to every deterministic II parser, and
// carrying PII the masker DOES tokenise (an email and a PAN) -- the input that
// made eager masking throw.
const UNRECOGNISED_WITH_PII = [
  'Quarterly holdings letter for Ms Zelda Quarrington',
  'Contact: zelda.q@example.invalid',
  'PAN: ABCDE1234F',
  'Your balances are shown below in prose rather than a table.',
].join('\n');

function seed() {
  tables.current = {
    ii_source_documents: [{ id: DOC_ID, user_id: USER_ID, status: 'uploaded', mime_type: 'text/csv', storage_path: 'x', country_code: 'IN' }],
    ii_document_parse_runs: [],
    ii_reconciliation_cases: [],
    ii_ai_extraction_reviews: [],
    ii_transactions: [],
    ii_holding_snapshots: [],
  };
}

const saved: Record<string, string | undefined> = {};
const KEYS = ['II_AI_FALLBACK_ENABLED', 'II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'AIE_MASK_TOKEN_ENCRYPTION_KEY'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  seed();
  auditMock.mockClear();
  applyMock.mockClear();
  downloadMock.mockReset();
  downloadMock.mockResolvedValue({ bytes: new TextEncoder().encode(UNRECOGNISED_WITH_PII), error: null });
  delete process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const usableProvider = () =>
  vi.fn().mockResolvedValue({
    providerConfidence: 1,
    statementPeriodStartIso: null,
    statementPeriodEndIso: null,
    holdings: [{ schemeName: 'Synthetic Balanced Fund', isin: null, amcName: 'Synthetic AMC', folioNumber: '[MASKED:folio:t:abc]', costValue: 1000, marketValue: 1100, units: 50, asOfDateIso: '2026-08-31', transactions: [] }],
    evidence: { idempotencyKey: 'ii-doc-extract:test', providerRequestIds: ['req_synthetic_1'], inputTokens: 900, outputTokens: 300, model: 'gpt-4o-mini' },
  });

describe('II AI fallback: review before write', () => {
  it('a usable AI read stops at ai_review_pending; nothing canonical is written and the apply step is never invoked', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'b2'.repeat(32);
    const provider = usableProvider();
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID, aiDocumentProviderOverride: provider });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(applyMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('ai_review_pending');
    expect(result.aiExtractionReviewId).toBeTruthy();
    expect(tables.current.ii_ai_extraction_reviews).toHaveLength(1);
    expect(tables.current.ii_ai_extraction_reviews[0].status).toBe('pending_review');
    expect(tables.current.ii_transactions).toHaveLength(0);
    expect(tables.current.ii_holding_snapshots).toHaveLength(0);
    expect(tables.current.ii_source_documents[0].status).toBe('ai_review_pending');
  }, 20000);

  it('records the AI call evidence (model, cost key, request id, tokens) on the review-pending audit event -- identifiers and counts only', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'b2'.repeat(32);
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID, aiDocumentProviderOverride: usableProvider() });

    const pendingEvent = auditMock.mock.calls.map((c) => c[0]).find((e) => e.metadata?.reason === 'ai_review_pending');
    expect(pendingEvent).toBeDefined();
    expect(pendingEvent.metadata).toMatchObject({ ai_model: 'gpt-4o-mini', ai_cost_key: 'ii-doc-extract:test', ai_provider_request_ids: ['req_synthetic_1'], ai_input_tokens: 900, ai_output_tokens: 300 });
    expect(JSON.stringify(pendingEvent.metadata)).not.toMatch(/Quarrington|example\.invalid|ABCDE1234F/);
  }, 20000);
});

describe('II AI fallback: masking is lazy and fails closed', () => {
  it('AI OFF + no masking key: an unrecognised statement with PII returns the honest failure instead of crashing', async () => {
    delete process.env.II_AI_FALLBACK_ENABLED;
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Statement source/format could not be confidently identified.');
  }, 20000);

  it('AI ON + no masking key: the provider is never called and nothing is staged (fail closed, never an unmasked call)', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    const provider = usableProvider();
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID, aiDocumentProviderOverride: provider });
    expect(provider).not.toHaveBeenCalled();
    expect(result.status).not.toBe('ai_review_pending');
    expect(tables.current.ii_ai_extraction_reviews).toHaveLength(0);
    expect(tables.current.ii_transactions).toHaveLength(0);
  }, 20000);
});
