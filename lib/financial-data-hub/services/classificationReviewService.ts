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
  categoriesRepository,
  duplicateCandidatesRepository,
  recurringTransactionsRepository,
  subcategoriesRepository,
  transactionLinksRepository,
  transactionsRepository,
  userClassificationRulesRepository,
} from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import { correctTransaction } from './bankTransactionActionsService';
import type { FdhRecurringSeriesReviewInput, FdhTransactionLinkReviewInput } from '../validation/transactions';
import type {
  FdhRecurringTransaction,
  FdhRuleActionDefinition,
  FdhRuleMatchDefinition,
  FdhTransactionLink,
  FdhUserClassificationRule,
} from '../domain/types';
import type { FdhUserRuleType } from '../constants/enums';
import { deriveReviewReasons, type ReviewReasonResult } from '../classification/reviewReasons';

export class ClassificationReviewError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state',
    message: string,
  ) {
    super(message);
    this.name = 'ClassificationReviewError';
  }
}

/** Link types this service auto-corrects to `economic_transaction_type =
 * 'transfer'` on confirmation — see `applyTransferClassOnConfirm()` below
 * for why `loan_payment`/`investment_funding` are deliberately excluded. */
const TRANSFER_ECONOMIC_CLASS_LINK_TYPES: ReadonlyArray<FdhTransactionLink['link_type']> = [
  'internal_transfer',
  'credit_card_settlement',
];

const TRANSFER_LINK_TYPE_CATEGORY: Record<'internal_transfer' | 'credit_card_settlement', { categoryKey: string; subcategoryKey: string }> = {
  internal_transfer: { categoryKey: 'transfer_own_account', subcategoryKey: 'internal_transfer' },
  credit_card_settlement: { categoryKey: 'credit_card_payment', subcategoryKey: 'credit_card_bill_payment' },
};

/**
 * FDH-6 (spec sections 20-22, acceptance section 128 — "no income/expense
 * double-counting semantics") — gap closure.
 *
 * FDH-2's own taxonomy seed (migration 0053, `transfer_own_account`
 * category comment) explicitly left this as a forward reference: "A
 * description-pattern MATCH here is a candidate only — actual transfer
 * CONFIRMATION ... is a future engine (FDH-6)." Before this change,
 * confirming a matched transfer link (`reviewTransactionLink`) only moved
 * the LINK row to `confirmed` — the two underlying transactions themselves
 * kept whatever `economic_transaction_type` the engine had already assigned
 * them (almost always `unknown`, since a `flag_candidate` rule never sets
 * one), so a confidently-matched, user-confirmed internal transfer sat in
 * the review queue as UNKNOWN forever unless the user separately corrected
 * BOTH transaction rows by hand. This reuses the EXISTING, already-audited
 * `correctTransaction()` correction path (spec 47) — never a new privileged
 * write — to apply the transfer classification to both sides the moment the
 * user confirms the match, exactly as if they had manually corrected each
 * one, with an honest, traceable `reason` referencing the link.
 *
 * DELIBERATELY NARROW SCOPE. Only `internal_transfer`/`credit_card_settlement`
 * — the two link types with an existing, unambiguous FDH-2
 * `economic_type = 'transfer'` category — are auto-corrected.
 * `loan_payment` (spec section 50: principal/interest cannot be safely split
 * without loan-schedule data this system does not have) and
 * `investment_funding` (spec section 99: FDH-6 must not reach into
 * Investment Intelligence's domain) are left exactly as before — the link
 * itself still moves to `confirmed`, but the transactions are not
 * auto-reclassified, matching the spec's own conservative default of
 * UNKNOWN/review over an invented, unsupported certainty.
 *
 * NEVER OVERWRITES AN EXISTING HUMAN DECISION. A transaction the user has
 * already corrected (`user_override = true`) — for any reason, including
 * one unrelated to this transfer — is skipped, never silently overwritten.
 */
async function applyTransferClassOnConfirm(userId: string, link: FdhTransactionLink): Promise<void> {
  if (!TRANSFER_ECONOMIC_CLASS_LINK_TYPES.includes(link.link_type)) return;
  if (!link.transaction_id_to) return; // an open/missing-counterpart link has only one side to correct

  const mapping = TRANSFER_LINK_TYPE_CATEGORY[link.link_type as 'internal_transfer' | 'credit_card_settlement'];
  const [categoriesResult, subcategoriesResult] = await Promise.all([
    categoriesRepository.listActive(2000),
    subcategoriesRepository.listActive(2000),
  ]);
  const category = (categoriesResult.data ?? []).find((c) => c.category_key === mapping.categoryKey);
  const subcategory = (subcategoriesResult.data ?? []).find(
    (s) => s.subcategory_key === mapping.subcategoryKey && s.category_id === category?.id,
  );
  if (!category) return; // taxonomy row missing — leave the transactions untouched rather than guess

  const reason = `Automatically applied following user confirmation of matched transfer link ${link.id}.`;
  for (const transactionId of [link.transaction_id_from, link.transaction_id_to]) {
    const { data: txn } = await transactionsRepository.getForUser(userId, transactionId);
    if (!txn || txn.user_override) continue; // never overwrite an existing human decision
    await correctTransaction(userId, transactionId, { field_name: 'economic_transaction_type', corrected_value: 'transfer', reason });
    await correctTransaction(userId, transactionId, { field_name: 'category_id', corrected_value: category.id, reason });
    if (subcategory) {
      await correctTransaction(userId, transactionId, { field_name: 'subcategory_id', corrected_value: subcategory.id, reason });
    }
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

  if (input.decision === 'confirm') {
    await applyTransferClassOnConfirm(userId, (updated ?? link) as FdhTransactionLink);
  }

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

const TRANSFER_LIKE_LINK_TYPES: ReadonlyArray<FdhTransactionLink['link_type']> = [
  'internal_transfer',
  'credit_card_settlement',
  'investment_funding',
  'loan_payment',
];
const REFUND_LIKE_LINK_TYPES: ReadonlyArray<FdhTransactionLink['link_type']> = ['refund_original', 'reversal_original'];

/**
 * FDH-6 (spec section 64, gap G1) — explains WHY one of the caller's own
 * transactions is (or would be) in review, using only already-persisted
 * signals. RLS-scoped reads only (`.eq('user_id', userId)` throughout via
 * the generic repositories) — structurally incapable of reading another
 * tenant's transaction, links or duplicate candidates.
 */
export async function explainTransactionReviewReasons(
  userId: string,
  transactionId: string,
): Promise<ReviewReasonResult> {
  const { data: txn } = await transactionsRepository.getForUser(userId, transactionId);
  if (!txn) throw new ClassificationReviewError('not_found', 'transaction not found');

  const [linksResult, duplicatesResult] = await Promise.all([
    transactionLinksRepository.listForUserAll(userId),
    duplicateCandidatesRepository.listForUserAll(userId),
  ]);
  const links = (linksResult.data ?? []).filter(
    (l) => l.transaction_id_from === transactionId || l.transaction_id_to === transactionId,
  );
  const duplicates = duplicatesResult.data ?? [];

  const openTransferLinkExists = links.some(
    (l) =>
      l.transaction_id_from === transactionId
      && l.transaction_id_to === null
      && l.status === 'pending'
      && TRANSFER_LIKE_LINK_TYPES.includes(l.link_type),
  );
  const pendingTransferLinkExists = links.some(
    (l) => l.transaction_id_to !== null && l.status === 'pending' && TRANSFER_LIKE_LINK_TYPES.includes(l.link_type),
  );
  const pendingRefundLinkExists = links.some(
    (l) => l.status === 'pending' && REFUND_LIKE_LINK_TYPES.includes(l.link_type),
  );
  const pendingDuplicateCandidateExists = duplicates.some(
    (d) => d.status === 'pending' && (d.transaction_id_a === transactionId || d.transaction_id_b === transactionId),
  );

  return deriveReviewReasons({
    reviewStatus: txn.review_status,
    economicTransactionType: txn.economic_transaction_type,
    classificationConfidence: txn.classification_confidence,
    openTransferLinkExists,
    pendingTransferLinkExists,
    pendingDuplicateCandidateExists,
    pendingRefundLinkExists,
  });
}
