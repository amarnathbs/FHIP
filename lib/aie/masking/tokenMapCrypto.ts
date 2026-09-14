/**
 * AIE-1.1 — application-layer encryption for `aie_mask_token_map.ciphertext`
 * (PII-08: "encrypt reversible token maps separately with least-privilege
 * access"). AES-256-GCM via `node:crypto` — no new dependency, matching this
 * codebase's established "no new npm package for something node:crypto
 * already does" convention (see `fileValidation.ts`'s own header).
 *
 * KEY MANAGEMENT (disclosed, not hidden): reads a 32-byte key from
 * `AIE_MASK_TOKEN_ENCRYPTION_KEY` (hex-encoded, 64 hex chars). No such
 * secret exists in any environment today — this is a genuine prerequisite
 * for live use, recorded in AIE_1_1_IMPLEMENTATION.md, not silently assumed
 * present. Functions throw a clear, actionable error if the env var is
 * missing or malformed rather than falling back to an insecure default.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

function loadKey(): Buffer {
  const hex = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'AIE_MASK_TOKEN_ENCRYPTION_KEY is not set or is not a 64-character hex string (32 bytes). ' +
        'This is required before any mask-token-map row can be written — see AIE_1_1_IMPLEMENTATION.md.',
    );
  }
  return Buffer.from(hex, 'hex');
}

/** Returns a single opaque buffer: iv(12) || authTag(16) || ciphertext. */
export function encryptTokenValue(plaintext: string): Buffer {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptTokenValue(blob: Buffer): string {
  const key = loadKey();
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
