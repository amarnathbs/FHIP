/**
 * R8 — the economic-type/category/merchant classification engine (spec
 * sections 27-29, 41-45).
 *
 * PURE FUNCTION. Given one transaction and a bundle of already-fetched
 * reference data, returns a single deterministic classification result
 * (spec section 92: "correct economic interpretation — or the system
 * explicitly admits it cannot determine one"). Calls the EXISTING
 * `resolvePrecedence()` (`domain/classificationPrecedence.ts`) rather than
 * re-implementing precedence ranking — R8-P0 found that function, and the
 * 9-tier order it encodes, already fully designed and tested; this module
 * is the first real caller.
 *
 * TIERS ACTUALLY REACHABLE FROM A CSV-SOURCED TRANSACTION (see
 * R8_ASSUMPTION_RECONCILIATION.md section 6 for why the others cannot fire):
 *   1. user_rule               — fdh_user_classification_rules match
 *   3. verified_merchant_alias — fdh_merchants/fdh_merchant_aliases match
 *   5/6. verified_global_rule / narrative_pattern — fdh_classification_rules
 *        match (FDH-2 seeded 60 rows, all narrative_pattern/
 *        payment_rail_narrative — so in practice every global-rule match
 *        reaches this function tagged 'verified_global_rule' when the
 *        match_kind is not itself 'narrative_pattern', and
 *        'narrative_pattern' otherwise; both map to the same DB
 *        `classification_method = 'global_rule'`)
 *   9. user_review — no candidate resolved anything; UNRESOLVED, surfaced
 *      for review rather than guessed (spec section 92).
 *   Tiers 2 (source_provided), 4 (mcc), 7 (fuzzy_merchant_match), 8 (ai) are
 *   structurally unreachable / not implemented anywhere in this codebase —
 *   never fire, by design, not by omission.
 */

import { resolvePrecedence, type PrecedenceCandidate } from '../domain/classificationPrecedence';
import type { FdhCategory } from '../domain/types';
import type { FdhEconomicTransactionType } from '../constants/enums';
import { matchMerchant } from './merchantMatching';
import { evaluateRules, type RuleMatchTransaction } from './ruleMatching';
import type { ClassificationReferenceData, ClassifiableTransaction, EconomicTypeResult } from './types';

const HINTS_SUGGESTING_TRANSFER: Partial<Record<string, 'transfer_candidate' | 'investment_funding_candidate' | 'liability_settlement_candidate'>> = {
  transfer_candidate: 'transfer_candidate',
  investment_transfer_candidate: 'investment_funding_candidate',
  card_payment_candidate: 'liability_settlement_candidate',
};

function categoryEconomicType(categoryId: string | null, categories: FdhCategory[]): FdhEconomicTransactionType | null {
  if (!categoryId) return null;
  return categories.find((c) => c.id === categoryId)?.economic_type ?? null;
}

/**
 * FDH-6 (spec section 57) — rule-conflict detection.
 *
 * `evaluateRules()` returns matches sorted by priority ascending (lower =
 * higher precedence), but ties within the SAME priority were previously
 * resolved by whatever order the caller's array happened to be in — never
 * detected, never surfaced. This groups the TOP priority band and checks
 * whether every rule in it actually agrees on the outcome (same category +
 * subcategory + economic type + merchant): if they do, picking any one of
 * them is safe (they are redundant, not contradictory) and the first is
 * returned as `winner`; if they genuinely disagree, `conflict: true` is
 * returned instead of an arbitrary pick.
 */
interface ClassifyRuleProjection {
  id: string;
  priority: number;
  categoryId: string | null;
  subcategoryId: string | null;
  economicTransactionType: FdhEconomicTransactionType | null;
  merchantId: string | null;
}

type ConflictCheckResult =
  | { kind: 'winner'; ruleId: string }
  | { kind: 'conflict'; conflictingRuleIds: string[] }
  | { kind: 'none' };

/** Projects the closed-vocabulary `classify` action shape into a plain,
 * non-union object — sidesteps TypeScript inference edge cases around
 * generics over a discriminated union, and keeps `pickTopTierOrConflict`
 * itself trivially testable in isolation. */
function toClassifyProjection(rule: {
  id: string;
  priority: number;
  action_definition: {
    action_kind: string;
    category_id?: string;
    subcategory_id?: string;
    economic_transaction_type?: FdhEconomicTransactionType;
    merchant_id?: string;
  };
}): ClassifyRuleProjection | null {
  if (rule.action_definition.action_kind !== 'classify') return null;
  return {
    id: rule.id,
    priority: rule.priority,
    categoryId: rule.action_definition.category_id ?? null,
    subcategoryId: rule.action_definition.subcategory_id ?? null,
    economicTransactionType: rule.action_definition.economic_transaction_type ?? null,
    merchantId: rule.action_definition.merchant_id ?? null,
  };
}

/**
 * FDH-6 (spec section 57) — rule-conflict detection.
 *
 * `evaluateRules()` returns matches sorted by priority ascending (lower =
 * higher precedence), but ties within the SAME priority were previously
 * resolved by whatever order the caller's array happened to be in — never
 * detected, never surfaced. This groups the TOP priority band and checks
 * whether every rule in it actually agrees on the outcome (same category +
 * subcategory + economic type + merchant): if they do, picking any one of
 * them is safe (they are redundant, not contradictory) and the first (by id)
 * is returned as `winner`; if they genuinely disagree, `conflict: true` is
 * returned instead of an arbitrary pick.
 */
function pickTopTierOrConflict(classifyMatchesSortedByPriority: ClassifyRuleProjection[]): ConflictCheckResult {
  if (classifyMatchesSortedByPriority.length === 0) return { kind: 'none' };
  const topPriority = classifyMatchesSortedByPriority[0].priority;
  const topTier = classifyMatchesSortedByPriority.filter((r) => r.priority === topPriority);
  if (topTier.length === 1) return { kind: 'winner', ruleId: topTier[0].id };

  const distinctActions = new Set(
    topTier.map((r) => JSON.stringify({ c: r.categoryId, s: r.subcategoryId, e: r.economicTransactionType, m: r.merchantId })),
  );
  // Multiple rules at the same priority that all propose the IDENTICAL
  // outcome are redundant, not contradictory — picking the first is safe
  // and deterministic (same input always yields the same first element).
  if (distinctActions.size === 1) return { kind: 'winner', ruleId: topTier[0].id };
  return { kind: 'conflict', conflictingRuleIds: topTier.map((r) => r.id) };
}

export function classifyTransaction(
  txn: ClassifiableTransaction,
  institutionId: string | null,
  ref: ClassificationReferenceData,
): EconomicTypeResult {
  const ruleTxn: RuleMatchTransaction = {
    descriptionClean: txn.description_clean,
    merchantRaw: txn.merchant_raw,
    financialAccountId: txn.financial_account_id,
    institutionId,
  };

  const candidates: Array<{
    precedence: PrecedenceCandidate;
    result: Omit<EconomicTypeResult, 'confidence' | 'source' | 'explanation' | 'flaggedCandidate'>;
    source: EconomicTypeResult['source'];
    explanationText: string;
    flaggedCandidate: EconomicTypeResult['flaggedCandidate'];
  }> = [];

  // Tier 1: user rule. Spec section 57: two of the user's own ACTIVE rules
  // tied on priority with genuinely different outcomes are never resolved
  // by array order — the user's own contradictory instruction is the
  // HIGHEST-precedence signal that exists, so a real conflict here always
  // short-circuits the whole classification to unknown/RULE_CONFLICT,
  // regardless of what a lower tier (merchant/global) might otherwise say.
  const userMatches = evaluateRules(ruleTxn, ref.userRules);
  const userClassifyById = new Map(userMatches.map((r) => [r.id, r]));
  const userProjections = userMatches
    .map(toClassifyProjection)
    .filter((p): p is ClassifyRuleProjection => p !== null);
  const userTier = pickTopTierOrConflict(userProjections);
  if (userTier.kind === 'conflict') {
    return {
      economicTransactionType: 'unknown',
      categoryId: null,
      subcategoryId: null,
      merchantId: null,
      transferFlag: false,
      subscriptionFlag: false,
      classificationMethod: 'unclassified',
      confidence: 'UNRESOLVED',
      source: { kind: 'rule_conflict', conflictingRuleIds: userTier.conflictingRuleIds },
      explanation: `${userTier.conflictingRuleIds.length} of your own rules match this transaction at the same priority with different outcomes. Needs manual review.`,
      flaggedCandidate: null,
    };
  }
  if (userTier.kind === 'winner') {
    const rule = userClassifyById.get(userTier.ruleId)!;
    // Safe: pickTopTierOrConflict only ever returns a 'winner' ruleId drawn
    // from userProjections, which toClassifyProjection() only produced for
    // action_kind === 'classify' rows — a runtime-guaranteed narrowing.
    const a = rule.action_definition as Extract<typeof rule.action_definition, { action_kind: 'classify' }>;
    const categoryId = a.category_id ?? null;
    const economicType = a.economic_transaction_type ?? categoryEconomicType(categoryId, ref.categories) ?? 'unknown';
    candidates.push({
      precedence: { source: 'user_rule', categoryKey: categoryId, economicTransactionType: economicType },
      result: {
        economicTransactionType: economicType,
        categoryId,
        subcategoryId: a.subcategory_id ?? null,
        merchantId: a.merchant_id ?? null,
        transferFlag: a.set_transfer_flag ?? false,
        subscriptionFlag: a.set_subscription_flag ?? false,
        classificationMethod: 'user_rule',
      },
      source: { kind: 'user_rule', ruleId: rule.id },
      explanationText: `Matched your own rule "${rule.rule_type}".`,
      flaggedCandidate: null,
    });
  }

  // Tier 3: verified merchant alias / canonical name.
  const merchantMatch = matchMerchant(txn.description_clean, txn.merchant_raw, ref.merchants, ref.merchantAliases);
  if (merchantMatch) {
    const categoryId = merchantMatch.merchant.default_category_id;
    const economicType = categoryEconomicType(categoryId, ref.categories) ?? 'unknown';
    candidates.push({
      precedence: { source: 'verified_merchant_alias', categoryKey: categoryId, economicTransactionType: economicType },
      result: {
        economicTransactionType: economicType,
        categoryId,
        subcategoryId: merchantMatch.merchant.default_subcategory_id,
        merchantId: merchantMatch.merchant.id,
        transferFlag: false,
        subscriptionFlag: merchantMatch.merchant.subscription_possible,
        classificationMethod: 'merchant_master',
      },
      source: { kind: 'verified_merchant_alias', merchantId: merchantMatch.merchant.id },
      explanationText: `Matched canonical merchant "${merchantMatch.merchant.display_name}" from an approved ${merchantMatch.matchedOn === 'alias' ? 'alias' : 'name'} match.`,
      flaggedCandidate: null,
    });
  }

  // Tiers 5/6: global rules.
  const globalMatches = evaluateRules(ruleTxn, ref.globalRules);
  let globalFlagged: EconomicTypeResult['flaggedCandidate'] = null;
  for (const rule of globalMatches) {
    if (rule.action_definition.action_kind === 'flag_candidate') {
      if (rule.action_definition.candidate_type !== 'possible_duplicate_review' && !globalFlagged) {
        globalFlagged = rule.action_definition.candidate_type;
      }
    }
  }
  const globalClassifyById = new Map(globalMatches.map((r) => [r.id, r]));
  const globalProjections = globalMatches
    .map(toClassifyProjection)
    .filter((p): p is ClassifyRuleProjection => p !== null);
  const globalTier = pickTopTierOrConflict(globalProjections);
  // Spec section 57: a genuine same-priority conflict among GLOBAL rules
  // only matters if global rules were actually going to decide the outcome
  // — a higher tier (user rule / verified merchant) that already produced a
  // candidate legitimately wins regardless, exactly as resolvePrecedence()
  // would have ranked it, so the conflict is moot and silently ignored.
  if (globalTier.kind === 'conflict' && candidates.length === 0) {
    return {
      economicTransactionType: 'unknown',
      categoryId: null,
      subcategoryId: null,
      merchantId: null,
      transferFlag: false,
      subscriptionFlag: false,
      classificationMethod: 'unclassified',
      confidence: 'UNRESOLVED',
      source: { kind: 'rule_conflict', conflictingRuleIds: globalTier.conflictingRuleIds },
      explanation: `${globalTier.conflictingRuleIds.length} approved global rules match this transaction at the same priority with different outcomes. Needs manual review.`,
      flaggedCandidate: globalFlagged,
    };
  }
  if (globalTier.kind === 'winner') {
    const rule = globalClassifyById.get(globalTier.ruleId)!;
    const a = rule.action_definition as Extract<typeof rule.action_definition, { action_kind: 'classify' }>;
    const categoryId = a.category_id ?? null;
    const economicType = a.economic_transaction_type ?? categoryEconomicType(categoryId, ref.categories) ?? 'unknown';
    const precedenceSource = rule.match_definition.match_kind === 'narrative_pattern' ? 'narrative_pattern' : 'verified_global_rule';
    candidates.push({
      precedence: { source: precedenceSource, categoryKey: categoryId, economicTransactionType: economicType },
      result: {
        economicTransactionType: economicType,
        categoryId,
        subcategoryId: a.subcategory_id ?? null,
        merchantId: a.merchant_id ?? null,
        transferFlag: a.set_transfer_flag ?? false,
        subscriptionFlag: a.set_subscription_flag ?? false,
        classificationMethod: 'global_rule',
      },
      source: { kind: precedenceSource, ruleId: rule.id },
      explanationText: `Matched approved global rule "${rule.rule_key}".`,
      flaggedCandidate: null,
    });
  }

  // Structural hint fallback for candidate-flagging only (never commits an
  // economic type — see module header).
  const hintCandidate = HINTS_SUGGESTING_TRANSFER[txn.transaction_type_hint] ?? null;

  if (candidates.length === 0) {
    return {
      economicTransactionType: 'unknown',
      categoryId: null,
      subcategoryId: null,
      merchantId: null,
      transferFlag: false,
      subscriptionFlag: false,
      classificationMethod: 'unclassified',
      confidence: 'UNRESOLVED',
      source: { kind: 'unresolved' },
      explanation: hintCandidate
        ? `No rule or merchant matched; structural hint "${txn.transaction_type_hint}" suggests this may need transfer/settlement review.`
        : 'No rule or merchant matched this transaction. Needs manual review.',
      flaggedCandidate: hintCandidate ?? globalFlagged,
    };
  }

  const winnerPrecedence = resolvePrecedence(candidates.map((c) => c.precedence));
  const winner = candidates.find((c) => c.precedence === winnerPrecedence)!;
  const confidence = winner.source.kind === 'user_rule' || winner.source.kind === 'verified_merchant_alias' ? 'HIGH' : 'MEDIUM';

  return {
    ...winner.result,
    confidence,
    source: winner.source,
    explanation: winner.explanationText,
    flaggedCandidate: globalFlagged ?? hintCandidate,
  };
}
