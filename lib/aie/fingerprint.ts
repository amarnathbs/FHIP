/**
 * AIE-1.1 — document fingerprinting & duplicate classification (DUP-01..12).
 *
 * Pure functions here; the actual per-user uniqueness constraint lives on
 * `aie_document_fingerprint (user_id, exact_sha256)` in migration 0140 — the
 * database is the real source of truth for "has this exact user uploaded
 * this exact document before", not application logic (matching this
 * repository's established division of labour between DB constraints and
 * TypeScript-enforced transitions).
 */

import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A privacy-safe, coarse "same content, re-exported" signal (DUP-02): hash
 * of whitespace-normalised extracted text, NOT of raw bytes. Deliberately
 * advisory only (DUP-04: "do not treat equal page text as proof of equal
 * ownership or canonical destination") — callers must never auto-merge
 * documents on this signal alone, only surface it as a probable-duplicate
 * candidate for downstream (adapter/reviewer) judgement.
 */
export function normalizedTextHash(extractedText: string): string {
  const normalized = extractedText.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

export type DuplicateClassification =
  | 'exact_duplicate'
  | 'probable_duplicate'
  | 'distinct';

/**
 * DUP-05: "differentiate exact re-upload vs same-doc-metadata-changed vs
 * same-period-different-content." This function only classifies; it never
 * decides what to DO about a duplicate (that stays an adapter/orchestrator
 * decision per DUP-06: "return existing result only when authorization/
 * lifecycle permit").
 */
export function classifyDuplicate(input: {
  candidateExactHash: string;
  candidateNormalizedHash?: string;
  existingExactHashes: readonly string[];
  existingNormalizedHashes?: readonly string[];
}): DuplicateClassification {
  if (input.existingExactHashes.includes(input.candidateExactHash)) return 'exact_duplicate';
  if (
    input.candidateNormalizedHash &&
    input.existingNormalizedHashes?.includes(input.candidateNormalizedHash)
  ) {
    return 'probable_duplicate';
  }
  return 'distinct';
}
