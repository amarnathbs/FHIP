import { describe, it, expect } from 'vitest';
import { computeTransactionFingerprint, type FingerprintInput } from '@/lib/services/investment-intelligence/fingerprint';
import { parseExactDecimal } from '@/lib/services/investment-intelligence/decimal';

function scaled(s: string): bigint {
  const r = parseExactDecimal(s);
  if (!r.ok) throw new Error('bad test input');
  return r.scaled;
}

function base(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    sourceKey: 'cams',
    accountId: 'acct-1',
    instrumentId: 'inst-1',
    transactionDateIso: '2025-02-01',
    transactionType: 'purchase',
    amountScaled: scaled('10000.00'),
    unitsScaled: scaled('83.500'),
    navScaled: scaled('119.7605'),
    sourceReference: 'TXN0001',
    ...overrides,
  };
}

describe('computeTransactionFingerprint (spec section 21 — deterministic dedup fingerprint)', () => {
  it('is deterministic — the same input always produces the same fingerprint', () => {
    const a = computeTransactionFingerprint(base());
    const b = computeTransactionFingerprint(base());
    expect(a).toBe(b);
  });

  it('changes when the source reference changes (two distinct transactions with the same other fields)', () => {
    const a = computeTransactionFingerprint(base({ sourceReference: 'TXN0001' }));
    const b = computeTransactionFingerprint(base({ sourceReference: 'TXN0002' }));
    expect(a).not.toBe(b);
  });

  it('changes when the amount changes', () => {
    const a = computeTransactionFingerprint(base({ amountScaled: scaled('10000.00') }));
    const b = computeTransactionFingerprint(base({ amountScaled: scaled('10000.01') }));
    expect(a).not.toBe(b);
  });

  it('changes when the account changes (same transaction shape in a different account is NOT a duplicate)', () => {
    const a = computeTransactionFingerprint(base({ accountId: 'acct-1' }));
    const b = computeTransactionFingerprint(base({ accountId: 'acct-2' }));
    expect(a).not.toBe(b);
  });

  it('changes when the instrument changes', () => {
    const a = computeTransactionFingerprint(base({ instrumentId: 'inst-1' }));
    const b = computeTransactionFingerprint(base({ instrumentId: 'inst-2' }));
    expect(a).not.toBe(b);
  });

  it('changes when the transaction type changes (a purchase and a redemption of the same amount are not the same fingerprint)', () => {
    const a = computeTransactionFingerprint(base({ transactionType: 'purchase' }));
    const b = computeTransactionFingerprint(base({ transactionType: 'redemption' }));
    expect(a).not.toBe(b);
  });

  it('is the SAME across two documents when every fingerprinted field is identical (DEDUP-003 requirement — resolves to one canonical transaction)', () => {
    // Simulates the same transaction re-appearing in an overlapping/refreshed
    // statement — sourceKey/account/instrument/date/type/amount/units/nav/
    // reference all identical because they describe the same real event.
    const a = computeTransactionFingerprint(base());
    const b = computeTransactionFingerprint(base());
    expect(a).toBe(b);
  });

  it('treats a present vs. absent units value as genuinely different (never conflates null with zero)', () => {
    const a = computeTransactionFingerprint(base({ unitsScaled: null }));
    const b = computeTransactionFingerprint(base({ unitsScaled: scaled('0.000') }));
    expect(a).not.toBe(b);
  });

  it('produces a 64-character lowercase hex SHA-256 digest', () => {
    const fp = computeTransactionFingerprint(base());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
