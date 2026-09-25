// AIE masking -- an AU HIN/SRN printed with only a space after its label
// (2026-09-25, other-PDF AI proof). Written to FAIL on origin/main 8b6692c:
// `HIN X0001234567` (broker prose, CSV narrative columns) matched no rule and
// would have reached the AI provider verbatim; the gateway's pre-egress
// re-scan shares the same patterns, so it could not catch it either.
// Synthetic values only.
import { describe, it, expect, beforeAll } from 'vitest';
import { maskText, containsUnmaskedPii } from '@/lib/aie/masking/piiMasking';

beforeAll(() => {
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'd4'.repeat(32);
});

describe('HIN / SRN with a space separator', () => {
  it.each([
    ['Client account HIN X0001234567 with Imaginary Broking', 'X0001234567'],
    ['Issuer sponsored SRN I0009876543 applies', 'I0009876543'],
    ['hin x0001234567', 'x0001234567'],
  ])('%s -> the identifier is masked', (text, value) => {
    const masked = maskText(text, { tenantKey: 'hin-space-test' }).maskedText;
    expect(masked).not.toContain(value);
    expect(masked).toContain('[MASKED:holder_identification_number:');
    expect(containsUnmaskedPii(masked)).toBe(false);
  });

  it('does not swallow ordinary words after the label (value must be one letter + 10 digits)', () => {
    const text = 'HIN holders receive a CHESS statement';
    expect(maskText(text, { tenantKey: 'hin-space-test' }).maskedText).toBe(text);
  });

  it('the existing colon form is unchanged', () => {
    const masked = maskText('HIN: X0001234567', { tenantKey: 'hin-space-test' }).maskedText;
    expect(masked).not.toContain('X0001234567');
  });
});
