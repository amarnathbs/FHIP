/**
 * R7 — Bank CSV Engine: user actions on canonical transactions (spec
 * sections 36, 47, 51-52, 82).
 *
 * SAME-USER FORGERY BOUNDARY. Every write here goes through the ordinary
 * RLS-scoped repositories (`user_id` injected from the session, `with check`
 * enforced at the database) — never the service-role client. A user may only
 * touch a `fdh_duplicate_candidates` row or `fdh_transactions` row they
 * already own, and the fields below are the ONLY ones these functions ever
 * write: `dedup_status`/`fdh_duplicate_candidates.status`/`user_resolution`
 * for a resolution, and the single named field for a correction. Neither
 * function ever accepts or writes `certification_status`,
 * `reconciliation_status`, `extraction_confidence`, `parser_id`/
 * `parser_version_id`, or any other authoritative provenance field — those
 * remain reachable only from the server-side processing service.
 */

import {
  duplicateCandidatesRepository,
  transactionCorrectionsRepository,
  transactionsRepository,
} from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import type { BankTransactionCorrectionInput, BankTransactionDuplicateResolutionInput } from '../validation/bankCsv';
import type { FdhTransaction } from '../domain/types';

export class BankTransactionActionError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid_state',
    message: string,
  ) {
    super(message);
    this.name = 'BankTransactionActionError';
  }
}

/**
 * The per-side `fdh_transactions.dedup_status` outcome for a duplicate-pair
 * resolution (FDH8 closure fix, 2026-08-25 — real live-DEV finding).
 *
 * `computeApprovedFinancialSummary` (`domain/approvedSummary.ts`) excludes
 * EVERY row whose dedup_status is 'user_confirmed_duplicate' from every
 * total, unconditionally, by design. Marking BOTH sides of a resolved pair
 * with the same status (the pre-fix behaviour) therefore made a resolved
 * pair contribute $0 to every total instead of the kept transaction's
 * amount exactly once — reproduced live: a $6.50 duplicate pair resolved
 * as 'removed_b' produced $0.00 approved expense instead of $6.50 (see
 * `docs/financial-data-hub/FDH8_LIVE_DEV_CERTIFICATION.md`, Case 4).
 *
 * Exported as a pure function so this mapping is directly unit-testable
 * without mocking the Supabase query-builder chain — see
 * `tests/unit/fdh7DuplicateResolutionDedupStatus.test.ts`.
 */
export function resolveDedupStatusPerSide(
  resolution: BankTransactionDuplicateResolutionInput['resolution'],
): { a: 'user_confirmed_distinct' | 'user_confirmed_duplicate'; b: 'user_confirmed_distinct' | 'user_confirmed_duplicate' } {
  if (resolution === 'kept_both') return { a: 'user_confirmed_distinct', b: 'user_confirmed_distinct' };
  if (resolution === 'removed_a') return { a: 'user_confirmed_duplicate', b: 'user_confirmed_distinct' };
  // 'removed_b' | 'merged' — the schema has no third dedup_status to
  // represent "merged"; transaction_id_a is treated as the surviving
  // (kept, counted) side and transaction_id_b as absorbed (excluded),
  // since the schema does not distinguish which side of a merge is
  // canonical.
  return { a: 'user_confirmed_distinct', b: 'user_confirmed_duplicate' };
}

/**
 * Resolves a duplicate-candidate PAIR (spec 36, 54). `transactionId` must be
 * one of the two sides of the named candidate — this is what stops a user
 * resolving a candidate pair they are not actually party to, even if they
 * somehow learned its id.
 */
export async function resolveDuplicateCandidate(
  userId: string,
  transactionId: string,
  input: BankTransactionDuplicateResolutionInput,
): Promise<void> {
  const { data: candidate } = await duplicateCandidatesRepository.getForUser(userId, input.duplicate_candidate_id);
  if (!candidate) throw new BankTransactionActionError('not_found', 'duplicate candidate not found');
  if (candidate.transaction_id_a !== transactionId && candidate.transaction_id_b !== transactionId) {
    throw new BankTransactionActionError('forbidden', 'this transaction is not part of the named duplicate candidate');
  }
  if (candidate.status !== 'pending') {
    throw new BankTransactionActionError('invalid_state', 'this duplicate candidate has already been resolved');
  }

  const newStatus = input.resolution === 'kept_both' ? 'not_duplicate' : 'confirmed_duplicate';
  const { error: candidateUpdateError } = await duplicateCandidatesRepository.update(userId, candidate.id, {
    status: newStatus,
    user_resolution: input.resolution,
    resolved_at: new Date().toISOString(),
  } as never);
  // A failed write here (e.g. the DB's own status-transition guard
  // rejecting an unexpected prior state) must never be swallowed into a
  // false "resolved: true" response (FDH8 closure finding, 2026-08-25) —
  // this is the same class of defect this whole program treats as
  // financial-integrity-relevant: an action reporting success while the
  // actual row was left unchanged.
  if (candidateUpdateError) {
    throw new BankTransactionActionError('invalid_state', `could not update duplicate candidate: ${candidateUpdateError.message}`);
  }

  const perSideStatus = resolveDedupStatusPerSide(input.resolution);
  for (const [side, txnId] of [['a', candidate.transaction_id_a], ['b', candidate.transaction_id_b]] as const) {
    const { error: txnUpdateError } = await transactionsRepository.update(userId, txnId, { dedup_status: perSideStatus[side] } as never);
    if (txnUpdateError) {
      throw new BankTransactionActionError('invalid_state', `could not update transaction dedup status: ${txnUpdateError.message}`);
    }
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'transaction_duplicate_resolved',
    actorType: 'user',
    actorId: userId,
    metadata: { resolution: input.resolution },
  });
}

/**
 * Layers a user correction over one normalised field of an owned transaction
 * (spec 47). Preserves the previous value in `fdh_transaction_corrections`
 * before applying the new one to `fdh_transactions`, and marks
 * `user_override = true` so a future reprocessing run never silently
 * overwrites a confirmed human decision.
 */
export async function correctTransaction(
  userId: string,
  transactionId: string,
  input: BankTransactionCorrectionInput,
): Promise<FdhTransaction> {
  const { data: transaction } = await transactionsRepository.getForUser(userId, transactionId);
  if (!transaction) throw new BankTransactionActionError('not_found', 'transaction not found');

  const previousValue = (transaction as unknown as Record<string, unknown>)[input.field_name] ?? null;

  const { error: correctionCreateError } = await transactionCorrectionsRepository.create(userId, {
    transaction_id: transactionId,
    field_name: input.field_name,
    previous_value: previousValue,
    corrected_value: input.corrected_value ?? null,
    reason: input.reason ?? null,
    corrected_at: new Date().toISOString(),
  } as never);
  // Same financial-integrity-relevant fix as resolveDuplicateCandidate()
  // above (FDH8 closure finding, 2026-08-25) — a failed audit-trail write
  // or a failed field update must never be silently swallowed into an
  // apparently-successful response that actually returns the transaction's
  // STALE, uncorrected data.
  if (correctionCreateError) {
    throw new BankTransactionActionError('invalid_state', `could not record correction: ${correctionCreateError.message}`);
  }

  const { data: updated, error: updateError } = await transactionsRepository.update(userId, transactionId, {
    [input.field_name]: input.corrected_value,
    user_override: true,
    review_status: 'resolved',
  } as never);
  if (updateError || !updated) {
    throw new BankTransactionActionError('invalid_state', `could not apply correction: ${updateError?.message ?? 'no row returned'}`);
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: transaction.statement_upload_id,
    eventType: 'transaction_corrected',
    actorType: 'user',
    actorId: userId,
    metadata: { field_name: input.field_name },
  });

  return updated as FdhTransaction;
}
