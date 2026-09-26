// AIE statement AI fallback -- a confirm is accepted only against a draft the
// server actually issued, and only once (2026-09-25, other-PDF AI proof).
// Written to FAIL on origin/main 8b6692c.
//
// Before: the bank confirm accepted any client body for any document parked
// in `processing`, and the liability/retirement/investment confirms accepted
// one for any `queued` document with no evidence row yet -- including a
// document whose AI fallback never ran -- guarded only by a check-then-act.
// Now each confirm first claims the pending `fdh_ai_fallback_drafts` row
// (migration 0197) with one conditional update; no pending draft, no write.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claimMock, inserts, docRow } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  inserts: [] as Array<{ table: string; row: unknown }>,
  docRow: { current: null as Record<string, unknown> | null },
}));

vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  saveAiFallbackDraft: vi.fn(),
  claimPendingAiFallbackDraft: claimMock,
  releaseClaimedAiFallbackDraft: vi.fn(), releaseClaimedAiFallbackDraftIfNothingWritten: vi.fn(async () => ({ released: true })),
  loadPendingAiFallbackDraft: vi.fn().mockResolvedValue({ found: false, reason: 'none_pending' }),
  documentsWithPendingAiFallbackDrafts: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/financial-data-hub/repositories', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  statementUploadsRepository: { getForUser: vi.fn(async () => ({ data: docRow.current, error: null })) },
}));
vi.mock('@/lib/financial-data-hub/bank-csv/repository', () => ({
  loadDedupIndexForAccount: vi.fn().mockResolvedValue({ byFingerprint: new Map(), bySourceRowHash: new Set(), entries: [] }),
  loadPriorStatementDateRanges: vi.fn().mockResolvedValue(new Map()),
}));

function recordingClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte', 'is', 'not', 'update', 'upsert', 'range']) b[m] = () => b;
      b.insert = (row: unknown) => { inserts.push({ table, row }); return b; };
      b.single = () => Promise.resolve({ data: { id: 'gen' }, error: null });
      b.maybeSingle = () => Promise.resolve({ data: null, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  };
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => recordingClient() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => recordingClient() }));

// The first import pulls in the PDF text-extraction chain.
vi.setConfig({ testTimeout: 60000 });

beforeEach(() => {
  inserts.length = 0;
  claimMock.mockReset();
});

describe('bank statement AI confirm', () => {
  const reviewed = {
    rows: [{ sourceRowNumber: 1, transactionDate: '2026-08-01', descriptionRaw: 'SYNTHETIC', amountOriginal: 10, creditDebit: 'debit' as const, balanceAfter: null }],
    statementPeriodStart: null, statementPeriodEnd: null, declaredOpeningBalance: null, declaredClosingBalance: null, maskedAccountIdentifier: null,
  };

  it('refuses (invalid_state) and writes nothing when the server issued no pending draft for the document', async () => {
    docRow.current = { id: 'doc-b', user_id: 'u', processing_status: 'processing', financial_account_id: 'acct-1', currency_code: 'AUD', household_id: null };
    claimMock.mockResolvedValue({ claimed: false, reason: 'none_pending' });
    const { confirmAiBankStatementFallback } = await import('@/lib/financial-data-hub/services/bankPdfProcessingService');
    await expect(confirmAiBankStatementFallback('u', 'doc-b', reviewed)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(inserts.filter((i) => i.table === 'fdh_transactions')).toHaveLength(0);
  });
});

describe('liability statement AI confirm', () => {
  it('refuses (invalid_state) and writes nothing for a queued document that never produced a draft', async () => {
    docRow.current = { id: 'doc-l', user_id: 'u', processing_status: 'queued', currency_code: 'AUD', household_id: null };
    claimMock.mockResolvedValue({ claimed: false, reason: 'none_pending' });
    const { confirmAiLiabilityFallback } = await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService');
    await expect(
      confirmAiLiabilityFallback('u', 'doc-l', {
        metadata: { statementType: 'credit_card', countryCode: 'AU', currencyCode: 'AUD' },
        facilityType: 'credit_card',
        activities: [{ activityType: 'PURCHASE', activityDate: '2026-07-05', amount: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(inserts.filter((i) => i.table.startsWith('fdh_liability_statement'))).toHaveLength(0);
  });
});
