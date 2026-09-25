// AIE statement adapters -- a model that copies masking tokens into the
// partial account identifier must not sink the whole extraction
// (2026-09-25, other-PDF AI proof). Written to FAIL on origin/main 8b6692c.
//
// Found LIVE on DEV: 2 of 5 real gpt-4o-mini reads of the synthetic bank
// letter were schema_rejected -- billed, and unusable -- with the single
// error `maskedAccountIdentifier.value:too_big`: the model had copied the
// masking tokens (about 56 characters each) into a field capped at 64 (40 for
// liability). The value is discarded before review anyway (a token, or
// anything over 40 characters, never reaches the draft), so the read-side cap
// now admits it and the draft-side sanitiser drops it.
import { describe, it, expect } from 'vitest';
import { bankStatementDocumentFactsSchema } from '@/lib/aie/adapters/bankStatement/schema';
import { liabilityStatementDocumentFactsSchema } from '@/lib/aie/adapters/liability/schema';
import { retirementDocumentFactsSchema } from '@/lib/aie/adapters/retirement/schema';
import { reviewableMaskedIdentifier } from '@/lib/aie/adapters/shared/reviewDraft';

const TOKENS = '062-000 [MASKED:account_reference:hmac:abcdefghijklmnopabcdefghij] [MASKED:tax_id:hmac:abcdefghijklmnop]';
const v = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present_on_document' : null });

describe('AI identifier read limit', () => {
  it('bank: a token-bearing identifier no longer rejects the whole extraction', () => {
    const facts = {
      schemaVersion: '1', documentMissingReasonCode: null, institutionName: v('Synthetic Bank'), maskedAccountIdentifier: v(TOKENS),
      statementPeriodStart: v('2026-08-01'), statementPeriodEnd: v('2026-08-31'), declaredOpeningBalance: v('2000.00'), declaredClosingBalance: v('2776.55'),
      allTransactionsListed: true,
      transactions: [{ transactionDate: '2026-08-03', descriptionRaw: 'Salary', amount: '1850.00', creditDebit: 'credit', balanceAfter: null }],
    };
    const r = bankStatementDocumentFactsSchema.safeParse(facts);
    expect(r.success ? 'ok' : r.error.issues.map((i) => `${i.path.join('.')}:${i.code}`).join(',')).toBe('ok');
  });

  it('liability and retirement: the same', () => {
    const l = liabilityStatementDocumentFactsSchema.shape.maskedIdentifier.safeParse(v(TOKENS));
    const r = retirementDocumentFactsSchema.shape.maskedAccountIdentifier.safeParse(v(TOKENS));
    expect(l.success).toBe(true);
    expect(r.success).toBe(true);
  });

  it('the token never reaches a draft: the review-side sanitiser drops it', () => {
    expect(reviewableMaskedIdentifier(TOKENS)).toBeNull();
    expect(reviewableMaskedIdentifier('xx5678')).toBe('xx5678');
  });
});
