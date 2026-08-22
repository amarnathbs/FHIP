/**
 * R7 — Bank CSV Engine: deterministic fingerprints for deduplication (spec
 * sections 34-35).
 */

import { createHash } from 'node:crypto';
import { ECONOMIC_FINGERPRINT_VERSION } from './constants';
import type { NormalizedTransactionCandidate } from './normalize';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Layer 2 (spec 34) — a stable fingerprint of the EXACT source row: which
 * statement it came from, its row index, and its raw field values before any
 * economic interpretation. Detects "the same file re-parsed produced this
 * row again" independent of economic-identity comparison. Deliberately
 * INCLUDES the source row number and raw field text (not just economic
 * fields) — two visually-identical rows at different positions in the same
 * file are still different source rows and must not collide here (economic
 * identity, which SHOULD collide for genuine duplicates, is Layer 3 below).
 */
export function computeSourceRowHash(statementUploadId: string, sourceRowNumber: number, rawRowValues: readonly string[]): string {
  const payload = JSON.stringify([statementUploadId, sourceRowNumber, rawRowValues]);
  return sha256(payload);
}

/**
 * Layer 3 (spec 34-35) — the ECONOMIC identity fingerprint: account + dates
 * + amount + currency + normalised description + reference + balance.
 * DELIBERATELY EXCLUDES statement_upload_id / import batch — the whole point
 * is that the SAME economic transaction re-imported from a different
 * statement (overlap, re-export, renamed file) still fingerprints
 * identically, so cross-import dedup works (spec 35 is explicit: "Do not
 * include import-batch ID in an economic fingerprint").
 *
 * Two genuinely distinct same-day/same-amount purchases (spec 33) are NOT
 * expected to collide here in general, because most real bank exports carry
 * a distinguishing reference or a distinct running balance per row even for
 * back-to-back purchases — but when a source genuinely provides no
 * reference and no balance, two such transactions CAN fingerprint
 * identically. `dedup.ts` never auto-discards on a Layer-3 match alone for
 * that exact reason — see its own header comment.
 */
export function computeEconomicFingerprint(input: {
  financialAccountId: string;
  currencyCode: string;
  transaction: Pick<
    NormalizedTransactionCandidate,
    'transactionDate' | 'valueDate' | 'amountOriginal' | 'creditDebit' | 'descriptionClean' | 'referenceRaw' | 'balanceAfter'
  >;
}): string {
  const t = input.transaction;
  const payload = JSON.stringify([
    input.financialAccountId,
    input.currencyCode,
    t.transactionDate,
    t.valueDate ?? '',
    t.amountOriginal.toFixed(4),
    t.creditDebit,
    t.descriptionClean.toLowerCase(),
    (t.referenceRaw ?? '').toLowerCase(),
    t.balanceAfter !== null ? t.balanceAfter.toFixed(4) : '',
  ]);
  return sha256(payload);
}

export { ECONOMIC_FINGERPRINT_VERSION };
