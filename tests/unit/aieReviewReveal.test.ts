import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { revealMaskedToken, type RevealDeps } from '@/lib/aie/review/reveal';
import { deriveIdentifierToken } from '@/lib/aie/masking/identifierToken';
import { maskText } from '@/lib/aie/masking/piiMasking';
import type { AieRunRow } from '@/lib/aie/db/repository';

const TEST_KEY = 'a1'.repeat(32);

function baseRun(): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString() };
}

/**
 * M3 (Phase 4) — this suite USED to assert that `revealMaskedToken` decrypted
 * `aie_mask_token_map.ciphertext` and handed the user back their original
 * value. The Product Owner's 2026-09-15 decision removed that capability
 * (one-way HMAC, no reveal), so those assertions are not "adjusted" — the
 * behaviour they described no longer exists, and the tests now assert the
 * replacement behaviour, including that the decrypt path is gone rather than
 * merely switched off.
 */
describe('M3 — revealMaskedToken always refuses (PO decision 2026-09-15: one-way HMAC, no reveal)', () => {
  const originalKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it('rejects a malformed token shape without touching the run at all (no existence oracle)', async () => {
    let runLookedUp = false;
    const deps: RevealDeps = {
      getRunForUser: async () => {
        runLookedUp = true;
        return baseRun();
      },
      audit: async () => {},
    };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token: 'not-a-real-token', actorId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect(runLookedUp).toBe(false);
  });

  it('PRIV-06: forbidden when the run does not belong to the caller, and writes NO audit row for a stranger', async () => {
    const audited: unknown[] = [];
    const deps: RevealDeps = {
      getRunForUser: async () => null,
      audit: async (e) => {
        audited.push(e);
      },
    };
    const token = deriveIdentifierToken({ tenantKey: 'user-1', type: 'tax_id', value: 'ABCDE1234F' });
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'attacker', token, actorId: 'attacker' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'forbidden' });
    expect(audited).toHaveLength(0);
  });

  it('refuses a genuine one-way token with the typed reason, and audits the REFUSAL carrying no value', async () => {
    const audited: Record<string, unknown>[] = [];
    const deps: RevealDeps = {
      getRunForUser: async () => baseRun(),
      audit: async (e) => {
        audited.push(e as unknown as Record<string, unknown>);
      },
    };
    const token = deriveIdentifierToken({ tenantKey: 'user-1', type: 'folio_number', value: '1234567/89' });
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token, actorId: 'user-1' }, deps);

    expect(outcome).toEqual({ ok: false, reason: 'not_revealable_one_way_masking' });
    expect(audited).toHaveLength(1);
    expect((audited[0] as { eventType: string }).eventType).toBe('evidence_reveal_refused_one_way_masking');
    // The refusal audit must carry the opaque token and never the value.
    expect(JSON.stringify(audited[0])).toContain(token);
    expect(JSON.stringify(audited[0])).not.toContain('1234567/89');
    expect((audited[0] as { metadata: { one_way_token: boolean } }).metadata.one_way_token).toBe(true);
  });

  it('refuses a legacy-shaped token too — there is no surviving path that reveals anything', async () => {
    const deps: RevealDeps = { getRunForUser: async () => baseRun(), audit: async () => {} };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token: '[MASKED:tax_id:abcxyz:1]', actorId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'not_revealable_one_way_masking' });
  });

  it('STRUCTURAL: the reveal dependency surface has no decrypt or ciphertext-lookup member left to wire', async () => {
    // A behavioural test can only show the current code refuses. This one
    // shows the capability was REMOVED rather than gated: if someone
    // reintroduces a `decrypt` or `findMaskTokenCiphertext` dependency, the
    // default deps object grows a key and this fails.
    const { createDefaultRevealDeps } = await import('@/lib/aie/review/reveal');
    expect(Object.keys(createDefaultRevealDeps()).sort()).toEqual(['audit', 'getRunForUser']);
    // The reversible-crypto module is DELETED, not merely unreferenced. The
    // specifier is built at runtime so TypeScript cannot resolve (and
    // therefore cannot fail to compile) a path that intentionally no longer
    // exists; the assertion is about the file system, not the type graph.
    const deletedModule = ['@/lib/aie/masking', 'tokenMapCrypto'].join('/');
    await expect(import(/* @vite-ignore */ deletedModule)).rejects.toThrow();
  });

  it('END-TO-END: a value masked by the real engine cannot be recovered through the real reveal path', async () => {
    const masked = maskText('Folio No: 9988776/11', { tenantKey: 'user-1' });
    const token = /\[MASKED:folio_number:[^\]]+\]/.exec(masked.maskedText)![0];
    const deps: RevealDeps = { getRunForUser: async () => baseRun(), audit: async () => {} };
    const outcome = await revealMaskedToken({ runId: 'run-1', userId: 'user-1', token, actorId: 'user-1' }, deps);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('9988776/11');
  });
});
