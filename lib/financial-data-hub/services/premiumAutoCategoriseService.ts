/**
 * Premium automatic categorisation of one imported bank statement (PO 05-11-2026): "do it directly through AI with masked personal details ... show
 * the user, no need to approve anything; if the user finds an issue they can edit and make the change".
 *
 * NOT A NEW APPROVAL ENGINE and NOT A NEW AI PATH. It composes the existing, certified pieces in this order, and each keeps its own gates:
 *   1. the feature flag (AIE_BANK_AUTO_CATEGORISE_ENABLED, default OFF) and the person's ACTIVE Premium entitlement -- checked again on every call;
 *   2. the AI step (bankAiCategoriseService) in best-guess mode: money OUT to businesses only, masked and digit-free, behind the AI flag, the shared
 *      kill switch, the real malware scan, masking and the per-user daily cost cap. If any of those refuse, the run simply carries on without the AI;
 *   3. fixed answers for the lines the AI may never see (payments to and from people -- domain/premiumAutoCategorise.ts);
 *   4. approval of every still-pending line that sits in a category total, through FDH-7's `bulkApproveTransactions` (the RPC pre-check and the DB
 *      guard trigger still re-validate each line), recorded with actor 'system' so the trail can tell it from a person's click;
 *   5. completion of the statement through the existing `approveStatement` cascade when nothing is left.
 *
 * WHAT IT NEVER APPROVES (the lines the manual review lists as "needs your decision"): a possible duplicate, a pending refund or transfer match, any
 * other blocking check, a proposed amount at or above the large-amount threshold, and any line that is still uncategorised. Those wait for the person.
 *
 * ONE RUN PER STATEMENT. A 'started' marker is written first; a later call (a second tab, a reload) finds it and does nothing. After the person
 * clicks Undo the run does not start again by itself.
 *
 * UNDO withdraws every approval on the statement (the lines keep their categories) -- the same state the manual flow starts from. A finished statement
 * goes through the existing `reopenStatement`; an unfinished one through the same shared revert.
 */

import { createClient } from '@/lib/supabase/server';
import { isAieBankAutoCategoriseEnabled } from '@/lib/aie/adapters/bankCategorise/featureFlags';
import { resolvePremiumAiAccess, type PremiumAiAccessDeps } from '@/lib/ai/access/premiumAiAccess';
import { categoriesRepository, subcategoriesRepository } from '../repositories';
import {
  AUTO_SOURCE,
  AUTO_UNDO_SOURCE,
  emptyAutoSummary,
  planFixedPlacements,
  readAutoState,
  summaryBucket,
  type AuditEventRow,
  type AutoRunSummary,
} from '../domain/premiumAutoCategorise';
import { reopenStatement, revertStatementTransactionApprovals, bulkApproveTransactions, ApprovalError } from './approvalService';
import { recordDocumentAuditEvent } from './auditLog';
import { aiCategoriseStatement, type AiCategoriseDeps, type AiCategoriseResult } from './bankAiCategoriseService';
import { CategoryReviewError, finaliseStatementIfComplete, getStatementCategoryReview, settlePendingLinksForGroup } from './categoryReviewService';
import { recordAiProposals, type AiProposalItem } from './transactionClassificationService';
import type { FdhEconomicTransactionType } from '../constants/enums';

export type AutoCategoriseStatus = 'disabled' | 'premium_required' | 'already_ran' | 'done';

export interface AutoCategoriseState {
  /** The feature flag is on. When false the screen shows nothing and calls nothing. */
  enabled: boolean;
  /** Flag on, Premium, the statement is open and the run has not started before: the screen may start it. */
  eligible: boolean;
  /** The latest finished run that has not been undone (null when none). */
  summary: AutoRunSummary | null;
}

export interface AutoCategoriseResult {
  status: AutoCategoriseStatus;
  summary: AutoRunSummary | null;
  ai: Pick<AiCategoriseResult, 'status' | 'reason' | 'calls' | 'proposed_lines' | 'estimated_cost_usd'> | null;
}

export interface AutoCategoriseDeps {
  /** Test seam for the Premium entitlement read; production never sets it. */
  entitlementDeps?: PremiumAiAccessDeps;
  /** Test seams passed through to the AI step; production never sets them. */
  ai?: Pick<AiCategoriseDeps, 'entitlementDeps' | 'request' | 'maxCalls'>;
}

interface StatementRow {
  id: string;
  approved_by: string | null;
}

async function loadOwnStatement(userId: string, statementId: string): Promise<StatementRow> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_statement_uploads')
    .select('id, approved_by')
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle<StatementRow>();
  if (error) throw new CategoryReviewError('invalid_state', 'We could not load this statement.');
  if (!data) throw new CategoryReviewError('not_found', 'This statement was not found.');
  return data;
}

async function loadAutoEvents(userId: string, statementId: string): Promise<AuditEventRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_document_audit_events')
    .select('event_type, created_at, metadata')
    .eq('user_id', userId)
    .eq('document_id', statementId)
    .in('event_type', ['transaction_classification_run', 'bulk_review_action_completed'])
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new CategoryReviewError('invalid_state', 'We could not load this statement.');
  return (data ?? []) as AuditEventRow[];
}

/** What the screen needs on load. Cheap: one statement read, one audit read and (only when the flag is on) one entitlement read. */
export async function getAutoCategoriseState(userId: string, statementId: string, deps: AutoCategoriseDeps = {}): Promise<AutoCategoriseState> {
  if (!isAieBankAutoCategoriseEnabled()) return { enabled: false, eligible: false, summary: null };
  const statement = await loadOwnStatement(userId, statementId);
  const state = readAutoState(await loadAutoEvents(userId, statementId));
  const access = await resolvePremiumAiAccess(userId, 'fdh_bank_auto_categorise', deps.entitlementDeps);
  return {
    enabled: true,
    eligible: access.allowed && !state.ran && !statement.approved_by,
    summary: access.allowed ? state.summary : null,
  };
}

/** Categorises and counts one of the person's own statements. See the header. */
export async function runAutoCategorise(userId: string, statementId: string, deps: AutoCategoriseDeps = {}): Promise<AutoCategoriseResult> {
  if (!isAieBankAutoCategoriseEnabled()) return { status: 'disabled', summary: null, ai: null };
  const statement = await loadOwnStatement(userId, statementId);
  const access = await resolvePremiumAiAccess(userId, 'fdh_bank_auto_categorise', deps.entitlementDeps);
  if (!access.allowed) return { status: 'premium_required', summary: null, ai: null };
  if (readAutoState(await loadAutoEvents(userId, statementId)).ran || statement.approved_by) return { status: 'already_ran', summary: null, ai: null };

  // The marker goes first: a second tab or a reload finds it and does nothing.
  await recordDocumentAuditEvent({
    userId, documentId: statementId, eventType: 'transaction_classification_run', actorType: 'system', actorId: userId,
    metadata: { source: AUTO_SOURCE, phase: 'started' },
  });

  const summary = emptyAutoSummary();

  // 2. The AI step. It has its own gates and may refuse, stop early or be switched off: none of that stops the run.
  let ai: AutoCategoriseResult['ai'] = null;
  try {
    const r = await aiCategoriseStatement(userId, statementId, { ...(deps.ai ?? {}), bestGuess: true });
    ai = { status: r.status, reason: r.reason, calls: r.calls, proposed_lines: r.proposed_lines, estimated_cost_usd: r.estimated_cost_usd };
    // Other spending lines are reported on their own, so they are not also counted as categorised by AI.
    summary.placed_by_ai = r.proposed_lines - r.other_spending_lines;
    summary.guessed_by_ai = r.guessed_lines;
    summary.other_spending_lines = r.other_spending_lines;
  } catch {
    // The run carries on with the rules' answers; the lines the AI would have placed stay questions for the person.
  }

  // 3. Fixed answers for the lines the AI may never see.
  const afterAi = await getStatementCategoryReview(userId, statementId);
  const placements = planFixedPlacements(afterAi.needs_decision);
  if (placements.length > 0) {
    const [cats, subs] = await Promise.all([categoriesRepository.listActiveAll(), subcategoriesRepository.listActiveAll()]);
    const catByKey = new Map((cats.data ?? []).map((c) => [c.category_key, c] as const));
    const catById = new Map((cats.data ?? []).map((c) => [c.id, c] as const));
    const subByCatAndKey = new Map((subs.data ?? []).map((s) => [`${s.category_id}|${s.subcategory_key}`, s] as const));
    const items: AiProposalItem[] = [];
    for (const p of placements) {
      if (p.otherSpending) {
        items.push({ transactionId: p.id, newEconomicType: 'expense', newCategoryId: null });
        continue;
      }
      const category = p.categoryId ? catById.get(p.categoryId) : p.categoryKey ? catByKey.get(p.categoryKey) : undefined;
      if (!category || category.economic_type === 'unknown') continue; // a category that is no longer offered: the line stays a question
      const sub = p.subcategoryKey ? subByCatAndKey.get(`${category.id}|${p.subcategoryKey}`) : undefined;
      items.push({
        transactionId: p.id,
        newEconomicType: category.economic_type as FdhEconomicTransactionType,
        newCategoryId: category.id,
        newSubcategoryId: sub?.id ?? null,
      });
    }
    if (items.length > 0) summary.placed_by_fixed_answer = (await recordAiProposals(userId, items, { method: 'global_rule' })).writtenIds.length;
  }

  // 4. Approve every still-pending line that sits in a category total. The lines that need a person are not in any group, so they are untouched.
  const review = await getStatementCategoryReview(userId, statementId);
  for (const group of review.groups) {
    const ids = group.lines.filter((l) => l.approval_status === 'pending').map((l) => l.id);
    if (ids.length === 0) continue;
    // Settle the pending transfer / card-payment matches that agree with the group's own type, exactly as approving the total would.
    await settlePendingLinksForGroup(userId, ids, group.economic_type);
    const result = await bulkApproveTransactions(userId, ids, { actorType: 'system' });
    const approved = new Set(result.results.filter((r) => r.ok).map((r) => r.id));
    summary.approved_lines += approved.size;
    summary[summaryBucket(group.counts_toward)] += approved.size;
  }

  // 5. Complete the statement when every counted line is approved.
  if (summary.approved_lines > 0) {
    const finalised = await finaliseStatementIfComplete(userId, statementId);
    summary.statement_finalised = finalised.finalised;
  }
  summary.left_for_you = (await getStatementCategoryReview(userId, statementId)).counts.waiting_for_approval;

  await recordDocumentAuditEvent({
    userId, documentId: statementId, eventType: 'bulk_review_action_completed', actorType: 'system', actorId: userId,
    // Counts and codes only -- never a payee, a description or a category choice.
    metadata: { source: AUTO_SOURCE, phase: 'completed', summary, ai_status: ai?.status ?? null, ai_reason: ai?.reason ?? null },
  });
  return { status: 'done', summary, ai };
}

/** Withdraws every approval on the statement so the person can change what is wrong; records that they did. */
export async function undoAutoCategorise(userId: string, statementId: string): Promise<{ reverted: number | null }> {
  const statement = await loadOwnStatement(userId, statementId);
  // Deliberately NOT behind the flag or the Premium check: a person who already has automatic lines must always be able to take them back.
  const state = readAutoState(await loadAutoEvents(userId, statementId));
  if (!state.summary) throw new CategoryReviewError('invalid_state', 'There is no automatic categorisation to undo on this statement.');
  let reverted: number | null;
  try {
    if (statement.approved_by) {
      await reopenStatement(userId, statementId, 'Undo of the automatic categorisation.');
      reverted = null;
    } else {
      reverted = await revertStatementTransactionApprovals(userId, statementId);
    }
  } catch (e) {
    if (e instanceof ApprovalError) throw new CategoryReviewError('invalid_state', 'We could not undo this. Please try again.', e.details);
    throw e;
  }
  await recordDocumentAuditEvent({
    userId, documentId: statementId, eventType: 'bulk_review_action_completed', actorType: 'user', actorId: userId,
    metadata: { source: AUTO_UNDO_SOURCE, reverted_lines: reverted },
  });
  return { reverted };
}
