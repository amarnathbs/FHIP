// Module 11.3 — pack identity fingerprint (spec section 9).
//
// Deterministic across process restarts and across two independent
// concurrent callers computing it for the same inputs — that determinism is
// what lets the idempotency key collapse duplicate concurrent generation
// requests (spec sections 10, 67, 113) into the SAME logical request at
// Module 11.1's already-certified ai_admit_request() advisory-lock layer,
// without inventing a second locking mechanism.

import { createHash } from 'node:crypto';
import type { PackIdentity } from '@/lib/ai/insightPack/types';

export function computePackIdentityHash(identity: PackIdentity): string {
  const canonical = [
    identity.userId,
    identity.snapshotId,
    identity.financialContextHash,
    identity.contextSchemaVersion,
    identity.packSchemaVersion,
    identity.promptCode,
    String(identity.promptVersion),
    identity.countryContext ?? '~',
    identity.language,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/** The idempotency key passed to ai_admit_request() — namespaced so it can never collide with a custom-question idempotency key from a different feature. */
export function packIdempotencyKey(identity: PackIdentity): string {
  return `insight-pack:${computePackIdentityHash(identity)}`;
}
