import { describe, it, expect } from 'vitest';
import { maskText, isForbiddenLabel, isBelowMaskingPolicy, containsUnmaskedPii, maskPanForDisplay } from '@/lib/aie/masking/piiMasking';

describe('AIE-1.1 PII masking engine (PII-01..12)', () => {
  it('masks an India PAN, an AU TFN-shaped number, an email, and a card-shaped digit run', () => {
    const text = 'PAN: ABCDE1234F. TFN: 123 456 789. Contact: person@example.com. Card: 4111 1111 1111 1111.';
    const result = maskText(text);
    expect(result.maskedText).not.toContain('ABCDE1234F');
    expect(result.maskedText).not.toContain('123 456 789');
    expect(result.maskedText).not.toContain('person@example.com');
    expect(result.maskedText).not.toContain('4111 1111 1111 1111');
    expect(result.totalMatches).toBeGreaterThanOrEqual(4);
    expect(result.coverageByType.tax_id).toBeGreaterThanOrEqual(1);
    expect(result.coverageByType.email).toBe(1);
  });

  it('does not mask ordinary financial figures that are not PII-shaped', () => {
    const text = 'Opening balance: 1234.56. Closing balance: 2000.00. Currency: AUD.';
    const result = maskText(text);
    expect(result.maskedText).toContain('1234.56');
    expect(result.maskedText).toContain('2000.00');
    expect(result.totalMatches).toBe(0);
  });

  it('assigns the same token to a repeated identical raw value within one call (document-local scope)', () => {
    const text = 'PAN ABCDE1234F appears twice: ABCDE1234F.';
    const result = maskText(text);
    const tokens = [...result.maskedText.matchAll(/\[MASKED:[^\]]+\]/g)].map((m) => m[0]);
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toBe(tokens[1]);
  });

  it('produces a reversible token map keyed by token -> original raw value', () => {
    const result = maskText('Email me at person@example.com please.');
    const tokens = Object.keys(result.reversibleTokenMap);
    expect(tokens.length).toBe(1);
    expect(result.reversibleTokenMap[tokens[0]]).toBe('person@example.com');
  });

  it('two separate calls never share a token namespace (cross-call correlation resistance)', () => {
    const a = maskText('person@example.com');
    const b = maskText('person@example.com');
    const tokenA = Object.keys(a.reversibleTokenMap)[0];
    const tokenB = Object.keys(b.reversibleTokenMap)[0];
    expect(tokenA).not.toBe(tokenB);
  });

  it('flags forbidden field labels regardless of case', () => {
    expect(isForbiddenLabel('Tax File Number')).toBe(true);
    expect(isForbiddenLabel('Bank Account')).toBe(true);
    expect(isForbiddenLabel('Opening Balance')).toBe(false);
  });

  it('isBelowMaskingPolicy blocks when a forbidden label was seen raw, regardless of masked-text content', () => {
    expect(isBelowMaskingPolicy({ maskedText: 'anything', labelsSeenRaw: ['Tax File Number'] })).toBe(true);
    expect(isBelowMaskingPolicy({ maskedText: 'anything', labelsSeenRaw: ['Opening Balance'] })).toBe(false);
  });

  it('containsUnmaskedPii detects a residual PAN even if the caller believed it already masked the text', () => {
    expect(containsUnmaskedPii('some text with ABCDE1234F embedded')).toBe(true);
    expect(containsUnmaskedPii('[MASKED:tax_id:abc123:1] only')).toBe(false);
  });

  it('containsUnmaskedPii is stateless across repeated calls (global-regex lastIndex is reset each call)', () => {
    // Regression guard: a naive implementation using a shared global RegExp
    // object with .test() leaks lastIndex state across calls and can
    // silently return false on the second identical call.
    expect(containsUnmaskedPii('person@example.com')).toBe(true);
    expect(containsUnmaskedPii('person@example.com')).toBe(true);
  });

  it('maskPanForDisplay applies the first-5/last-1 convention and passes through non-PAN-shaped input unchanged', () => {
    expect(maskPanForDisplay('ABCDE1234F')).toBe('ABCDE****F');
    expect(maskPanForDisplay('not-a-pan')).toBe('NOT-A-PAN');
    expect(maskPanForDisplay(null)).toBeNull();
  });
});
