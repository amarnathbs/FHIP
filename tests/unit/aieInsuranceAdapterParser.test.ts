/**
 * AIE-1.4 — Insurance adapter: deterministic classifier/parser tests
 * (positive/boundary/negative/adversarial fixtures per AIE14-ENTRY-01's own
 * "Required verification" clause).
 */
import { describe, it, expect } from 'vitest';
import { sniffInsuranceDocument, parseInsuranceDocument } from '@/lib/aie/adapters/insurance/parser';
import { buildAieInsuranceFixtureText, buildAieInsurancePdsFixtureText, buildAieUnrelatedFixtureText } from '../support/buildAieInsuranceFixtureText';

function candidate(candidates: ReturnType<typeof parseInsuranceDocument>['candidates'], fieldName: string) {
  return candidates.find((c) => c.fieldName === fieldName);
}

describe('AIE-1.4 Insurance adapter — sniff()', () => {
  it('claims a clean policy schedule (>=2 strong signals)', () => {
    expect(sniffInsuranceDocument(buildAieInsuranceFixtureText())).toBe(true);
  });

  it('does NOT claim an unrelated document (bank statement) — REG-02', () => {
    expect(sniffInsuranceDocument(buildAieUnrelatedFixtureText())).toBe(false);
  });

  it('does NOT claim text with only one weak/no strong signal', () => {
    expect(sniffInsuranceDocument('This document mentions cover once.')).toBe(false);
  });
});

describe('AIE-1.4 Insurance adapter — parseInsuranceDocument() positive path', () => {
  it('extracts all canonical fields from a clean policy schedule and reports outcome=complete', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText());
    expect(result.outcome).toBe('complete');
    expect(result.documentClass).toBe('policy_schedule');
    expect(candidate(result.candidates, 'policyName')?.valueRaw).toBe('Acme SecureLife Term Cover');
    expect(candidate(result.candidates, 'coverType')?.valueRaw).toBe('life');
    expect(candidate(result.candidates, 'coverAmount')?.valueRaw).toBe('500000');
    expect(candidate(result.candidates, 'premium')?.valueRaw).toBe('100');
    expect(candidate(result.candidates, 'premiumFrequency')?.valueRaw).toBe('monthly');
    expect(candidate(result.candidates, 'currencyCode')?.valueRaw).toBe('AUD');
    expect(candidate(result.candidates, 'renewalDate')?.valueRaw).toBe('2026-01-01');
    expect(candidate(result.candidates, 'waitingPeriodDays')?.valueRaw).toBe('90');
    expect(candidate(result.candidates, 'benefitPeriod')?.valueRaw).toBe('2 years');
    expect(candidate(result.candidates, 'provider')?.valueRaw).toBe('Acme Life Insurance Ltd');
    expect(result.aiEligibleGaps).toEqual([]);
  });

  it('classifies renewal_notice and premium_notice headers distinctly', () => {
    const renewal = parseInsuranceDocument(buildAieInsuranceFixtureText({ header: 'RENEWAL NOTICE' }));
    expect(renewal.documentClass).toBe('renewal_notice');
    const premiumNotice = parseInsuranceDocument(buildAieInsuranceFixtureText({ header: 'PREMIUM NOTICE' }));
    expect(premiumNotice.documentClass).toBe('premium_notice');
  });

  it('NEVER stores the raw policy number — only a masked candidate (AIE14-INS-02)', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText({ policyNumber: '1234567890123456' }));
    const masked = candidate(result.candidates, 'policyNumberMasked')?.valueRaw;
    expect(masked).toBeDefined();
    expect(masked).not.toContain('123456789012'); // majority redacted
    expect(masked).toMatch(/\*+3456$/); // last 4 visible
    // No candidate anywhere carries the raw 16-digit run.
    expect(result.candidates.some((c) => c.valueRaw === '1234567890123456')).toBe(false);
  });

  it('captures owner/insured/beneficiary NAMES as evidence-only candidates, never as the canonical `owner` field', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText());
    expect(candidate(result.candidates, 'policyOwnerName')?.valueRaw).toBe('John Smith');
    expect(candidate(result.candidates, 'insuredPersonName')?.valueRaw).toBe('John Smith');
    expect(candidate(result.candidates, 'beneficiaryName')?.valueRaw).toBe('Jane Smith');
    // 'owner' (the household-role canonical field) is never produced by the
    // parser at all — see write.ts's header on why.
    expect(candidate(result.candidates, 'owner')).toBeUndefined();
  });

  it('captures exclusions as raw evidence-only text, never interpreted', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText());
    expect(candidate(result.candidates, 'exclusionsText')?.valueRaw).toBe('Pre-existing conditions; Self-inflicted injury');
  });
});

describe('AIE-1.4 Insurance adapter — boundary/negative cases', () => {
  it('flags a missing policy name as outcome=partial, declaring the ONE narrative AI gap this adapter allows', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText({ omitFields: ['productName'] }));
    expect(result.outcome).toBe('partial');
    expect(result.aiEligibleGaps).toEqual(['policyNameClarification']);
  });

  it('never declares an AI-eligible gap for currency, cover amount, premium or frequency (P1/AIE14 prohibitions)', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText({ omitFields: ['currency', 'coverAmount', 'premium', 'premiumFrequency'] }));
    expect(result.outcome).toBe('partial');
    expect(result.aiEligibleGaps).toEqual([]);
  });

  it('flags multiComponentPolicyDetected when more than one Sum Insured/Premium line is present (AIE14-INS-08)', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText({ includeSecondComponent: true }));
    expect(candidate(result.candidates, 'multiComponentPolicyDetected')?.valueRaw).toBe('true');
  });

  it('does NOT flag multiComponentPolicyDetected for a single-component policy', () => {
    const result = parseInsuranceDocument(buildAieInsuranceFixtureText());
    expect(candidate(result.candidates, 'multiComponentPolicyDetected')?.valueRaw).toBe('false');
  });

  it('never guesses an unrecognised label into a bucket — an unrecognised line is simply absent from candidates', () => {
    const text = buildAieInsuranceFixtureText() + '\nSome Totally Unknown Field: 42\n';
    const result = parseInsuranceDocument(text);
    expect(result.candidates.some((c) => c.valueRaw === '42')).toBe(false);
  });
});

describe('AIE-1.4 Insurance adapter — adversarial: out-of-scope document sub-classes fail safely', () => {
  it('detects a Product Disclosure Statement and refuses to parse it as a policy schedule (AIE14-INS-01/ELIG-06/ELIG-07)', () => {
    const result = parseInsuranceDocument(buildAieInsurancePdsFixtureText());
    expect(result.outcome).toBe('failed');
    expect(result.documentClass).toBe('product_disclosure_statement');
    expect(result.failureReason).toContain('product_disclosure_statement');
    expect(result.candidates).toHaveLength(1); // only the documentSubClass evidence candidate — no coercion attempted
  });

  it('detects a claim document and fails safely (no canonical claim model exists)', () => {
    const text = ['CLAIM FORM', '', 'Insurer: Acme Life Insurance Ltd', 'Policy Number: 999', 'Claim Amount: 1000'].join('\n');
    const result = parseInsuranceDocument(text);
    expect(result.outcome).toBe('failed');
    expect(result.documentClass).toBe('claim_document');
  });

  it('classifies genuinely ambiguous insurance-domain text as unclassified_insurance_document rather than guessing a certified sub-class', () => {
    const text = ['Insurer: Acme Life Insurance Ltd', 'Sum Insured: 500000', 'Premium: 100.00'].join('\n');
    const result = parseInsuranceDocument(text);
    expect(result.documentClass).toBe('unclassified_insurance_document');
    expect(result.outcome).toBe('failed');
  });
});
