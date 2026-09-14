import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveIdentifierToken, isOneWayIdentifierToken, normaliseIdentifierForToken } from '@/lib/aie/masking/identifierToken';

const TEST_KEY = 'a1'.repeat(32);
let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = originalKey;
});

/**
 * M3 (Phase 4) — the keyed one-way pseudonym primitive itself, as decided by
 * the Product Owner on 2026-09-15 in resolution of M2's `PO-BLOCKER-2`.
 *
 * These tests are deliberately about CRYPTOGRAPHIC PROPERTIES rather than
 * output strings. Asserting a hardcoded expected token would pin the
 * construction to one implementation and would pass just as happily for a
 * bare unkeyed hash — which is the exact thing D.6 forbids and which a
 * naive "make it one-way" change would produce.
 */
describe('M3 — deriveIdentifierToken: keyed, one-way, tenant-bound (D.6)', () => {
  it('is DETERMINISTIC for the same (tenant, type, value)', () => {
    const a = deriveIdentifierToken({ tenantKey: 'u1', type: 'folio_number', value: '1234567/89' });
    const b = deriveIdentifierToken({ tenantKey: 'u1', type: 'folio_number', value: '1234567/89' });
    expect(a).toBe(b);
  });

  it('is TENANT-BOUND — the same identifier under two users gives two tokens (PII-06)', () => {
    const a = deriveIdentifierToken({ tenantKey: 'u1', type: 'folio_number', value: '1234567/89' });
    const b = deriveIdentifierToken({ tenantKey: 'u2', type: 'folio_number', value: '1234567/89' });
    expect(a).not.toBe(b);
  });

  it('is TYPE-BOUND — the same literal string under two categories gives two tokens', () => {
    const a = deriveIdentifierToken({ tenantKey: 'u1', type: 'folio_number', value: 'ABCDE1234F' });
    const b = deriveIdentifierToken({ tenantKey: 'u1', type: 'tax_id', value: 'ABCDE1234F' });
    expect(a).not.toBe(b);
  });

  it('uses an INJECTIVE encoding — no (tenant,type,value) split can be made to collide', () => {
    // Without length-prefixing, ('ab','c',x) and ('a','bc',x) would MAC to
    // the same value. This is the concrete shape of that attack.
    const a = deriveIdentifierToken({ tenantKey: 'ab', type: 'c', value: 'X' });
    const b = deriveIdentifierToken({ tenantKey: 'a', type: 'bc', value: 'X' });
    expect(a).not.toBe(b);
  });

  it('IS GENUINELY KEYED — it is NOT a bare hash of the inputs', () => {
    // The whole security argument rests on this. A folio number, a PAN or a
    // BSB+account are all small enough spaces to enumerate exhaustively, so
    // an unkeyed digest would be trivially reversible and D.6 would be
    // violated while the code still "looked one-way".
    const token = deriveIdentifierToken({ tenantKey: 'u1', type: 'folio_number', value: '1234567/89' });
    const unkeyedCandidates = [
      createHmac('sha256', Buffer.alloc(32)).update('1234567/89').digest('hex'),
      createHmac('sha256', Buffer.alloc(32)).update('u1folio_number123456789').digest('hex'),
    ];
    for (const candidate of unkeyedCandidates) {
      expect(token).not.toContain(candidate.slice(0, 16));
    }
    // Changing ONLY the key must change the output.
    const saved = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'b2'.repeat(32);
    try {
      expect(deriveIdentifierToken({ tenantKey: 'u1', type: 'folio_number', value: '1234567/89' })).not.toBe(token);
    } finally {
      process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = saved;
    }
  });

  it('IS NOT REVERSIBLE — the token carries no encoding of the original value', () => {
    const value = 'RAJESH KUMAR SHARMA';
    const token = deriveIdentifierToken({ tenantKey: 'u1', type: 'person_name_label', value });
    expect(token).not.toContain(value);
    expect(token).not.toContain(value.toLowerCase());
    expect(Buffer.from(token).toString('base64')).not.toContain(Buffer.from(value).toString('base64').slice(0, 12));
    // A one-character change to the input must produce an unrelated token
    // (avalanche) — a token that varied only locally would leak structure.
    const near = deriveIdentifierToken({ tenantKey: 'u1', type: 'person_name_label', value: 'RAJESH KUMAR SHARMB' });
    const body = /:hmac:([a-p]+)\]/.exec(token)![1];
    const nearBody = /:hmac:([a-p]+)\]/.exec(near)![1];
    let sharedPrefix = 0;
    while (sharedPrefix < body.length && body[sharedPrefix] === nearBody[sharedPrefix]) sharedPrefix++;
    expect(sharedPrefix).toBeLessThan(8);
  });

  it('FAILS CLOSED without a key, and on a malformed key — never an unkeyed fallback', () => {
    const saved = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    try {
      delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
      expect(() => deriveIdentifierToken({ tenantKey: 'u1', type: 'tax_id', value: 'X' })).toThrow(/AIE_MASK_TOKEN_ENCRYPTION_KEY/);
      process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'tooshort';
      expect(() => deriveIdentifierToken({ tenantKey: 'u1', type: 'tax_id', value: 'X' })).toThrow(/64-character hex/);
    } finally {
      process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = saved;
    }
  });

  it('refuses an empty tenant key rather than silently minting a cross-user-correlatable token', () => {
    expect(() => deriveIdentifierToken({ tenantKey: '', type: 'tax_id', value: 'X' })).toThrow(/tenantKey is required/);
  });

  it('token body is letters-only, so no masking pattern can re-match a placeholder', () => {
    const token = deriveIdentifierToken({ tenantKey: 'u1', type: 'bank_account', value: '062-000 12345678' });
    expect(token).toMatch(/^\[MASKED:bank_account:hmac:[a-p]{24}\]$/);
    expect(/\d/.test(token.split(':hmac:')[1])).toBe(false);
  });

  it('keeps the pre-existing mask-token shape every downstream consumer already tests against', () => {
    const legacyConsumerShape = /^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i;
    expect(legacyConsumerShape.test(deriveIdentifierToken({ tenantKey: 'u1', type: 'email', value: 'a@b.com' }))).toBe(true);
  });

  it('isOneWayIdentifierToken distinguishes a one-way token from a legacy counter token', () => {
    expect(isOneWayIdentifierToken(deriveIdentifierToken({ tenantKey: 'u1', type: 'email', value: 'a@b.com' }))).toBe(true);
    expect(isOneWayIdentifierToken('[MASKED:tax_id:abcxyz:1]')).toBe(false);
    expect(isOneWayIdentifierToken('not a token')).toBe(false);
  });

  describe('normalisation — stability without over-collapsing', () => {
    it('collapses the separator/case variants of ONE identifier', () => {
      expect(normaliseIdentifierForToken(' 1234567 / 89 ')).toBe(normaliseIdentifierForToken('1234567/89'));
      expect(normaliseIdentifierForToken('Rajesh Kumar Sharma')).toBe(normaliseIdentifierForToken('RAJESH  KUMAR  SHARMA'));
      expect(normaliseIdentifierForToken('1234-5678')).toBe(normaliseIdentifierForToken('12345678'));
    });

    it('does NOT collapse two genuinely different identifiers', () => {
      // Over-normalising is a correctness bug, not a privacy one: it would
      // silently merge two accounts and stay invisible until it did.
      expect(normaliseIdentifierForToken('1234567/89')).not.toBe(normaliseIdentifierForToken('1234567/90'));
      expect(normaliseIdentifierForToken('ABCDE1234F')).not.toBe(normaliseIdentifierForToken('ABCDE1234G'));
    });
  });
});
