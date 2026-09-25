// Investment Intelligence — generalized AI-fallback mechanism, wiring test
// (2026-09-17 PO addendum). Exercises the REAL processSourceDocument() —
// not just the extracted aiFallbackDocumentExtraction.ts module in
// isolation — to prove the two new call sites (format_unrecognized /
// parse_failed) are actually reached and actually change the function's
// return value, end to end.
//
// Uses genuinely unrecognizable text (no real financial-statement
// vocabulary at all) rather than the PO's real SBI fixture PDF, because —
// a real, honest finding from this task — that fixture's document format
// IS already handled by this codebase's existing cams_folio_details_v1
// parser (confirmed via a standalone script against the real file:
// validateParsedOutput().ok === true, 1 transaction + 2 holdings correctly
// extracted). It does not exercise this document-level trigger at all; see
// the final report for the full finding and where that fixture's real
// numbers WERE used instead (iiAiExtractionReviewApply.test.ts's accept-flow
// test).
//
// mime_type is set to 'text/csv' (an allowed upload type) so this test can
// supply plain garbage text directly, without needing a real PDF and
// without touching pdfExtraction.ts's pdf-parse dependency at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/investment-intelligence/storage', () => ({
  downloadSourceDocumentObject: vi.fn().mockResolvedValue({ bytes: new TextEncoder().encode('completely unrecognizable garbage, not a financial statement of any kind'), error: null }),
}));

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
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
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
      single() {
        return settle('single');
      },
      maybeSingle() {
        return settle('maybeSingle');
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return settle('many').then(resolve, reject);
      },
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

const USER_ID = 'user-1';
const DOC_ID = 'doc-garbage-1';

function seedDoc() {
  tables.current = {
    ii_source_documents: [{ id: DOC_ID, user_id: USER_ID, status: 'uploaded', mime_type: 'text/csv', storage_path: 'x', country_code: 'IN' }],
    ii_document_parse_runs: [],
    ii_reconciliation_cases: [],
    ii_ai_extraction_reviews: [],
  };
}

describe('processSourceDocument — generalized AI-fallback wiring (format_unrecognized)', () => {
  beforeEach(() => {
    seedDoc();
    delete process.env.II_AI_FALLBACK_ENABLED;
  });

  it('shows the honest original failure message when AI-fallback is disabled (the default) — never silently skips the message', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID });
    expect(result.ok).toBe(false);
    expect(result.status).not.toBe('ai_review_pending');
    expect(result.error).toBe('Statement source/format could not be confidently identified.');
  }, 20000);

  it('stages a pending review and returns ai_review_pending when AI-fallback is enabled and the fake provider produces usable data', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    const provider = vi.fn().mockResolvedValue({
      providerConfidence: 0.8,
      statementPeriodStartIso: null,
      statementPeriodEndIso: null,
      holdings: [{ schemeName: 'Some Fund', isin: null, amcName: null, folioNumber: null, costValue: 100, marketValue: 110, units: 5, asOfDateIso: '2026-09-11', transactions: [] }],
    });
    // 2026-09-25: review before write -- a usable AI read ALWAYS stops at the
    // staged review (the 2026-09-20 auto-apply was removed; see
    // iiAiReviewBeforeWrite.test.ts). The document text contains no PII the
    // masker would tokenise, so no masking key is needed here.
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID, aiDocumentProviderOverride: provider });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false); // nothing written to holdings yet
    expect(result.status).toBe('ai_review_pending');
    expect(result.error).toBeNull();
    expect(result.aiExtractionReviewId).toBeTruthy();
    expect(tables.current.ii_ai_extraction_reviews).toHaveLength(1);
    expect(tables.current.ii_ai_extraction_reviews[0].trigger_reason).toBe('format_unrecognized');

    const doc = tables.current.ii_source_documents.find((d) => d.id === DOC_ID);
    expect(doc?.status).toBe('ai_review_pending');
  }, 20000);

  it('is honest that BOTH paths were attempted when AI-fallback is enabled but the provider also fails', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    const provider = vi.fn().mockRejectedValue(new Error('provider exploded'));
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID, aiDocumentProviderOverride: provider });

    expect(result.status).not.toBe('ai_review_pending');
    expect(result.error).toContain('Statement source/format could not be confidently identified.');
    expect(result.error).toContain('An AI-assisted re-extraction was also attempted and failed');
    expect(result.error).toContain('provider exploded');
  }, 20000);

  it('never claims an AI attempt was made when the flag is simply off', async () => {
    delete process.env.II_AI_FALLBACK_ENABLED;
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const result = await processSourceDocument({ userId: USER_ID, sourceDocumentId: DOC_ID });
    expect(result.error).not.toContain('AI-assisted');
  }, 20000);
});
