/**
 * II-PC1-D2 — server-side ISIN syntax/check-digit validation.
 *
 * Original defect: iiManualDirectPositionSchema validated `isin: z.string().min(1)`
 * — effectively "non-empty string". This suite proves the RED state (any
 * non-empty string was accepted) is gone and the new validateIsin()
 * enforces real ISO 6166 structure + check digit.
 */
import { describe, it, expect } from 'vitest';
import { validateIsin, isValidIsinCheckDigit } from '@/lib/services/investment-intelligence/isinValidation';
import { iiManualDirectPositionSchema } from '@/lib/validation/investment-intelligence';

// Known-real, publicly documented ISINs (used only as check-digit test
// vectors — no live market-reference lookup is performed by this module).
const REAL_VALID_ISINS = [
  'US0378331005', // Apple Inc
  'INE002A01018', // Reliance Industries
  'GB0002374006', // Diageo
];

describe('PC1-D2-RED — the prior schema accepted ANY non-empty string as an ISIN', () => {
  it('demonstrates the vacuous prior contract: z.string().min(1) accepts garbage', () => {
    const vacuousSchema = { min1: (s: string) => s.length >= 1 };
    expect(vacuousSchema.min1('not-an-isin-at-all')).toBe(true); // this alone was "valid" before PC1-D2
  });
});

describe('PC1-D2-GREEN — validateIsin: valid examples', () => {
  it.each(REAL_VALID_ISINS)('accepts a genuine, correctly check-digited ISIN: %s', (isin) => {
    const result = validateIsin(isin);
    expect(result.ok).toBe(true);
    expect(result.normalised).toBe(isin);
    expect(result.error).toBeNull();
  });

  it('accepts lowercase input and normalises to uppercase (explicit lowercase policy)', () => {
    const result = validateIsin('us0378331005');
    expect(result.ok).toBe(true);
    expect(result.normalised).toBe('US0378331005');
  });

  it('accepts input with leading/trailing whitespace after trimming', () => {
    const result = validateIsin('  US0378331005  ');
    expect(result.ok).toBe(true);
    expect(result.normalised).toBe('US0378331005');
  });
});

describe('PC1-D2-GREEN — validateIsin: wrong length', () => {
  it('rejects an 11-character value', () => {
    expect(validateIsin('US037833100').ok).toBe(false);
  });
  it('rejects a 13-character value', () => {
    expect(validateIsin('US03783310055').ok).toBe(false);
  });
});

describe('PC1-D2-GREEN — validateIsin: illegal characters / structure', () => {
  it('rejects illegal punctuation', () => {
    expect(validateIsin('US-378331005').ok).toBe(false);
  });
  it('rejects an invalid country-prefix structure (digits where letters are required)', () => {
    expect(validateIsin('120378331005').ok).toBe(false);
  });
});

describe('PC1-D2-GREEN — validateIsin: wrong check digit', () => {
  it('rejects a valid-shaped 12-char value whose check digit is wrong', () => {
    // US0378331005 is real; flip the trailing check digit only.
    const tampered = 'US0378331006';
    expect(isValidIsinCheckDigit('US0378331005')).toBe(true);
    expect(validateIsin(tampered).ok).toBe(false);
  });
});

describe('PC1-D2-GREEN — validateIsin: blank / whitespace / hostile input', () => {
  it('rejects an empty string', () => {
    expect(validateIsin('').ok).toBe(false);
  });
  it('rejects a whitespace-only string', () => {
    expect(validateIsin('   ').ok).toBe(false);
  });
  it('rejects a malicious/overlong string without throwing', () => {
    expect(() => validateIsin('A'.repeat(100000))).not.toThrow();
    expect(validateIsin('A'.repeat(100000)).ok).toBe(false);
  });
  it('rejects non-string input without throwing', () => {
    expect(validateIsin(12345 as unknown as string).ok).toBe(false);
    expect(validateIsin(null as unknown as string).ok).toBe(false);
    expect(validateIsin(undefined as unknown as string).ok).toBe(false);
  });
});

describe('PC1-D2 — identifier validity vs asset-class scope are SEPARATE concerns', () => {
  it('a syntactically valid ISIN for an out-of-scope instrumentClass is still rejected by the frozen-scope Zod enum, not by ISIN validation', () => {
    const parsed = iiManualDirectPositionSchema.safeParse({
      action: 'buy',
      instrumentClass: 'mutual_fund', // NOT in the frozen 'equity'|'etf' enum
      instrumentName: 'Some Fund',
      isin: 'US0378331005', // perfectly valid ISIN
      accountInstitutionName: 'Test Broker',
      transactionDate: '2025-02-01',
      units: 10,
      pricePerUnit: 100,
    });
    expect(parsed.success).toBe(false); // rejected at the schema/scope layer, ISIN validity notwithstanding
  });

  it('a syntactically valid ISIN with an in-scope instrumentClass passes schema validation (ISIN itself validated later, service-side)', () => {
    const parsed = iiManualDirectPositionSchema.safeParse({
      action: 'buy',
      instrumentClass: 'equity',
      instrumentName: 'Reliance Industries',
      isin: 'INE002A01018',
      accountInstitutionName: 'Test Broker',
      transactionDate: '2025-02-01',
      units: 10,
      pricePerUnit: 100,
    });
    expect(parsed.success).toBe(true);
  });
});
