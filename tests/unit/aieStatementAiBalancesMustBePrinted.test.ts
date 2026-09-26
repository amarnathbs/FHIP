// AIE liability / retirement AI fallback -- the opening and closing balances
// that anchor each statement's reconciliation must be PRINTED on the document
// (2026-09-25, other-PDF AI proof). Written to FAIL on origin/main 8b6692c.
// Same rule as the bank adapter, where real gpt-4o-mini was seen live
// computing balances the page did not print.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { facts, audit } = vi.hoisted(() => ({ facts: { current: null as unknown }, audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/aie/pilotCohortEmail', () => ({ resolveEmailForAiePilotCohort: vi.fn().mockResolvedValue('p@fhip-test.invalid') }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: audit }));
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({
  saveAiFallbackDraft: vi.fn().mockResolvedValue({ persisted: true, draftId: 'd' }),
  claimPendingAiFallbackDraft: vi.fn(), releaseClaimedAiFallbackDraft: vi.fn(), releaseClaimedAiFallbackDraftIfNothingWritten: vi.fn(async () => ({ released: true })),
  loadPendingAiFallbackDraft: vi.fn(), documentsWithPendingAiFallbackDrafts: vi.fn(),
}));
vi.mock('@/lib/aie/adapters/liability/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestLiabilityAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current })),
}));
vi.mock('@/lib/aie/adapters/retirement/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestRetirementAiExtraction: vi.fn(async () => ({ outcome: 'success', facts: facts.current })),
}));

vi.setConfig({ testTimeout: 60000 });
const v = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present_on_document' : null });

beforeEach(() => {
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_PILOT_COHORT_ENFORCED = 'false';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'f6'.repeat(32);
  process.env.AIE_LIABILITY_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED = 'true';
  audit.mockClear();
});

describe('liability', () => {
  it('a closing balance the page does not print is dropped (the printed opening is kept)', async () => {
    const TEXT = 'Card letter. You owed 500.00 at the start. On 5 July 2026 you spent 85.40. On 15 July 2026 you paid 200.00.';
    facts.current = {
      activities: [
        { activityType: 'PURCHASE', activityDate: '2026-07-05', amount: '85.40', descriptionRaw: null, merchantRaw: null, principalComponent: null, interestComponent: null, feeComponent: null },
        { activityType: 'PAYMENT', activityDate: '2026-07-15', amount: '200.00', descriptionRaw: null, merchantRaw: null, principalComponent: null, interestComponent: null, feeComponent: null },
      ],
      allActivitiesListed: true, documentMissingReasonCode: null,
      institutionName: v('Synthetic Card Co'), maskedIdentifier: v(null), statementPeriodStart: v(null), statementPeriodEnd: v(null),
      statementDate: v(null), dueDate: v(null), openingBalance: v('500.00'),
      closingBalance: v('385.40'), // computed by the model: 500.00 + 85.40 - 200.00; never printed
      creditLimit: v(null), minimumPayment: v(null), interestRate: v(null),
    };
    const { attemptAiLiabilityFallback } = await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService');
    const out = await attemptAiLiabilityFallback('u', 'doc', TEXT);
    expect(out.ok).toBe(true);
    const draft = (out as unknown as { draft: { header: { openingBalance?: number; closingBalance?: number }; warnings: string[] } }).draft;
    expect(draft.header.openingBalance).toBe(500);
    expect(draft.header.closingBalance).toBeUndefined();
    expect(draft.warnings).toContain('ai_closing_balance_not_printed_dropped');
  });
});

describe('retirement', () => {
  it('a closing balance the page does not print is dropped and recorded on the draft-ready audit event', async () => {
    const TEXT = 'Member letter. Balance on 1 July 2026 was 10000.00. Employer paid 500.00. You paid 200.00. Fee 12.50.';
    facts.current = {
      activities: [
        { activityType: 'EMPLOYER_CONTRIBUTION', amount: '500.00', activityDate: '2026-07-01', descriptionRaw: null, employerNameRaw: null, isSummaryTotal: false, isYearToDate: false },
      ],
      positions: [], documentMissingReasonCode: null,
      fundName: v('Imaginary Super Fund'), maskedAccountIdentifier: v(null), statementDate: v(null), statementStartDate: v(null), statementEndDate: v(null),
      openingBalance: v('10000.00'),
      closingBalance: v('10687.50'), // computed; never printed
      employerContributions: v(null), personalContributions: v(null), salarySacrifice: v(null), governmentContributions: v(null),
      rolloversIn: v(null), rolloversOut: v(null), withdrawals: v(null), pensionPayments: v(null), investmentEarnings: v(null),
      fees: v(null), insurancePremiums: v(null), tax: v(null),
    };
    const { attemptAiRetirementFallback } = await import('@/lib/financial-data-hub/services/retirementStatementProcessingService');
    const out = await attemptAiRetirementFallback('u', 'doc', new TextEncoder().encode(TEXT), { jurisdiction: 'AU', currencyCode: 'AUD', statementType: 'retirement_statement_csv', accountType: 'unknown' });
    expect(out.ok).toBe(true);
    const draft = (out as unknown as { extraction: { openingBalance?: string; closingBalance?: string } }).extraction;
    expect(draft.openingBalance).toBe('10000.00');
    expect(draft.closingBalance).toBeUndefined();
    const ready = audit.mock.calls.map((c) => c[0]).find((e) => e.eventType === 'retirement_statement_ai_fallback_draft_ready');
    expect(ready?.metadata?.dropped_unprinted_figures).toEqual(['closingBalance']);
  });
});
