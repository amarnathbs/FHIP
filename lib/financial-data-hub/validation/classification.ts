/**
 * Financial Data Hub — validation for classification rules and history.
 *
 * SAFE RULE DEFINITIONS. `match_definition` and `action_definition` are
 * discriminated unions over a CLOSED vocabulary. There is deliberately no
 * `expression`, no `script`, no `sql` and no `regex` member: a rule is data
 * that a future engine interprets, never code that it executes, and never an
 * unbounded regular expression it compiles.
 *
 * The database independently enforces the shape
 * (`jsonb_typeof(...) = 'object' and ... ? 'match_kind'`); these schemas
 * enforce the vocabulary.
 */

import { z } from 'zod';
import {
  FDH_CHANGED_BY_TYPES,
  FDH_CLASSIFICATION_CHANGE_SOURCES,
  FDH_DOCUMENT_TYPES,
  FDH_ECONOMIC_TRANSACTION_TYPES,
  FDH_GLOBAL_RULE_TYPES,
  FDH_RULE_CANDIDATE_TYPES,
  FDH_USER_RULE_TYPES,
} from '../constants/enums';
import {
  fdhCountryCode,
  fdhMachineKey,
  fdhMcc,
  fdhOwnershipInput,
  fdhUnitInterval,
  fdhUuid,
} from './primitives';

export const fdhRuleMatchDefinitionSchema = z.discriminatedUnion('match_kind', [
  z.object({ match_kind: z.literal('merchant_exact'), merchant_id: fdhUuid }),
  z.object({
    match_kind: z.literal('merchant_alias'),
    alias_normalised: z.string().min(1).max(200),
    country_code: fdhCountryCode.optional(),
  }),
  z.object({ match_kind: z.literal('mcc'), mcc: fdhMcc }),
  z.object({
    match_kind: z.literal('description_contains'),
    // Bounded length: a matcher is a substring, not a document.
    needle_normalised: z.string().min(2).max(200),
    case_sensitive: z.boolean().optional(),
  }),
  z.object({
    match_kind: z.literal('institution_narrative'),
    institution_id: fdhUuid,
    narrative_normalised: z.string().min(1).max(200),
  }),
  z.object({
    match_kind: z.literal('source_provided_category'),
    source_category_key: z.string().min(1).max(120),
  }),
  z.object({
    match_kind: z.literal('account_scoped_default'),
    financial_account_id: fdhUuid,
  }),
  /**
   * FDH-2 ADDITION. Required/excluded TERM matching, not a single needle —
   * this is what lets a salary pattern require "SALARY" or "PAYROLL" while
   * excluding a bare "PAY" from over-matching, and what lets a bank-fee
   * pattern require "FEE" while excluding "FEE WAIVED"/"FEE REFUND". Terms
   * are bounded, non-regex substrings — never an unbounded pattern. Optional
   * `source_context` scopes the pattern to a document type (e.g. only a
   * `bank_statement`, never a `payslip`); omitted means any context.
   */
  z.object({
    match_kind: z.literal('narrative_pattern'),
    required_terms_normalised: z.array(z.string().min(2).max(200)).min(1).max(10),
    excluded_terms_normalised: z.array(z.string().min(2).max(200)).max(10).optional(),
    source_context: z.enum(FDH_DOCUMENT_TYPES).optional(),
    country_code: fdhCountryCode.optional(),
  }),
  /**
   * FDH-2 ADDITION. Recognises a payment-RAIL narrative (UPI/, BPAY, EFTPOS,
   * NEFT, ...). `rail_key` names a row in `fdh_payment_rail_master` — this is
   * NEVER paired with a `classify` action; see
   * `fdhRuleActionDefinitionSchema`'s `annotate_payment_rail` member and the
   * specification's explicit rule that a payment rail is a mechanism, never
   * an economic category.
   */
  z.object({
    match_kind: z.literal('payment_rail_narrative'),
    rail_key: fdhMachineKey,
    narrative_terms_normalised: z.array(z.string().min(1).max(200)).min(1).max(10),
  }),
]);

// Plain object (no .refine()) so it remains a valid z.discriminatedUnion
// member — the "must change at least one field" rule is enforced below via
// .superRefine() on the union as a whole instead.
const fdhClassifyActionSchema = z.object({
  action_kind: z.literal('classify'),
  economic_transaction_type: z.enum(FDH_ECONOMIC_TRANSACTION_TYPES).optional(),
  category_id: fdhUuid.optional(),
  subcategory_id: fdhUuid.optional(),
  merchant_id: fdhUuid.optional(),
  set_transfer_flag: z.boolean().optional(),
  set_subscription_flag: z.boolean().optional(),
});

/**
 * FDH-2 ADDITION. `flag_candidate` is STRUCTURALLY NON-AUTHORITATIVE — it
 * carries no `economic_transaction_type`, `category_id` or `subcategory_id`
 * at all. It names a `candidate_type` a future engine (FDH-6) must
 * independently confirm: a transfer needs its counterpart matched by
 * amount/date/account, a credit-card payment needs settlement matching, an
 * investment-transfer needs funding matching. This is exactly how the
 * specification's TRANSFER_CANDIDATE / LIABILITY_SETTLEMENT_CANDIDATE /
 * INVESTMENT_FUNDING_CANDIDATE suggestions are represented: a rule may
 * SUGGEST, never COMMIT, one of these.
 */
const fdhFlagCandidateActionSchema = z.object({
  action_kind: z.literal('flag_candidate'),
  candidate_type: z.enum(FDH_RULE_CANDIDATE_TYPES),
  note: z.string().max(200).optional(),
});

/**
 * FDH-2 ADDITION. Records which payment MECHANISM was observed. Never
 * carries an economic_transaction_type, category or subcategory — a payment
 * rail is metadata about HOW money moved, never WHAT it was for.
 */
const fdhAnnotatePaymentRailActionSchema = z.object({
  action_kind: z.literal('annotate_payment_rail'),
  rail_key: fdhMachineKey,
});

export const fdhRuleActionDefinitionSchema = z
  .discriminatedUnion('action_kind', [
    fdhClassifyActionSchema,
    fdhFlagCandidateActionSchema,
    fdhAnnotatePaymentRailActionSchema,
  ])
  .superRefine((a, ctx) => {
    if (a.action_kind !== 'classify') return;
    const changesSomething = a.economic_transaction_type !== undefined
      || a.category_id !== undefined
      || a.subcategory_id !== undefined
      || a.merchant_id !== undefined
      || a.set_transfer_flag !== undefined
      || a.set_subscription_flag !== undefined;
    if (!changesSomething) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['economic_transaction_type'],
        message: 'a classify action must change at least one field',
      });
    }
  });

/**
 * The `match_kind` values a rule of a given `rule_type` may carry. Keeping the
 * two in step stops a rule claiming to be an MCC rule while actually matching
 * on a description.
 */
const MATCH_KIND_FOR_RULE_TYPE: Record<string, string> = {
  merchant_exact: 'merchant_exact',
  merchant_alias: 'merchant_alias',
  mcc: 'mcc',
  description_contains: 'description_contains',
  institution_narrative: 'institution_narrative',
  source_provided_category: 'source_provided_category',
  account_scoped_default: 'account_scoped_default',
  // FDH-2 additions.
  narrative_pattern: 'narrative_pattern',
  payment_rail_narrative: 'payment_rail_narrative',
};

function refineRuleTypeMatchesDefinition(
  value: { rule_type: string; match_definition: { match_kind: string } },
  ctx: z.RefinementCtx,
) {
  const expected = MATCH_KIND_FOR_RULE_TYPE[value.rule_type];
  if (expected && value.match_definition.match_kind !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['match_definition', 'match_kind'],
      message: `rule_type "${value.rule_type}" requires match_kind "${expected}"`,
    });
  }
}

/**
 * A global rule. Admin/service-role write path only — an ordinary session has
 * no INSERT policy on `fdh_classification_rules`. This schema exists for the
 * future FDH-13 admin surface; FDH-1 exposes no route that uses it.
 */
export const fdhGlobalClassificationRuleSchema = z
  .object({
    rule_key: fdhMachineKey,
    rule_type: z.enum(FDH_GLOBAL_RULE_TYPES),
    country_applicability: z.array(fdhCountryCode).min(1).default(['AU', 'IN']),
    match_definition: fdhRuleMatchDefinitionSchema,
    action_definition: fdhRuleActionDefinitionSchema,
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .superRefine(refineRuleTypeMatchesDefinition);

/**
 * A household's own rule.
 *
 * CRITICAL: creating one of these NEVER creates or amends a global rule.
 * `fdh_merchants` and `fdh_classification_rules` have no INSERT/UPDATE policy
 * for the authenticated role at all, so the database refuses such a write even
 * if application code one day attempted it.
 */
export const fdhUserClassificationRuleSchema = fdhOwnershipInput
  .extend({
    rule_type: z.enum(FDH_USER_RULE_TYPES),
    match_definition: fdhRuleMatchDefinitionSchema,
    action_definition: fdhRuleActionDefinitionSchema,
    priority: z.number().int().min(0).max(10_000).default(100),
    active: z.boolean().default(true),
  })
  .superRefine(refineRuleTypeMatchesDefinition);

/**
 * An append-only classification-history entry.
 *
 * `changed_by_type` and `classification_method` together are what keep a
 * user's confirmed decision distinguishable from an automatic one after a
 * future reprocessing run.
 */
export const fdhClassificationHistorySchema = z
  .object({
    transaction_id: fdhUuid,
    previous_economic_transaction_type: z.enum(FDH_ECONOMIC_TRANSACTION_TYPES).nullish(),
    new_economic_transaction_type: z.enum(FDH_ECONOMIC_TRANSACTION_TYPES),
    previous_category_id: fdhUuid.nullish(),
    new_category_id: fdhUuid.nullish(),
    previous_subcategory_id: fdhUuid.nullish(),
    new_subcategory_id: fdhUuid.nullish(),
    classification_method: z.enum(FDH_CLASSIFICATION_CHANGE_SOURCES),
    confidence: fdhUnitInterval.nullish(),
    changed_by_type: z.enum(FDH_CHANGED_BY_TYPES),
    changed_by_user: fdhUuid.nullish(),
    global_rule_id: fdhUuid.nullish(),
    user_rule_id: fdhUuid.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.global_rule_id && v.user_rule_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['user_rule_id'],
        message: 'a change originates from either a global rule or a user rule, not both',
      });
    }
    if (v.classification_method === 'user_manual' && v.changed_by_type === 'system') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changed_by_type'],
        message: 'a user_manual change cannot be attributed to the system',
      });
    }
    if (v.classification_method === 'user_rule' && !v.user_rule_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['user_rule_id'],
        message: 'a user_rule change must name the rule that caused it',
      });
    }
  });

export type FdhGlobalClassificationRuleInput = z.infer<typeof fdhGlobalClassificationRuleSchema>;
export type FdhUserClassificationRuleInput = z.infer<typeof fdhUserClassificationRuleSchema>;
export type FdhClassificationHistoryInput = z.infer<typeof fdhClassificationHistorySchema>;
