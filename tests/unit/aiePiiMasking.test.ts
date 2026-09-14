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

  // ---- M2 (H.9): categories named by global invariant D.6 that previously
  // had no detector at all. Each test states the pre-M2 behaviour it guards
  // against, so a future narrowing of these patterns fails loudly.
  describe('M2 (H.9) — D.6 categories that had no detector before M2', () => {
    it('masks a spaced India Aadhaar, which no pre-M2 pattern matched', () => {
      // Pre-M2: the card rule needed 13-19 digits and the TFN rule needed a
      // word boundary after 8-9, so `1234 5678 9012` fell through entirely.
      const result = maskText('Aadhaar: 2345 6789 0123 on file.');
      expect(result.maskedText).not.toContain('2345 6789 0123');
      expect(result.coverageByType.aadhaar).toBe(1);
    });

    it('does not mask a 12-digit money figure grouped in fours that cannot be an Aadhaar', () => {
      // A real Aadhaar never starts with 0 or 1 — that is what keeps this
      // rule from eating ordinary financial values.
      const result = maskText('Value 1234 5678 9012 INR');
      expect(result.coverageByType.aadhaar ?? 0).toBe(0);
    });

    it('masks an India IFSC code', () => {
      const result = maskText('Bank IFSC HDFC0001234 branch Mumbai.');
      expect(result.maskedText).not.toContain('HDFC0001234');
      expect(result.coverageByType.ifsc).toBe(1);
    });

    it('tokenises a folio number but KEEPS the folio label so the adapter can still see the field existed', () => {
      const result = maskText('Folio No: 12345678/90');
      expect(result.maskedText).not.toContain('12345678/90');
      expect(result.maskedText.toLowerCase()).toContain('folio');
      expect(result.coverageByType.folio_number).toBe(1);
    });

    it('gives the same folio value the same token twice within one document, and reverses only via the token map', () => {
      const result = maskText('Folio No: 1234567/89 ... Folio Number 1234567/89');
      const tokens = Object.keys(result.reversibleTokenMap);
      const folioTokens = tokens.filter((t) => t.includes(':folio_number:'));
      expect(folioTokens).toHaveLength(1);
      expect(result.reversibleTokenMap[folioTokens[0]]).toBe('1234567/89');
    });

    it('containsUnmaskedPii — the independent pre-egress gate — now catches all three new categories', () => {
      // This is the check `lib/aie/provider/gateway.ts` runs immediately
      // before building a provider payload. Before M2 all three returned
      // false, i.e. the gate would have passed them straight through.
      expect(containsUnmaskedPii('Aadhaar 2345 6789 0123')).toBe(true);
      expect(containsUnmaskedPii('IFSC HDFC0001234')).toBe(true);
      expect(containsUnmaskedPii('Folio No: 12345678/90')).toBe(true);
    });

    it('masks a holder name, which had no rule at all before M2', () => {
      // Found by M2's own live provider proof: the holder name was being sent
      // to OpenAI verbatim. D.6 requires holder names to be tokenised.
      const result = maskText('Investor: RAJESH KUMAR SHARMA');
      expect(result.maskedText).not.toContain('RAJESH KUMAR SHARMA');
      expect(result.coverageByType.person_name_label).toBe(1);
      expect(result.maskedText).toContain('Investor:');
    });

    it('masks a nominee name', () => {
      const result = maskText('Nominee: PRIYA SHARMA');
      expect(result.maskedText).not.toContain('PRIYA SHARMA');
      expect(result.coverageByType.person_name_label).toBe(1);
    });

    it('does NOT mask a scheme name, the non-personal field the adapter exists to read', () => {
      // Guard against the obvious over-reach: a bare `name` label alternative
      // would match `Scheme Name:` and destroy the extraction target.
      const result = maskText('Scheme Name: NIPPON INDIA LIQUID FUND - GROWTH');
      expect(result.maskedText).toContain('NIPPON INDIA LIQUID FUND');
      expect(result.coverageByType.person_name_label ?? 0).toBe(0);
    });

    it('a folio value does not swallow the next field label on a real CAS line', () => {
      // Regression guard for an M2 draft bug: allowing whitespace inside the
      // folio value ran the match across the gap and consumed `IFSC`.
      const result = maskText('Folio No: 12345678/90   IFSC: HDFC0001234');
      expect(result.maskedText).toContain('IFSC:');
      expect(result.coverageByType.folio_number).toBe(1);
      expect(result.coverageByType.ifsc).toBe(1);
    });

    it('a realistic CAS header leaks none of PAN, Aadhaar, IFSC, folio, email or mobile', () => {
      const cas = [
        'CONSOLIDATED ACCOUNT STATEMENT',
        'PAN: ABCDE1234F   Aadhaar: 2345 6789 0123',
        'Folio No: 12345678/90   IFSC: HDFC0001234',
        'Email: investor@example.com   Mobile: +919876543210',
      ].join('\n');
      const masked = maskText(cas).maskedText;
      for (const secret of ['ABCDE1234F', '2345 6789 0123', '12345678/90', 'HDFC0001234', 'investor@example.com', '+919876543210']) {
        expect(masked).not.toContain(secret);
      }
      expect(containsUnmaskedPii(masked)).toBe(false);
    });
  });
});
