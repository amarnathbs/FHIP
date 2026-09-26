// AIE statement AI fallback -- the draft a service issues must be ACCEPTED by
// its own confirm route when the review panel posts it back exactly as the
// panel does (2026-09-25, other-PDF AI proof). Written to FAIL on
// origin/main 8b6692c for bank, liability and retirement.
//
// This is release-register defect F-9 (payslip) repeated in three more
// document types: every confirm route validates with a `.strict()` schema,
// every panel posts the draft's rows back verbatim, and the drafts carried
// internal keys (`sourceRowNumber`; for retirement also parserName,
// parserVersion, extractionConfidence, warnings, the YTD keys and per-row
// currencyCode). So the real UI could never confirm an AI draft: 422 every
// time.
//
// Each case drives the REAL `attemptAi*Fallback` (the provider is replaced by
// synthetic facts), then posts the panel's body to the REAL route handler.
// Only the service's write (`confirmAi*Fallback`) is stubbed, to observe what
// the route passed on.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { confirmMocks, facts } = vi.hoisted(() => ({
  confirmMocks: {
    bank: vi.fn(),
    liability: vi.fn(),
    retirement: vi.fn(),
    investment: vi.fn(),
  },
  facts: { current: null as unknown },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, requireCountryConfirmedUser: vi.fn().mockResolvedValue({ user: { id: 'user-rt', email: 'rt@fhip-test.invalid' } }) };
});
vi.mock('@/lib/financial-data-hub/constants/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFdhDocumentUploadEnabled: () => true,
}));
vi.mock('@/lib/aie/pilotCohortEmail', () => ({ resolveEmailForAiePilotCohort: vi.fn().mockResolvedValue('rt@fhip-test.invalid') }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  saveAiFallbackDraft: vi.fn().mockResolvedValue({ persisted: true, draftId: 'draft-1' }),
  claimPendingAiFallbackDraft: vi.fn().mockResolvedValue({ claimed: true, draftId: 'draft-1', payload: {} }),
  releaseClaimedAiFallbackDraft: vi.fn(), releaseClaimedAiFallbackDraftIfNothingWritten: vi.fn(async () => ({ released: true })),
  loadPendingAiFallbackDraft: vi.fn().mockResolvedValue({ found: false, reason: 'none_pending' }),
  documentsWithPendingAiFallbackDrafts: vi.fn().mockResolvedValue(new Set()),
}));

const evidence = { idempotencyKey: 'k', providerRequestIds: ['req_rt'], inputTokens: 10, outputTokens: 10, model: 'gpt-4o-mini' };
vi.mock('@/lib/aie/adapters/bankStatement/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestBankStatementAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current, evidence })),
}));
vi.mock('@/lib/aie/adapters/liability/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestLiabilityAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current, evidence })),
}));
vi.mock('@/lib/aie/adapters/retirement/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestRetirementAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current, evidence })),
}));
vi.mock('@/lib/aie/adapters/auInvestment/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestAuInvestmentAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current, evidence })),
}));

vi.mock('@/lib/financial-data-hub/services/bankPdfProcessingService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmAiBankStatementFallback: confirmMocks.bank,
}));
vi.mock('@/lib/financial-data-hub/services/liabilityStatementProcessingService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmAiLiabilityFallback: confirmMocks.liability,
}));
vi.mock('@/lib/financial-data-hub/services/retirementStatementProcessingService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmAiRetirementFallback: confirmMocks.retirement,
}));
vi.mock('@/lib/financial-data-hub/services/investmentStatementProcessingService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmAiAuInvestmentFallback: confirmMocks.investment,
}));

const v = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present' : null });

// The first import pulls in the PDF text-extraction chain.
vi.setConfig({ testTimeout: 60000 });

beforeEach(() => {
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_PILOT_COHORT_ENFORCED = 'false';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'c3'.repeat(32);
  process.env.AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_LIABILITY_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED = 'true';
  for (const m of Object.values(confirmMocks)) m.mockReset();
});

const SYNTHETIC_TEXT = 'Synthetic statement for the round-trip test. Nothing here is real, and it is long enough to pass the gate.';

function post(body: unknown): Request {
  return new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const params = { params: Promise.resolve({ documentId: 'doc-rt' }) };

describe('AI draft -> panel body -> confirm route', () => {
  it('bank statement: the panel body built from the draft is accepted (not 422)', async () => {
    facts.current = {
      transactions: [
        { transactionDate: '2026-08-01', descriptionRaw: 'SYNTHETIC GROCER', amount: '45.20', creditDebit: 'debit', balanceAfter: '954.80' },
        { transactionDate: '2026-08-03', descriptionRaw: 'SYNTHETIC SALARY', amount: '500.00', creditDebit: 'credit', balanceAfter: '1454.80' },
      ],
      allTransactionsListed: true,
      documentMissingReasonCode: null,
      institutionName: v('Synthetic Bank'),
      maskedAccountIdentifier: v('xx5678'),
      statementPeriodStart: v('2026-08-01'),
      statementPeriodEnd: v('2026-08-31'),
      declaredOpeningBalance: v('1000.00'),
      declaredClosingBalance: v('1454.80'),
    };
    const svc = await import('@/lib/financial-data-hub/services/bankPdfProcessingService');
    const out = await svc.attemptAiBankStatementFallback('user-rt', 'doc-rt', SYNTHETIC_TEXT);
    expect(out.ok).toBe(true);
    const draft = (out as unknown as { draft: Record<string, unknown> & { rows: unknown[] } }).draft;
    confirmMocks.bank.mockResolvedValue({ document: { id: 'doc-rt', processing_status: 'approved' }, pipelineStatus: 'ok', certificationStatus: 'certified', reconciliationStatus: 'reconciled', transactionsCreated: 2, duplicatesSkipped: 0, duplicateCandidates: 0 });
    const { POST } = await import('@/app/api/financial-data-hub/bank-pdf/[documentId]/ai-fallback/confirm/route');
    // Exactly BankStatementImportPanel.handleConfirmAiDraft's body.
    const res = await POST(post({
      rows: draft.rows,
      statementPeriodStart: draft.statementPeriodStart,
      statementPeriodEnd: draft.statementPeriodEnd,
      declaredOpeningBalance: draft.declaredOpeningBalance,
      declaredClosingBalance: draft.declaredClosingBalance,
      maskedAccountIdentifier: draft.maskedAccountIdentifier,
    }), params);
    expect(res.status).toBe(200);
    expect(confirmMocks.bank).toHaveBeenCalledTimes(1);
    expect(confirmMocks.bank.mock.calls[0][2].rows).toHaveLength(2);
  });

  it('liability statement: the panel body built from the draft is accepted (not 422)', async () => {
    facts.current = {
      activities: [
        { activityType: 'PURCHASE', activityDate: '2026-07-05', amount: '85.40', descriptionRaw: 'SYNTHETIC STORE', merchantRaw: null, principalComponent: null, interestComponent: null, feeComponent: null },
        { activityType: 'PAYMENT', activityDate: '2026-07-15', amount: '200.00', descriptionRaw: 'SYNTHETIC PAYMENT', merchantRaw: null, principalComponent: null, interestComponent: null, feeComponent: null },
      ],
      allActivitiesListed: true,
      documentMissingReasonCode: null,
      institutionName: v('Synthetic Card Co'),
      maskedIdentifier: v('xx4321'),
      statementPeriodStart: v('2026-07-01'),
      statementPeriodEnd: v('2026-07-31'),
      statementDate: v('2026-07-31'),
      dueDate: v('2026-08-20'),
      openingBalance: v('500.00'),
      closingBalance: v('385.40'),
      creditLimit: v('5000.00'),
      minimumPayment: v('25.00'),
      interestRate: v(null),
    };
    const svc = await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService');
    const out = await svc.attemptAiLiabilityFallback('user-rt', 'doc-rt', SYNTHETIC_TEXT);
    expect(out.ok).toBe(true);
    const draft = (out as { draft: { activities: unknown[]; warnings: string[] } }).draft;
    confirmMocks.liability.mockResolvedValue({ document: { id: 'doc-rt', processing_status: 'extracted' }, pipelineStatus: 'ok', statementId: 's-1' });
    const { POST } = await import('@/app/api/financial-data-hub/liability-statement/[documentId]/ai-fallback/confirm/route');
    // LiabilityImportPanel.handleConfirmAiDraft's body (header figures the user left blank).
    const res = await POST(post({
      metadata: { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'xx4321' },
      facilityType: 'credit_card',
      activities: draft.activities,
      aiWarnings: draft.warnings,
    }), params);
    expect(res.status).toBe(200);
    expect(confirmMocks.liability).toHaveBeenCalledTimes(1);
  });

  it('retirement statement: the draft posted back VERBATIM (as the panel does) is accepted (not 422)', async () => {
    facts.current = {
      activities: [
        { activityType: 'EMPLOYER_CONTRIBUTION', amount: '500.00', activityDate: '2026-07-01', descriptionRaw: 'SYNTHETIC SG', employerNameRaw: 'Synthetic Employer', isSummaryTotal: false, isYearToDate: false },
        { activityType: 'PERSONAL_CONTRIBUTION', amount: '200.00', activityDate: '2026-07-15', descriptionRaw: 'SYNTHETIC PERSONAL', employerNameRaw: null, isSummaryTotal: false, isYearToDate: false },
      ],
      positions: [],
      documentMissingReasonCode: null,
      fundName: v('Synthetic Super Fund'),
      maskedAccountIdentifier: v('xx9911'),
      statementDate: v('2026-07-31'),
      statementStartDate: v('2026-07-01'),
      statementEndDate: v('2026-07-31'),
      openingBalance: v('10000.00'),
      closingBalance: v('10700.00'),
      employerContributions: v('500.00'), personalContributions: v('200.00'), salarySacrifice: v(null),
      governmentContributions: v(null), rolloversIn: v(null), rolloversOut: v(null), withdrawals: v(null),
      pensionPayments: v(null), investmentEarnings: v(null), fees: v(null), insurancePremiums: v(null), tax: v(null),
    };
    const svc = await import('@/lib/financial-data-hub/services/retirementStatementProcessingService');
    const out = await svc.attemptAiRetirementFallback('user-rt', 'doc-rt', new TextEncoder().encode(`${SYNTHETIC_TEXT} Opening balance 10000.00, closing balance 10700.00.`), { jurisdiction: 'AU', currencyCode: 'AUD', statementType: 'retirement_statement_csv', accountType: 'unknown' });
    expect(out.ok).toBe(true);
    const draft = (out as { extraction: unknown }).extraction;
    confirmMocks.retirement.mockResolvedValue({ document: { id: 'doc-rt' }, statementId: 's-1', pipelineStatus: 'ok', activitiesExtracted: 2, activitiesDeduplicated: 0, positionsExtracted: 0 });
    const { POST } = await import('@/app/api/financial-data-hub/retirement-statement/[documentId]/ai-fallback/confirm/route');
    const res = await POST(post(JSON.parse(JSON.stringify(draft))), params);
    expect(res.status).toBe(200);
    expect(confirmMocks.retirement).toHaveBeenCalledTimes(1);
    expect(confirmMocks.retirement.mock.calls[0][2].closingBalance).toBe('10700.00');
  });

  it('AU investment statement: the panel body built from the draft is accepted', async () => {
    facts.current = {
      holdings: [],
      transactions: [
        { transactionType: 'BUY', tradeDate: '2026-07-02', settlementDate: '2026-07-04', securityNameRaw: 'SYNTHETIC LTD', tickerRaw: 'SYN', quantity: '50', unitPrice: '40.00', amount: '2000.00', brokerage: null },
      ],
      allRowsListed: true,
      documentMissingReasonCode: null,
      institutionName: v('Synthetic Broker'),
      statementDate: v('2026-07-31'),
      statementPeriodStart: v('2026-07-01'),
      statementPeriodEnd: v('2026-07-31'),
    };
    const svc = await import('@/lib/financial-data-hub/services/investmentStatementProcessingService');
    const out = await svc.attemptAiAuInvestmentFallback('user-rt', 'doc-rt', SYNTHETIC_TEXT, { statementType: 'broker_transaction_csv' as never, currencyCode: 'AUD', fallbackValuationDate: '2026-07-31' } as never);
    expect(out.ok).toBe(true);
    const draft = (out as unknown as { draft: Record<string, unknown> }).draft;
    confirmMocks.investment.mockResolvedValue({ document: { id: 'doc-rt', processing_status: 'queued' }, statementId: 's-1', pipelineStatus: 'ok', positionsExtracted: 0, activitiesExtracted: 1 });
    const { POST } = await import('@/app/api/financial-data-hub/investment-statement/[documentId]/ai-fallback/confirm/route');
    const res = await POST(post({
      csv_kind: 'transaction',
      holdings: draft.holdings,
      activities: draft.activities,
      institutionName: 'Synthetic Broker',
      maskedAccountIdentifier: null,
      statementDate: draft.statementDate,
      statementPeriodStart: draft.statementPeriodStart,
      statementPeriodEnd: draft.statementPeriodEnd,
    }), params);
    expect(res.status).toBe(200);
    expect(confirmMocks.investment).toHaveBeenCalledTimes(1);
  });
});
