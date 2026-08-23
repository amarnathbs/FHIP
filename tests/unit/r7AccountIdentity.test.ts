/**
 * R7 — Bank CSV Engine independent certification: account identity /
 * multi-currency (spec section 64, cases R7-TC121-R7-TC130).
 */
import { describe, expect, it } from 'vitest';
import {
  computeAccountFingerprint,
  normaliseMaskedIdentifier,
  resolveAccountIdentity,
} from '@/lib/financial-data-hub/bank-csv/accountIdentity';

describe('R7-TC121-124 — masked identifier safety', () => {
  it('R7-TC121 a display-safe masked identifier ("****1234") is accepted', () => {
    expect(normaliseMaskedIdentifier('****1234')).toBe('****1234');
  });
  it('R7-TC122 anything with 7+ consecutive digits (a real account number) is rejected, never persisted', () => {
    expect(normaliseMaskedIdentifier('12345678')).toBeNull();
    expect(normaliseMaskedIdentifier('BSB 123456 ACC 1234567')).toBeNull();
  });
  it('R7-TC123 empty/whitespace-only input normalises to null', () => {
    expect(normaliseMaskedIdentifier('')).toBeNull();
    expect(normaliseMaskedIdentifier('   ')).toBeNull();
  });
  it('R7-TC124 case is normalised for stable fingerprinting', () => {
    expect(normaliseMaskedIdentifier('abcd')).toBe('ABCD');
  });
});

describe('R7-TC125-128 — account fingerprint determinism and scope', () => {
  it('R7-TC125 the same user+institution+currency+identifier always fingerprints identically', () => {
    const a = computeAccountFingerprint({ userId: 'u1', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    const b = computeAccountFingerprint({ userId: 'u1', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    expect(a).toBe(b);
  });
  it('R7-TC126 a different currency (multi-currency safety) fingerprints differently even with the same identifier', () => {
    const aud = computeAccountFingerprint({ userId: 'u1', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    const inr = computeAccountFingerprint({ userId: 'u1', institutionId: 'inst1', currencyCode: 'INR', maskedIdentifierNormalised: '****1234' });
    expect(aud).not.toBe(inr);
  });
  it('R7-TC127 a different user never shares a fingerprint even with identical institution/identifier (tenant isolation at the fingerprint level)', () => {
    const u1 = computeAccountFingerprint({ userId: 'user-a', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    const u2 = computeAccountFingerprint({ userId: 'user-b', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    expect(u1).not.toBe(u2);
  });
  it('R7-TC128 fingerprint is a one-way hash — never reversible/recognisable as the original identifier', () => {
    const fp = computeAccountFingerprint({ userId: 'u1', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    expect(fp).not.toContain('1234');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R7-TC129-130 — resolution decision fail-safety (spec 30-31)', () => {
  it('R7-TC129a a real identifier matching an existing account REUSES it', () => {
    const fp = computeAccountFingerprint({ userId: 'u1', institutionId: 'inst1', currencyCode: 'AUD', maskedIdentifierNormalised: '****1234' });
    const decision = resolveAccountIdentity({
      userId: 'u1',
      institutionId: 'inst1',
      currencyCode: 'AUD',
      maskedIdentifierNormalised: '****1234',
      existingAccountsForInstitutionAndCurrency: [{ id: 'acct-1', accountFingerprint: fp }],
    });
    expect(decision).toEqual({ outcome: 'reuse', accountId: 'acct-1', fingerprint: fp });
  });
  it('R7-TC129b a real identifier with no existing match safely CREATES a new account', () => {
    const decision = resolveAccountIdentity({
      userId: 'u1',
      institutionId: 'inst1',
      currencyCode: 'AUD',
      maskedIdentifierNormalised: '****9999',
      existingAccountsForInstitutionAndCurrency: [],
    });
    expect(decision.outcome).toBe('create');
  });
  it('R7-TC130a no identifier + zero existing accounts safely CREATES one', () => {
    const decision = resolveAccountIdentity({
      userId: 'u1',
      institutionId: 'inst1',
      currencyCode: 'AUD',
      maskedIdentifierNormalised: null,
      existingAccountsForInstitutionAndCurrency: [],
    });
    expect(decision.outcome).toBe('create');
  });
  it('R7-TC130b no identifier + TWO existing accounts is AMBIGUOUS — never merges/guesses which one (spec 31: two accounts must never be incorrectly merged)', () => {
    const decision = resolveAccountIdentity({
      userId: 'u1',
      institutionId: 'inst1',
      currencyCode: 'AUD',
      maskedIdentifierNormalised: null,
      existingAccountsForInstitutionAndCurrency: [
        { id: 'acct-1', accountFingerprint: 'fp1' },
        { id: 'acct-2', accountFingerprint: 'fp2' },
      ],
    });
    expect(decision.outcome).toBe('ambiguous');
  });
  it('R7-TC130c no identifier + ONE existing DIFFERENTLY-IDENTIFIED account is AMBIGUOUS, not silently attached ("both say Savings Account")', () => {
    const decision = resolveAccountIdentity({
      userId: 'u1',
      institutionId: 'inst1',
      currencyCode: 'AUD',
      maskedIdentifierNormalised: null,
      existingAccountsForInstitutionAndCurrency: [{ id: 'acct-1', accountFingerprint: 'some-other-fingerprint' }],
    });
    expect(decision.outcome).toBe('ambiguous');
  });
});
