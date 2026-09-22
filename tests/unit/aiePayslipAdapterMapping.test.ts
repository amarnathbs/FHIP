/**
 * AIE payslip AI-fallback adapter — schema + mapping unit tests. Pure,
 * no network/DB — mirrors the AIE core's own convention of unit-testing the
 * schema/mapping layer independently of any live provider (see
 * `tests/unit/aieInsuranceAdapterParser.test.ts` for the equivalent
 * insurance-adapter precedent).
 */
import { describe, it, expect } from 'vitest';
import { payslipDocumentFactsSchema, type PayslipDocumentFacts } from '@/lib/aie/adapters/payslip/schema';
import { mapPayslipFactsToExtraction } from '@/lib/aie/adapters/payslip/mapping';

function emptyField() {
  return { value: null, missingReasonCode: 'not_present_on_document' as const };
}

function moneyField(value: string) {
  return { value, missingReasonCode: null };
}

function baseFacts(overrides: Partial<PayslipDocumentFacts> = {}): PayslipDocumentFacts {
  return {
    schemaVersion: '1',
    documentMissingReasonCode: null,
    employerName: emptyField(),
    payPeriodStart: emptyField(),
    payPeriodEnd: emptyField(),
    paymentDate: emptyField(),
    payFrequency: { value: null, missingReasonCode: 'not_present_on_document' },
    grossPay: emptyField(),
    basePay: emptyField(),
    overtimePay: emptyField(),
    bonusPay: emptyField(),
    commissionPay: emptyField(),
    allowancesTotal: emptyField(),
    reimbursementsTotal: emptyField(),
    otherEarnings: emptyField(),
    taxWithheld: emptyField(),
    employeeDeductionsTotal: emptyField(),
    salarySacrifice: emptyField(),
    professionalTax: emptyField(),
    employerRetirementContribution: emptyField(),
    employeeRetirementContribution: emptyField(),
    employerNpsContribution: emptyField(),
    employeeNpsContribution: emptyField(),
    netPay: emptyField(),
    ...overrides,
  };
}

describe('payslipDocumentFactsSchema', () => {
  it('accepts a fully-empty (nothing readable) document', () => {
    const result = payslipDocumentFactsSchema.safeParse(baseFacts({ documentMissingReasonCode: 'illegible' }));
    expect(result.success).toBe(true);
  });

  it('accepts a populated money field with value + null reason', () => {
    const result = payslipDocumentFactsSchema.safeParse(baseFacts({ grossPay: moneyField('1234.56') }));
    expect(result.success).toBe(true);
  });

  it('REJECTS a money field carrying both a value and a missingReasonCode', () => {
    const result = payslipDocumentFactsSchema.safeParse(baseFacts({ grossPay: { value: '100.00', missingReasonCode: 'illegible' } }));
    expect(result.success).toBe(false);
  });

  it('REJECTS a money field with neither a value nor a missingReasonCode', () => {
    const result = payslipDocumentFactsSchema.safeParse(baseFacts({ grossPay: { value: null, missingReasonCode: null } }));
    expect(result.success).toBe(false);
  });

  it('REJECTS an unknown top-level property (.strict())', () => {
    const withExtra = { ...baseFacts(), unexpectedField: 'x' };
    const result = payslipDocumentFactsSchema.safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  it('REJECTS a non-decimal-string money value (e.g. scientific notation or a bare float artifact)', () => {
    const result = payslipDocumentFactsSchema.safeParse(baseFacts({ grossPay: { value: '1.2e3', missingReasonCode: null } }));
    expect(result.success).toBe(false);
  });

  it('REJECTS an unrecognised payFrequency enum value', () => {
    const facts = baseFacts();
    const result = payslipDocumentFactsSchema.safeParse({ ...facts, payFrequency: { value: 'biannual', missingReasonCode: null } });
    expect(result.success).toBe(false);
  });
});

describe('mapPayslipFactsToExtraction', () => {
  it('returns null when neither grossPay nor netPay was extracted (not usable evidence)', () => {
    const facts = baseFacts({ employerName: { value: 'Acme Pty Ltd', missingReasonCode: null } });
    expect(mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' })).toBeNull();
  });

  it('builds a PayrollExtraction when grossPay is present, even with netPay absent', () => {
    const facts = baseFacts({ grossPay: moneyField('2000.00') });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' });
    expect(extraction).not.toBeNull();
    expect(extraction!.grossPay).toBe(2000);
    expect(extraction!.netPay).toBeUndefined();
  });

  it('builds a PayrollExtraction when only netPay is present', () => {
    const facts = baseFacts({ netPay: moneyField('1500.50') });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'IN', currencyCode: 'INR' });
    expect(extraction).not.toBeNull();
    expect(extraction!.netPay).toBe(1500.5);
    expect(extraction!.country).toBe('IN');
    expect(extraction!.currencyCode).toBe('INR');
  });

  it('never invents country/currency — always exactly what the caller supplied, never derived from facts', () => {
    const facts = baseFacts({ grossPay: moneyField('100.00') });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' })!;
    expect(extraction.country).toBe('AU');
    expect(extraction.currencyCode).toBe('AUD');
  });

  it('never populates YTD fields — deliberately out of scope for this adapter', () => {
    const facts = baseFacts({ grossPay: moneyField('100.00') });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' })!;
    expect(extraction.ytdGross).toBeUndefined();
    expect(extraction.ytdTax).toBeUndefined();
    expect(extraction.ytdNet).toBeUndefined();
  });

  it('produces zero line-level components — reconciliation always falls back to header_totals for an AI-fallback extraction', () => {
    const facts = baseFacts({ grossPay: moneyField('100.00') });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' })!;
    expect(extraction.components).toEqual([]);
  });

  it('maps payFrequency "unknown" when the AI could not read one, never invents a guess', () => {
    const facts = baseFacts({ grossPay: moneyField('100.00') });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' })!;
    expect(extraction.payFrequency).toBe('unknown');
  });

  it('carries the documentMissingReasonCode into warnings when the AI declared one', () => {
    const facts = baseFacts({ grossPay: moneyField('100.00'), documentMissingReasonCode: 'ambiguous' });
    const extraction = mapPayslipFactsToExtraction(facts, { country: 'AU', currencyCode: 'AUD' })!;
    expect(extraction.warnings).toContain('document_missing_reason:ambiguous');
  });
});
