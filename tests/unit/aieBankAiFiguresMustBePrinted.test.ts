// AIE bank-statement AI fallback -- figures must be PRINTED, and a statement
// with no per-line balance is still reconciled opening -> closing
// (2026-09-25, other-PDF AI proof). Written to FAIL on origin/main 8b6692c.
//
// Found LIVE on DEV with real gpt-4o-mini: for a synthetic letter-style
// statement that prints no running balance, the model returned a computed
// balance after every line (3850.00, 2900.00, 2776.55). The row-level
// rollforward then "reconciled" the model's own arithmetic against itself and
// the statement was certified; the one real check (the printed closing
// balance) only caught a mismatch by accident of another code path, and the
// stored reconciliation row showed variance 0.00 for a statement that was
// 23.45 out.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { facts } = vi.hoisted(() => ({ facts: { current: null as unknown } }));
vi.mock('@/lib/aie/pilotCohortEmail', () => ({ resolveEmailForAiePilotCohort: vi.fn().mockResolvedValue('p@fhip-test.invalid') }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  saveAiFallbackDraft: vi.fn().mockResolvedValue({ persisted: true, draftId: 'd' }),
  claimPendingAiFallbackDraft: vi.fn(), releaseClaimedAiFallbackDraft: vi.fn(),
  loadPendingAiFallbackDraft: vi.fn(), documentsWithPendingAiFallbackDrafts: vi.fn(),
}));
vi.mock('@/lib/aie/adapters/bankStatement/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestBankStatementAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current })),
}));

vi.setConfig({ testTimeout: 60000 });

const v = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present' : null });

// The synthetic letter: no running balance is printed anywhere.
const LETTER = [
  'Harbourline Mutual Bank (synthetic test institution)',
  'This letter covers your everyday account from 1 August 2026 to 31 August 2026.',
  'You began the month with 2000.00 in the account.',
  'On 3 August 2026 your employer paid in 1850.00 as salary.',
  'On 7 August 2026 you paid 950.00 for rent.',
  'On 12 August 2026 you spent 123.45 at a grocer.',
  'You finished the month with 2800.00 in the account.',
].join('\n');

beforeEach(() => {
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_PILOT_COHORT_ENFORCED = 'false';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'e5'.repeat(32);
  process.env.AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED = 'true';
  facts.current = {
    // What the live model returned: a computed balance after every line.
    transactions: [
      { transactionDate: '2026-08-03', descriptionRaw: 'Salary', amount: '1850.00', creditDebit: 'credit', balanceAfter: '3850.00' },
      { transactionDate: '2026-08-07', descriptionRaw: 'Rent', amount: '950.00', creditDebit: 'debit', balanceAfter: '2900.00' },
      { transactionDate: '2026-08-12', descriptionRaw: 'Grocer', amount: '123.45', creditDebit: 'debit', balanceAfter: '2776.55' },
    ],
    allTransactionsListed: true,
    documentMissingReasonCode: null,
    institutionName: v('Harbourline Mutual Bank'),
    maskedAccountIdentifier: v(null),
    statementPeriodStart: v('2026-08-01'),
    statementPeriodEnd: v('2026-08-31'),
    declaredOpeningBalance: v('2000.00'),
    declaredClosingBalance: v('2800.00'),
  };
});

describe('figureIsPrinted', () => {
  it('finds plain, grouped and whole-number spellings, and refuses a fragment of a longer number', async () => {
    const { figureIsPrinted } = await import('@/lib/aie/adapters/shared/reviewDraft');
    expect(figureIsPrinted(2000, 'began with 2000.00 in')).toBe(true);
    expect(figureIsPrinted(1850, 'paid in 1,850.00 as')).toBe(true);
    expect(figureIsPrinted(1850, 'Amount,1850')).toBe(true);
    expect(figureIsPrinted(850, 'paid in 1,850.00 as')).toBe(false);
    expect(figureIsPrinted(2000, 'total 12000.00')).toBe(false);
    expect(figureIsPrinted(3850, LETTER)).toBe(false);
  });
});

describe('bank AI draft keeps only printed figures', () => {
  it('drops the running balances the model computed (not printed), keeps the printed opening/closing, and says so in the warnings', async () => {
    const { attemptAiBankStatementFallback } = await import('@/lib/financial-data-hub/services/bankPdfProcessingService');
    const out = await attemptAiBankStatementFallback('u', 'doc', LETTER);
    expect(out.ok).toBe(true);
    const draft = (out as unknown as { draft: { rows: Array<{ balanceAfter: number | null }>; declaredOpeningBalance: number; declaredClosingBalance: number; warnings: string[] } }).draft;
    expect(draft.rows.map((r) => r.balanceAfter)).toEqual([null, null, null]);
    expect(draft.declaredOpeningBalance).toBe(2000);
    expect(draft.declaredClosingBalance).toBe(2800);
    expect(draft.warnings).toContain('ai_row_1_balance_not_printed_dropped');
  });
});

describe('a read statement with no per-line balance is reconciled opening -> closing', () => {
  const base = {
    statementUploadId: 'doc', financialAccountId: 'acct', currencyCode: 'AUD',
    dedupIndex: new Map(),
    rows: [
      { sourceRowNumber: 1, transactionDate: '2026-08-03', descriptionRaw: 'Salary', amountOriginal: 1850, creditDebit: 'credit' as const, balanceAfter: null },
      { sourceRowNumber: 2, transactionDate: '2026-08-07', descriptionRaw: 'Rent', amountOriginal: 950, creditDebit: 'debit' as const, balanceAfter: null },
      { sourceRowNumber: 3, transactionDate: '2026-08-12', descriptionRaw: 'Grocer', amountOriginal: 123.45, creditDebit: 'debit' as const, balanceAfter: null },
    ],
    pageCount: 1, parserVersion: 'test',
  };

  it('printed closing 2800.00 vs 2000.00 + 1850.00 - 950.00 - 123.45 = 2776.55: FAILED, the 23.45 variance and the printed figure are kept', async () => {
    const { runBankPdfPipelineFromReadRows } = await import('@/lib/financial-data-hub/bank-pdf/orchestrator');
    const p = runBankPdfPipelineFromReadRows({ ...base, statementMetadata: { declaredOpeningBalance: 2000, declaredClosingBalance: 2800, maskedAccountIdentifier: null, statementPeriodStart: '2026-08-01', statementPeriodEnd: '2026-08-31' } });
    expect(p.reconciliation?.status).toBe('failed');
    expect(p.reconciliation?.method).toBe('balance_rollforward');
    expect(p.reconciliation?.expectedClosingBalance).toBe(2776.55);
    expect(p.reconciliation?.reportedClosingBalance).toBe(2800);
    expect(Math.abs(p.reconciliation?.variance ?? 0)).toBe(23.45);
  });

  it('printed closing 2776.55: RECONCILED on the declared balances', async () => {
    const { runBankPdfPipelineFromReadRows } = await import('@/lib/financial-data-hub/bank-pdf/orchestrator');
    const p = runBankPdfPipelineFromReadRows({ ...base, statementMetadata: { declaredOpeningBalance: 2000, declaredClosingBalance: 2776.55, maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null } });
    expect(p.reconciliation?.status).toBe('reconciled');
    expect(p.reconciliation?.variance).toBe(0);
  });

  it('PARTIAL per-line balances (seen live: one computed balance coincided with the printed closing and survived) do not decide; the printed opening/closing do', async () => {
    const { runBankPdfPipelineFromReadRows } = await import('@/lib/financial-data-hub/bank-pdf/orchestrator');
    const rows = base.rows.map((r, i) => (i === 2 ? { ...r, balanceAfter: 2776.55 } : r));
    const p = runBankPdfPipelineFromReadRows({ ...base, rows, statementMetadata: { declaredOpeningBalance: 2000, declaredClosingBalance: 2776.55, maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null } });
    expect(p.reconciliation?.status).toBe('reconciled');
    expect(p.reconciliation?.variance).toBe(0);
  });

  it('no declared closing: still not_available (nothing is assumed)', async () => {
    const { runBankPdfPipelineFromReadRows } = await import('@/lib/financial-data-hub/bank-pdf/orchestrator');
    const p = runBankPdfPipelineFromReadRows({ ...base, statementMetadata: { declaredOpeningBalance: 2000, declaredClosingBalance: null, maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null } });
    expect(p.reconciliation?.status).toBe('not_available');
  });
});
