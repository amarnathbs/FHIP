/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE10-MASK-01    Typed placeholder vocabulary for person, address, account, card,
 *                    member/tax ID, email, phone, employer.
 *   AIE10-MASK-09    Fail-closed masking admission threshold. NOTE:
 *                    isBelowMaskingPolicy is tested here but is INERT in production —
 *                    its only caller passes labelsSeenRaw: [] pending PO-BLOCKER-3.
 *   AIE11-PII-02     Typed detection for person, address, account, card, member/tax id,
 *                    email, phone and employer.
 *   AIE11-PII-05     Document-local placeholder scope by default.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { maskText, isForbiddenLabel, isBelowMaskingPolicy, containsUnmaskedPii, maskPanForDisplay } from '@/lib/aie/masking/piiMasking';

// A deterministic, obviously-fake 32-byte key. Masking FAILS CLOSED without
// one (`identifierToken.ts` throws), which is itself asserted below — so the
// key has to be installed for the rest of the suite to exercise anything.
const TEST_KEY = 'a1'.repeat(32);
const TENANT_A = { tenantKey: 'user-aaaa-1111' };
const TENANT_B = { tenantKey: 'user-bbbb-2222' };

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = originalKey;
});

describe('AIE-1.1 PII masking engine (PII-01..12)', () => {
  it('masks an India PAN, an AU TFN-shaped number, an email, and a card-shaped digit run', () => {
    const text = 'PAN: ABCDE1234F. TFN: 123 456 789. Contact: person@example.com. Card: 4111 1111 1111 1111.';
    const result = maskText(text, TENANT_A);
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
    const result = maskText(text, TENANT_A);
    expect(result.maskedText).toContain('1234.56');
    expect(result.maskedText).toContain('2000.00');
    expect(result.totalMatches).toBe(0);
  });

  it('assigns the same token to a repeated identical raw value within one call', () => {
    const text = 'PAN ABCDE1234F appears twice: ABCDE1234F.';
    const result = maskText(text, TENANT_A);
    const tokens = [...result.maskedText.matchAll(/\[MASKED:[^\]]+\]/g)].map((m) => m[0]);
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(result.distinctIdentifierCount).toBe(1);
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
    expect(containsUnmaskedPii(maskText('PAN: ABCDE1234F', TENANT_A).maskedText)).toBe(false);
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

  // ---- M3 (Phase 4): the Product Owner's one-way-HMAC tokenisation
  // decision. These replace M2's "reversible token map" assertions, which
  // asserted the behaviour that decision removed.
  describe('M3 — keyed one-way HMAC pseudonyms (PO decision 2026-09-15, D.6)', () => {
    it('returns no reversible token map of any kind — the property does not exist on the result', () => {
      const result = maskText('Email me at person@example.com please.', TENANT_A);
      expect('reversibleTokenMap' in result).toBe(false);
      // And nothing else on the result carries the original value either.
      expect(JSON.stringify(result)).not.toContain('person@example.com');
    });

    it('is STABLE across separate calls for the same tenant — the property the counter scheme could not provide', () => {
      // Pre-M3 behaviour was the exact opposite: each call minted a fresh
      // random salt, so the same folio in January's and February's statements
      // produced different tokens and could not be matched up at all.
      const jan = maskText('Folio No: 1234567/89', TENANT_A).maskedText;
      const feb = maskText('Folio Number 1234567/89', TENANT_A).maskedText;
      const janToken = /\[MASKED:folio_number:[^\]]+\]/.exec(jan)?.[0];
      const febToken = /\[MASKED:folio_number:[^\]]+\]/.exec(feb)?.[0];
      expect(janToken).toBeDefined();
      expect(janToken).toBe(febToken);
    });

    it('is NOT correlatable across tenants — the same folio yields a different token for a different user', () => {
      const a = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 1234567/89', TENANT_A).maskedText)?.[0];
      const b = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 1234567/89', TENANT_B).maskedText)?.[0];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
    });

    it('normalises separator/case variants of one identifier to one token, but does not collapse different identifiers', () => {
      const spaced = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 1234567-89', TENANT_A).maskedText)?.[0];
      const plain = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 123456789', TENANT_A).maskedText)?.[0];
      expect(spaced).toBe(plain);

      const other = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 987654321', TENANT_A).maskedText)?.[0];
      expect(other).not.toBe(plain);
    });

    it('token bodies contain NO digits, so a later digit-shaped pattern cannot re-match a placeholder', () => {
      // This is the same structural guarantee the old random salt documented
      // for itself, preserved deliberately: `long_digit_run` is \d{11,} and
      // `card_number` is 13-19 digits, and a hex-rendered MAC would trip both.
      const masked = maskText('PAN: ABCDE1234F  Folio No: 12345678/90', TENANT_A).maskedText;
      for (const token of masked.matchAll(/\[MASKED:[a-z_]+:hmac:([^\]]+)\]/g)) {
        expect(token[1]).toMatch(/^[a-p]+$/);
      }
    });

    it('FAILS CLOSED with no key — it throws rather than degrading to an unkeyed hash', () => {
      const saved = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
      delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
      try {
        expect(() => maskText('PAN: ABCDE1234F', TENANT_A)).toThrow(/AIE_MASK_TOKEN_ENCRYPTION_KEY/);
      } finally {
        process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = saved;
      }
    });

    it('a different key produces different tokens — the security property comes from the key, not the algorithm', () => {
      const withKeyA = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 1234567/89', TENANT_A).maskedText)?.[0];
      const saved = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
      process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'b2'.repeat(32);
      try {
        const withKeyB = /\[MASKED:folio_number:[^\]]+\]/.exec(maskText('Folio No: 1234567/89', TENANT_A).maskedText)?.[0];
        expect(withKeyB).not.toBe(withKeyA);
      } finally {
        process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = saved;
      }
    });
  });

  // ---- M2 (H.9): categories named by global invariant D.6 that previously
  // had no detector at all. Each test states the pre-M2 behaviour it guards
  // against, so a future narrowing of these patterns fails loudly.
  describe('M2 (H.9) — D.6 categories that had no detector before M2', () => {
    it('masks a spaced India Aadhaar, which no pre-M2 pattern matched', () => {
      const result = maskText('Aadhaar: 2345 6789 0123 on file.', TENANT_A);
      expect(result.maskedText).not.toContain('2345 6789 0123');
      expect(result.coverageByType.aadhaar).toBe(1);
    });

    it('does not mask a 12-digit money figure grouped in fours that cannot be an Aadhaar', () => {
      const result = maskText('Value 1234 5678 9012 INR', TENANT_A);
      expect(result.coverageByType.aadhaar ?? 0).toBe(0);
    });

    it('masks an India IFSC code', () => {
      const result = maskText('Bank IFSC HDFC0001234 branch Mumbai.', TENANT_A);
      expect(result.maskedText).not.toContain('HDFC0001234');
      expect(result.coverageByType.ifsc).toBe(1);
    });

    it('tokenises a folio number but KEEPS the folio label so the adapter can still see the field existed', () => {
      const result = maskText('Folio No: 12345678/90', TENANT_A);
      expect(result.maskedText).not.toContain('12345678/90');
      expect(result.maskedText.toLowerCase()).toContain('folio');
      expect(result.coverageByType.folio_number).toBe(1);
    });

    it('gives the same folio value the same token twice within one document', () => {
      const result = maskText('Folio No: 1234567/89 ... Folio Number 1234567/89', TENANT_A);
      const tokens = [...result.maskedText.matchAll(/\[MASKED:folio_number:[^\]]+\]/g)].map((m) => m[0]);
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBe(tokens[1]);
      expect(result.distinctIdentifierCount).toBe(1);
    });

    it('containsUnmaskedPii — the independent pre-egress gate — catches all three M2 categories', () => {
      expect(containsUnmaskedPii('Aadhaar 2345 6789 0123')).toBe(true);
      expect(containsUnmaskedPii('IFSC HDFC0001234')).toBe(true);
      expect(containsUnmaskedPii('Folio No: 12345678/90')).toBe(true);
    });

    it('masks a holder name, which had no rule at all before M2', () => {
      const result = maskText('Investor: RAJESH KUMAR SHARMA', TENANT_A);
      expect(result.maskedText).not.toContain('RAJESH KUMAR SHARMA');
      expect(result.coverageByType.person_name_label).toBe(1);
      expect(result.maskedText).toContain('Investor:');
    });

    it('masks a nominee name', () => {
      const result = maskText('Nominee: PRIYA SHARMA', TENANT_A);
      expect(result.maskedText).not.toContain('PRIYA SHARMA');
      expect(result.coverageByType.person_name_label).toBe(1);
    });

    it('does NOT mask a scheme name, the non-personal field the adapter exists to read', () => {
      const result = maskText('Scheme Name: NIPPON INDIA LIQUID FUND - GROWTH', TENANT_A);
      expect(result.maskedText).toContain('NIPPON INDIA LIQUID FUND');
      expect(result.coverageByType.person_name_label ?? 0).toBe(0);
    });

    // 2026-09-22 (AIE payslip AI-fallback adapter) — found live, against the
    // real provider, that a payslip's employee name egressed unmasked
    // because 'employee' was not in this rule's label alternation (the same
    // class of gap M12B found and fixed for insurance's `Policy Owner:`/
    // `Insured Person:` labels — this file's own `person_name_label` header
    // comment). See piiMasking.ts's own 2026-09-22 comment for the full
    // disclosure and tests/live-dev/aiePayslipAdapterLiveProviderProof.live.test.ts
    // for the live proof that found it.
    it('masks an employee name on a payslip, which had no rule at all before this fix', () => {
      const result = maskText('Employee: JANE ANNE CITIZEN', TENANT_A);
      expect(result.maskedText).not.toContain('JANE ANNE CITIZEN');
      expect(result.coverageByType.person_name_label).toBe(1);
      expect(result.maskedText).toContain('Employee:');
    });

    it('masks an "Employee Name:" label variant too', () => {
      const result = maskText('Employee Name: JANE ANNE CITIZEN', TENANT_A);
      expect(result.maskedText).not.toContain('JANE ANNE CITIZEN');
      expect(result.coverageByType.person_name_label).toBe(1);
    });

    it('does NOT mask the employer name — a business name the payslip adapter exists to read, not personal PII', () => {
      const result = maskText('Employer: ACME AUSTRALIA PTY LTD', TENANT_A);
      expect(result.maskedText).toContain('ACME AUSTRALIA PTY LTD');
      expect(result.coverageByType.person_name_label ?? 0).toBe(0);
    });

    it('a folio value does not swallow the next field label on a real CAS line', () => {
      const result = maskText('Folio No: 12345678/90   IFSC: HDFC0001234', TENANT_A);
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
      const masked = maskText(cas, TENANT_A).maskedText;
      for (const secret of ['ABCDE1234F', '2345 6789 0123', '12345678/90', 'HDFC0001234', 'investor@example.com', '+919876543210']) {
        expect(masked).not.toContain(secret);
      }
      expect(containsUnmaskedPii(masked)).toBe(false);
    });
  });

  // ---- M3: closes M2-OPEN-7, the last D.6 category with no rule at all.
  describe('M3 — address masking (closes M2-OPEN-7)', () => {
    it('masks a postal address on its label line, keeping the label', () => {
      const result = maskText('Address: 12 MG Road, Bandra West, Mumbai 400050', TENANT_A);
      expect(result.maskedText).not.toContain('MG Road');
      expect(result.maskedText).toContain('Address:');
      expect(result.coverageByType.address_label).toBe(1);
    });

    it('handles the qualified label variants real statements print', () => {
      for (const label of ['Correspondence Address', 'Permanent Address', 'Registered Address', 'Mailing Address']) {
        const result = maskText(`${label}: 12 MG Road, Mumbai 400050`, TENANT_A);
        expect(result.maskedText).not.toContain('MG Road');
        expect(result.coverageByType.address_label).toBe(1);
      }
    });

    it('does NOT claim an "Email Address:" line as an address — it stays classified as an email', () => {
      // Without the lookbehind this rule would win the span first. The value
      // would still be masked, but `coverage_by_type` would describe the
      // document wrongly, which is the failure M2 fixed for TFN-vs-folio.
      const result = maskText('Email Address: investor@example.com', TENANT_A);
      expect(result.maskedText).not.toContain('investor@example.com');
      expect(result.coverageByType.email).toBe(1);
      expect(result.coverageByType.address_label ?? 0).toBe(0);
    });

    it('does not re-tokenise an already-masked placeholder that falls inside its open-ended capture', () => {
      // The address rule captures to end of line, so on a line where an
      // earlier rule already replaced something it must leave that token
      // alone rather than MAC-ing a token.
      // M12C: the rule can now also take up to 3 BOUNDED continuation lines
      // (`M3-OPEN-2`), which does not change anything asserted here — this
      // input is a single line — but the same placeholder protection now has
      // to hold across the continuation too. That is proved separately in
      // `tests/unit/m12cMultilineAddressMasking.test.ts`.
      const result = maskText('Address: 12 MG Road  PAN: ABCDE1234F', TENANT_A);
      const tokenBodies = [...result.maskedText.matchAll(/\[MASKED:[a-z_]+:hmac:([a-p]+)\]/g)];
      expect(tokenBodies.length).toBeGreaterThanOrEqual(1);
      expect(result.maskedText).not.toContain('[MASKED:address_label:hmac:[MASKED:');
    });
  });
});
