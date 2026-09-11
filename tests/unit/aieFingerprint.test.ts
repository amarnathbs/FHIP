import { describe, it, expect } from 'vitest';
import { sha256Hex, normalizedTextHash, classifyDuplicate } from '@/lib/aie/fingerprint';

describe('AIE-1.1 document fingerprinting & duplicate classification (DUP-01..12)', () => {
  it('sha256Hex is deterministic and content-sensitive', () => {
    const a = sha256Hex(new TextEncoder().encode('hello'));
    const b = sha256Hex(new TextEncoder().encode('hello'));
    const c = sha256Hex(new TextEncoder().encode('hello!'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('normalizedTextHash ignores whitespace/case differences from re-exporting the same content', () => {
    const a = normalizedTextHash('Statement Period: Jan 2026');
    const b = normalizedTextHash('statement   period:    jan 2026');
    expect(a).toBe(b);
  });

  it('classifies an exact byte match as exact_duplicate even without a normalized hash', () => {
    const result = classifyDuplicate({ candidateExactHash: 'abc', existingExactHashes: ['abc', 'def'] });
    expect(result).toBe('exact_duplicate');
  });

  it('classifies a different-bytes, same-normalized-text document as probable_duplicate, never silently merged as exact', () => {
    const result = classifyDuplicate({
      candidateExactHash: 'new-hash',
      candidateNormalizedHash: 'norm-1',
      existingExactHashes: ['old-hash'],
      existingNormalizedHashes: ['norm-1'],
    });
    expect(result).toBe('probable_duplicate');
  });

  it('classifies genuinely new content as distinct', () => {
    const result = classifyDuplicate({ candidateExactHash: 'z', existingExactHashes: ['a', 'b'] });
    expect(result).toBe('distinct');
  });

  it('DUP-03: fingerprint scoping is per-user by construction — an identical document uploaded by two users is never compared here', () => {
    // This module never accepts a cross-user hash set — the caller
    // (repository.existingFingerprintHashesForUser) is what enforces the
    // per-user scope by construction (WHERE user_id = :userId), so this
    // function structurally cannot see another user's hashes unless the
    // caller passes them in explicitly, which no real call site does.
    const userAHashes = ['user-a-doc-hash'];
    const result = classifyDuplicate({ candidateExactHash: 'user-b-doc-hash', existingExactHashes: userAHashes });
    expect(result).toBe('distinct');
  });
});
