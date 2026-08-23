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
  await duplicateCandidatesRepository.update(userId, candidate.id, {
    status: newStatus,
    user_resolution: input.resolution,
    resolved_at: new Date().toISOString(),
  } as never);

  const newDedupStatus = input.resolution === 'kept_both' ? 'user_confirmed_distinct' : 'user_confirmed_duplicate';
  for (const txnId of [candidate.transaction_id_a, candidate.transaction_id_b]) {
    await transactionsRepository.update(userId, txnId, { dedup_status: newDedupStatus } as never);
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

  await transactionCorrectionsRepository.create(userId, {
    transaction_id: transactionId,
    field_name: input.field_name,
    previous_value: previousValue,
    corrected_value: input.corrected_value ?? null,
    reason: input.reason ?? null,
    corrected_at: new Date().toISOString(),
  } as never);

  const { data: updated } = await transactionsRepository.update(userId, transactionId, {
    [input.field_name]: input.corrected_value,
    user_override: true,
    review_status: 'resolved',
  } as never);

  await recordDocumentAuditEvent({
    userId,
    documentId: transaction.statement_upload_id,
    eventType: 'transaction_corrected',
    actorType: 'user',
    actorId: userId,
    metadata: { field_name: input.field_name },
  });

  return (updated ?? transaction) as FdhTransaction;
}
