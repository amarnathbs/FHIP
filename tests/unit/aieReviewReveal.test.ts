import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { revealMaskedToken, type RevealDeps } from '@/lib/aie/review/reveal';
import { encryptTokenValue, decryptTokenValue } from '@/lib/aie/masking/tokenMapCrypto';
import type { AieRunRow } from '@/lib/aie/db/repository';

const TEST_KEY = '0'.repeat(64); // 32-byte hex — matches tokenMapCrypto.ts's own expected shape.

function baseRun(): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString() };
}

describe('AIE-1.5 reveal.ts — revealMaskedToken (EVID-04/06/10, MASK-01..12)', () => {
  const originalKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it('rejects a malformed token shape without ever touching the database (defense in depth before the query)', async () => {
    let lookupCalled = false;
    const deps: RevealDeps = {
      getRunForUser: async () => baseRun(),
      findMaskTokenCiphertext: async () => {
        lookupCalled = true;
        return null;
      },
      decrypt: (b) => b.toString('utf8'),
      audit: async () => {},
    };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token: 'not-a-real-token', actorId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(lookupCalled).toBe(false);
  });

  it('EVID-04/PRIV-06: forbidden when the run does not belong to the caller (IDOR)', async () => {
    const deps: RevealDeps = {
      getRunForUser: async () => null,
      findMaskTokenCiphertext: async () => Buffer.from('x'),
      decrypt: (b) => b.toString('utf8'),
      audit: async () => {},
    };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'attacker', token: '[MASKED:tax_id:abcxyz:1]', actorId: 'attacker' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('not_found when the token is well-formed but no ciphertext exists for THIS run (never fabricated)', async () => {
    const deps: RevealDeps = {
      getRunForUser: async () => baseRun(),
      findMaskTokenCiphertext: async () => null,
      decrypt: (b) => b.toString('utf8'),
      audit: async () => {},
    };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token: '[MASKED:tax_id:abcxyz:1]', actorId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('decrypts and returns the real value via the REAL tokenMapCrypto round-trip, and audits the reveal WITHOUT the plaintext value', async () => {
    const ciphertext = encryptTokenValue('123-456-789');
    const auditedEvents: Record<string, unknown>[] = [];
    const deps: RevealDeps = {
      getRunForUser: async () => baseRun(),
      findMaskTokenCiphertext: async (runId, token) => {
        expect(runId).toBe('run-1');
        expect(token).toBe('[MASKED:tax_id:abcxyz:1]');
        return ciphertext;
      },
      decrypt: decryptTokenValue,
      audit: async (e) => {
        auditedEvents.push(e as unknown as Record<string, unknown>);
      },
    };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token: '[MASKED:tax_id:abcxyz:1]', actorId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: true, value: '123-456-789' });
    expect(auditedEvents).toHaveLength(1);
    expect(JSON.stringify(auditedEvents[0])).not.toContain('123-456-789');
    expect((auditedEvents[0] as { eventType: string }).eventType).toBe('evidence_revealed');
  });
});
