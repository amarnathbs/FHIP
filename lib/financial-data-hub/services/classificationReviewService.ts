/**
 * R8 — Transaction Categorisation & Merchant Intelligence: user review
 * actions (spec sections 32, 46-48, 53, 61).
 *
 * Every write here goes through the ordinary RLS-scoped repositories —
 * NEVER the service-role client — because each function performs exactly
 * one of the narrow legitimate transitions migration 0067's triggers permit
 * the authenticated role to make directly: a transfer link moving
 * `pending -> confirmed/rejected`, or a recurring series moving
 * `candidate -> active` / `active <-> paused` / `* -> ended`. Anything
 * outside those transitions is rejected at the database, not merely by this
 * service — this file's own validation exists so the user sees a clear
 * error rather than a raw Postgres exception.
 */

import {
  recurringTransactionsRepository,
  transactionLinksRepository,
  userClassificationRulesRepository,
} from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import type { FdhRecurringSeriesReviewInput, FdhTransactionLinkReviewInput } from '../validation/transactions';
import type {
  FdhRecurringTransaction,
  FdhRuleActionDefinition,
  FdhRuleMatchDefinition,
  FdhTransactionLink,
  FdhUserClassificationRule,
} from '../domain/types';
import type { FdhUserRuleType } from '../constants/enums';

export class ClassificationReviewError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state',
    message: string,
  ) {
    super(message);
    this.name = 'ClassificationReviewError';
  }
}

/** Confirms or rejects a proposed transfer/settlement/refund/reversal link
 * (spec section 32/61). The row must currently be `pending` — a link
 * already resolved, or superseded, cannot be re-decided through this path. */
export async function reviewTransactionLink(
  userId: string,
  linkId: string,
  input: FdhTransactionLinkReviewInput,
): Promise<FdhTransactionLink> {
  const { data: link } = await transactionLinksRepository.getForUser(userId, linkId);
  if (!link) throw new ClassificationReviewError('not_found', 'transaction link not found');
  if (link.status !== 'pending') {
    throw new ClassificationReviewError('invalid_state', 'this link has already been reviewed');
  }

  const newStatus = input.decision === 'confirm' ? 'confirmed' : 'rejected';
  const { data: updated } = await transactionLinksRepository.update(userId, linkId, {
    status: newStatus,
    user_confirmed: input.decision === 'confirm',
  } as never);

  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'transaction_link_reviewed',
    actorType: 'user',
    actorId: userId,
    metadata: { link_id: linkId, decision: input.decision },
  });

  return (updated ?? link) as FdhTransactionLink;
}

const ALLOWED_SERIES_TRANSITIONS: Record<string, Record<FdhRecurringSeriesReviewInput['decision'], string | null>> = {
  candidate: { confirm: 'active', pause: null, resume: null, end: 'ended' },
  active: { confirm: null, pause: 'paused', resume: null, end: 'ended' },
  paused: { confirm: null, pause: null, resume: 'active', end: 'ended' },
  ended: { confirm: null, pause: null, resume: null, end: null },
};

/** Confirms, pauses, resumes or ends a detected recurring series (spec
 * section 53/61). Mirrors the exact transitions migration 0067's trigger
 * permits — attempting an unsupported transition (e.g. "pause" a candidate)
 * is rejected here with a clear message rather than reaching the database
 * and surfacing a raw constraint error. */
export async function reviewRecurringSeries(
  userId: string,
  recurringId: string,
  input: FdhRecurringSeriesReviewInput,
): Promise<FdhRecurringTransaction> {
  const { data: series } = await recurringTransactionsRepository.getForUser(userId, recurringId);
  if (!series) throw new ClassificationReviewError('not_found', 'recurring series not found');

  const nextStatus = ALLOWED_SERIES_TRANSITIONS[series.status]?.[input.decision] ?? null;
  if (!nextStatus) {
    throw new ClassificationReviewError(
      'invalid_state',
      `cannot "${input.decision}" a series currently in status "${series.status}"`,
    );
  }

  const patch: Record<string, unknown> = { status: nextStatus };
  if (input.decision === 'confirm') patch.user_confirmed = true;

  const { data: updated } = await recurringTransactionsRepository.update(userId, recurringId, patch as never);

  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'recurring_series_reviewed',
    actorType: 'user',
    actorId: userId,
    metadata: { recurring_id: recurringId, decision: input.decision },
  });

  return (updated ?? series) as FdhRecurringTransaction;
}

/**
 * R8 spec section 47: "A correction may optionally become a reusable
 * personal rule only through deliberate user action." Never called
 * automatically from `correctTransaction()` — a caller must invoke this
 * explicitly, naming the exact rule the user wants to create. Writes only
 * to `fdh_user_classification_rules` (own rows) — structurally incapable of
 * touching `fdh_merchants`/`fdh_classification_rules` (the authenticated
 * role has no INSERT/UPDATE policy on either).
 */
export async function createPersonalClassificationRule(
  userId: string,
  input: {
    rule_type: FdhUserRuleType;
    match_definition: FdhRuleMatchDefinition;
    action_definition: FdhRuleActionDefinition;
    priority?: number;
  },
): Promise<FdhUserClassificationRule> {
  const { data: created, error } = await userClassificationRulesRepository.create(userId, {
    rule_type: input.rule_type,
    match_definition: input.match_definition,
    action_definition: input.action_definition,
    priority: input.priority ?? 100,
    active: true,
  } as never);
  if (error || !created) {
    throw new ClassificationReviewError('invalid_state', error?.message ?? 'could not create personal rule');
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'personal_rule_created',
    actorType: 'user',
    actorId: userId,
    metadata: { rule_type: input.rule_type },
  });

  return created;
}
