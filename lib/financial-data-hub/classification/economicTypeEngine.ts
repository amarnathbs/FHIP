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

  // Tier 1: user rule.
  const userMatches = evaluateRules(ruleTxn, ref.userRules);
  for (const rule of userMatches) {
    if (rule.action_definition.action_kind !== 'classify') continue;
    const a = rule.action_definition;
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
    break; // highest-priority user rule only; no need to evaluate the rest
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
      continue;
    }
    if (rule.action_definition.action_kind !== 'classify') continue;
    const a = rule.action_definition;
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
    break; // highest-priority classify match only
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
