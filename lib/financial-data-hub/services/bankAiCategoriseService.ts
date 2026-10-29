/**
 * Optional Premium AI categorisation of the lines the rules could not classify (29-10-2026) -- the LAST step, off by default.
 *
 * ORDER OF THINGS (each is a real gate, in this order, and a failure stops the run with a typed reason):
 *   1. AIE_BANK_CATEGORISE_AI_ENABLED (default OFF) -- the feature switch;
 *   2. the shared pre-egress gate (lib/aie/adapters/shared/fallbackGate.ts): the global AIE_AI_FALLBACK_ENABLED kill switch, the real-malware-scan
 *      precondition, the person's ACTIVE Premium entitlement, and the masking gate (fails closed);
 *   3. the shared gateway (lib/aie/adapters/shared/gateway.ts): per-user daily cap, the global cost ledger (reserve then settle), the strict
 *      schema, the independent pre-egress PII re-scan.
 *
 * WHAT IS SENT. ONE call per up to 40 DISTINCT payee strings (identical payees cost one question: 25 payments to the same shop are one line in
 * the prompt). Each string is the narrative with every digit run removed (domain/bankAiCategorise.ts), then masked again by the shared gate.
 * Person-to-person lines (Osko, PayID, transfers) are NEVER sent. No amount, date, account, name or id is sent.
 *
 * WHAT COMES BACK is a category key from a closed list plus a confidence; anything outside the list, "unknown" or low confidence stays unknown.
 * An accepted answer is written as a PROPOSAL (method 'ai', MEDIUM bucket) onto lines that are still unclassified, and nothing is approved. A payee is
 * remembered only when the person approves the proposed total and ticks "remember" (categoryReviewService.approveCategoryGroup).
 */

import { isAieBankCategoriseAiEnabled } from '@/lib/aie/adapters/bankCategorise/featureFlags';
import { requestBankCategorisation, type BankCategoriseOutcome } from '@/lib/aie/adapters/bankCategorise/gateway';
import { evaluateAiEgressPreconditions, evaluateAiFallbackGate, type AieFallbackGateRefusalReason } from '@/lib/aie/adapters/shared/fallbackGate';
import type { PremiumAiAccessDeps } from '@/lib/ai/access/premiumAiAccess';
import { categoriesRepository } from '../repositories';
import {
  allowedAiCategories,
  buildAiBatches,
  estimateAiCostUsd,
  evidenceTextForBatch,
  isAiCandidate,
  resolveAiAnswer,
  type AiCandidateLine,
} from '../domain/bankAiCategorise';
import { recordDocumentAuditEvent } from './auditLog';
import { CategoryReviewError, getStatementCategoryReview } from './categoryReviewService';
import { recordAiProposals, type AiProposalItem } from './transactionClassificationService';
import type { FdhEconomicTransactionType } from '../constants/enums';

/** Bounded work per request (a web request must end): 5 calls x 40 payees = 200 distinct payees. The rest is reported as `remaining_payees`. */
export const AI_CATEGORISE_MAX_CALLS_PER_REQUEST = 5;

export type AiCategoriseStatus = 'done' | 'disabled' | 'refused' | 'nothing_to_do' | 'stopped';

export interface AiCategoriseResult {
  status: AiCategoriseStatus;
  /** A gate refusal or a provider outcome, in words-as-codes (never content). */
  reason: AieFallbackGateRefusalReason | BankCategoriseFailure | null;
  /** Lines still needing a decision that were eligible for the AI step. */
  eligible_lines: number;
  /** Lines that need a decision but are never sent (person-to-person, money in, already suggested). */
  not_sent_lines: number;
  distinct_payees: number;
  calls: number;
  proposed_lines: number;
  proposed_payees: number;
  unknown_payees: number;
  remaining_payees: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

type BankCategoriseFailure = Exclude<BankCategoriseOutcome['outcome'], 'success'>;

export interface AiCategoriseDeps {
  /** Test seam for the Premium entitlement read; production never sets it. */
  entitlementDeps?: PremiumAiAccessDeps;
  /** Test seam: replaces the provider call. Production never sets it. */
  request?: typeof requestBankCategorisation;
  maxCalls?: number;
}

function emptyResult(status: AiCategoriseStatus, reason: AiCategoriseResult['reason'] = null): AiCategoriseResult {
  return {
    status, reason, eligible_lines: 0, not_sent_lines: 0, distinct_payees: 0, calls: 0, proposed_lines: 0, proposed_payees: 0,
    unknown_payees: 0, remaining_payees: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0,
  };
}

export async function aiCategoriseStatement(userId: string, statementId: string, deps: AiCategoriseDeps = {}): Promise<AiCategoriseResult> {
  if (!isAieBankCategoriseAiEnabled()) return emptyResult('disabled');

  const review = await getStatementCategoryReview(userId, statementId);
  const candidates: AiCandidateLine[] = review.needs_decision.map((n) => ({
    id: n.id,
    description: n.description,
    direction: n.direction,
    reason: n.reason,
    currentCategoryId: n.current_category_id,
    suggestedCategoryId: n.suggested_category_id,
  }));
  const eligible = candidates.filter(isAiCandidate);
  const batches = buildAiBatches(candidates);
  const distinctPayees = batches.reduce((n, b) => n + b.payees.length, 0);
  const base = { ...emptyResult('nothing_to_do'), eligible_lines: eligible.length, not_sent_lines: review.needs_decision.length - eligible.length, distinct_payees: distinctPayees };
  if (batches.length === 0) return base;

  const pre = await evaluateAiEgressPreconditions({ userId, adapterEnabled: true, entitlementDeps: deps.entitlementDeps });
  if (!pre.ok) return { ...base, status: 'refused', reason: pre.reason };

  const categoriesResult = await categoriesRepository.listActiveAll();
  if (categoriesResult.error) throw new CategoryReviewError('invalid_state', 'We could not load the category list.');
  const allowed = allowedAiCategories(categoriesResult.data ?? []);
  if (allowed.length === 0) return base;

  const request = deps.request ?? requestBankCategorisation;
  const maxCalls = deps.maxCalls ?? AI_CATEGORISE_MAX_CALLS_PER_REQUEST;
  const result: AiCategoriseResult = { ...base, status: 'done' };

  for (const [index, batch] of batches.entries()) {
    if (result.calls >= maxCalls) {
      result.remaining_payees += batch.payees.length;
      continue;
    }
    const gate = await evaluateAiFallbackGate({ userId, adapterEnabled: true, extractedText: evidenceTextForBatch(batch), entitlementDeps: deps.entitlementDeps });
    if (!gate.ok) {
      // Too little text to be worth a call is a skip; every other refusal (masking unavailable, Premium lapsed mid-run) stops the run.
      if (gate.reason === 'no_extracted_text') {
        result.remaining_payees += batch.payees.length;
        continue;
      }
      result.status = result.calls > 0 ? 'stopped' : 'refused';
      result.reason = gate.reason;
      result.remaining_payees += batches.slice(index).reduce((n, b) => n + b.payees.length, 0);
      break;
    }
    result.calls += 1;
    const outcome = await request({ maskedText: gate.maskedText, allowed: allowed.map((c) => ({ key: c.key, label: c.label })), userId, requestId: `${statementId}:${index}` });
    result.input_tokens += outcome.evidence?.inputTokens ?? 0;
    result.output_tokens += outcome.evidence?.outputTokens ?? 0;
    if (outcome.outcome !== 'success') {
      // Cap reached, budget exhausted, kill switch, timeout, schema rejected ...: stop. What was already proposed stays; nothing is retried blindly.
      result.status = 'stopped';
      result.reason = outcome.outcome;
      result.remaining_payees += batches.slice(index).reduce((n, b) => n + b.payees.length, 0);
      break;
    }
    const resolution = resolveAiAnswer(outcome.facts, batch, allowed);
    result.unknown_payees += resolution.rejected.size;
    const items: AiProposalItem[] = [];
    for (const [text, category] of resolution.accepted) {
      for (const id of batch.idsByText.get(text) ?? []) {
        items.push({ transactionId: id, newEconomicType: category.economicType as FdhEconomicTransactionType, newCategoryId: category.id });
      }
    }
    if (items.length > 0) {
      const written = await recordAiProposals(userId, items);
      result.proposed_lines += written.writtenIds.length;
      result.proposed_payees += resolution.accepted.size;
    }
  }

  result.estimated_cost_usd = Math.round(estimateAiCostUsd(result.input_tokens, result.output_tokens) * 1_000_000) / 1_000_000;
  try {
    await recordDocumentAuditEvent({
      userId,
      documentId: statementId,
      eventType: 'transaction_classification_run',
      actorType: 'user',
      actorId: userId,
      // Counts only -- never a payee, a description or a category choice.
      metadata: { source: 'ai_categorise', status: result.status, calls: result.calls, proposed_lines: result.proposed_lines, unknown_payees: result.unknown_payees, reason: result.reason },
    });
  } catch {
    // Best-effort evidence.
  }
  return result;
}
