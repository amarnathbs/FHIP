/**
 * FDH-2 — Zod validation-schema unit tests for the new master-data and
 * classification-rule shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  fdhCategorySchema,
  fdhGlobalLearningCandidateSchema,
  fdhInstitutionAliasSchema,
  fdhMccCategoryMapSchema,
  fdhMccSchema,
  fdhMerchantSchema,
  fdhPaymentRailSchema,
} from '@/lib/financial-data-hub/validation/masterData';
import {
  fdhGlobalClassificationRuleSchema,
  fdhRuleActionDefinitionSchema,
  fdhRuleMatchDefinitionSchema,
} from '@/lib/financial-data-hub/validation/classification';

describe('fdhCategorySchema (FDH-2 fields)', () => {
  const base = { category_key: 'food', display_name: 'Food', economic_type: 'expense' as const };

  it('accepts a well-formed category with FDH-2 metadata', () => {
    const result = fdhCategorySchema.safeParse({
      ...base,
      essential_discretionary: 'user_dependent',
      fixed_variable: 'semi_variable',
      retirement_relevance: false,
      investment_relevance: false,
      debt_relevance: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a deprecated category that is still active', () => {
    const result = fdhCategorySchema.safeParse({ ...base, deprecated_at: '2026-01-01T00:00:00Z', active: true });
    expect(result.success).toBe(false);
  });

  it('rejects a replacement_key without deprecated_at', () => {
    const result = fdhCategorySchema.safeParse({ ...base, replacement_key: 'other_category' });
    expect(result.success).toBe(false);
  });

  it('rejects a category naming itself as its own replacement', () => {
    const result = fdhCategorySchema.safeParse({
      ...base, deprecated_at: '2026-01-01T00:00:00Z', active: false, replacement_key: 'food',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a properly deprecated-and-replaced category', () => {
    const result = fdhCategorySchema.safeParse({
      ...base, deprecated_at: '2026-01-01T00:00:00Z', active: false, replacement_key: 'food_and_dining',
    });
    expect(result.success).toBe(true);
  });
});

describe('fdhMccSchema', () => {
  it('accepts a valid 4-digit MCC', () => {
    expect(fdhMccSchema.safeParse({
      mcc: '5411', official_or_public_description: 'Grocery Stores', normalized_description: 'Supermarket', broad_group: 'grocery_supermarket',
    }).success).toBe(true);
  });

  it('rejects a non-4-digit MCC', () => {
    expect(fdhMccSchema.safeParse({
      mcc: '54', official_or_public_description: 'x', normalized_description: 'x', broad_group: 'other',
    }).success).toBe(false);
    expect(fdhMccSchema.safeParse({
      mcc: 'ABCD', official_or_public_description: 'x', normalized_description: 'x', broad_group: 'other',
    }).success).toBe(false);
  });

  it('rejects an unknown broad_group', () => {
    expect(fdhMccSchema.safeParse({
      mcc: '5411', official_or_public_description: 'x', normalized_description: 'x', broad_group: 'made_up',
    }).success).toBe(false);
  });
});

describe('fdhMccCategoryMapSchema — deliberate under-mapping rules', () => {
  const catId = '11111111-1111-1111-1111-111111111111';
  const subId = '22222222-2222-2222-2222-222222222222';

  it('accepts a direct mapping with category and subcategory', () => {
    expect(fdhMccCategoryMapSchema.safeParse({
      mcc: '5411', category_id: catId, subcategory_id: subId, mapping_confidence: 'high', mapping_type: 'direct',
    }).success).toBe(true);
  });

  it('accepts an ambiguous_unmapped mapping with no category at all', () => {
    expect(fdhMccCategoryMapSchema.safeParse({
      mcc: '6012', mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true,
    }).success).toBe(true);
  });

  it('rejects a subcategory without its parent category', () => {
    expect(fdhMccCategoryMapSchema.safeParse({
      mcc: '5411', subcategory_id: subId, mapping_confidence: 'high', mapping_type: 'direct',
    }).success).toBe(false);
  });

  it('rejects an ambiguous mapping that still carries a subcategory (false precision)', () => {
    expect(fdhMccCategoryMapSchema.safeParse({
      mcc: '4900', category_id: catId, subcategory_id: subId, mapping_confidence: 'context_required',
      mapping_type: 'broad_group_only', ambiguity_flag: true,
    }).success).toBe(false);
  });

  it('rejects ambiguous_unmapped that still carries a category (label/data disagreement)', () => {
    expect(fdhMccCategoryMapSchema.safeParse({
      mcc: '6012', category_id: catId, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped',
    }).success).toBe(false);
  });
});

describe('fdhPaymentRailSchema — never carries an economic category', () => {
  it('accepts a well-formed rail', () => {
    expect(fdhPaymentRailSchema.safeParse({
      rail_key: 'au_bpay', display_name: 'BPAY', country_code: 'AU', rail_category: 'bill_payment',
    }).success).toBe(true);
  });

  it('rejects an unknown rail_category', () => {
    expect(fdhPaymentRailSchema.safeParse({
      rail_key: 'x', display_name: 'X', rail_category: 'expense',
    }).success).toBe(false);
  });

  it('has no economic_transaction_type/category field on its shape at all', () => {
    const shape = (fdhPaymentRailSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect('category_id' in shape).toBe(false);
    expect('economic_transaction_type' in shape).toBe(false);
  });
});

describe('fdhMerchantSchema (FDH-2 fields)', () => {
  const base = { canonical_name: 'woolworths', display_name: 'Woolworths' };

  it('accepts a merchant with recurrence/confidence metadata', () => {
    expect(fdhMerchantSchema.safeParse({
      ...base, country_code: 'AU', mcc: '5411', mcc_confidence: 'high', recurring_possible: false,
    }).success).toBe(true);
  });

  it('rejects mcc_confidence set without an mcc', () => {
    expect(fdhMerchantSchema.safeParse({ ...base, mcc_confidence: 'high' }).success).toBe(false);
  });

  it('rejects a merged merchant with no surviving record named', () => {
    expect(fdhMerchantSchema.safeParse({ ...base, verification_status: 'merged' }).success).toBe(false);
  });
});

describe('fdhInstitutionAliasSchema', () => {
  it('accepts a well-formed alias', () => {
    expect(fdhInstitutionAliasSchema.safeParse({
      institution_id: '11111111-1111-1111-1111-111111111111', alias: 'CBA', alias_normalized: 'CBA', source: 'admin_curated',
    }).success).toBe(true);
  });

  it('rejects an unrecognised source', () => {
    expect(fdhInstitutionAliasSchema.safeParse({
      institution_id: '11111111-1111-1111-1111-111111111111', alias: 'CBA', alias_normalized: 'CBA', source: 'guessed',
    }).success).toBe(false);
  });
});

describe('fdhGlobalLearningCandidateSchema — PII gate mirrors the DB constraint', () => {
  it('accepts an open candidate with default screening', () => {
    expect(fdhGlobalLearningCandidateSchema.safeParse({
      candidate_type: 'merchant_alias', number_of_independent_users: 3, number_of_corrections: 5, number_of_matching_aliases: 2,
    }).success).toBe(true);
  });

  it('rejects status=approved without pii_screening_status=passed', () => {
    expect(fdhGlobalLearningCandidateSchema.safeParse({
      candidate_type: 'merchant_alias', status: 'approved', pii_screening_status: 'flagged',
      number_of_independent_users: 1, number_of_corrections: 1, number_of_matching_aliases: 1,
    }).success).toBe(false);
  });

  it('accepts status=approved with pii_screening_status=passed', () => {
    expect(fdhGlobalLearningCandidateSchema.safeParse({
      candidate_type: 'merchant_alias', status: 'approved', pii_screening_status: 'passed',
      number_of_independent_users: 1, number_of_corrections: 1, number_of_matching_aliases: 1,
    }).success).toBe(true);
  });
});

describe('FDH-2 classification match_definition additions', () => {
  it('accepts a narrative_pattern with required and excluded terms', () => {
    const result = fdhRuleMatchDefinitionSchema.safeParse({
      match_kind: 'narrative_pattern',
      required_terms_normalised: ['SALARY'],
      excluded_terms_normalised: ['SALARY SACRIFICE'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a narrative_pattern with zero required terms', () => {
    const result = fdhRuleMatchDefinitionSchema.safeParse({
      match_kind: 'narrative_pattern',
      required_terms_normalised: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a payment_rail_narrative', () => {
    const result = fdhRuleMatchDefinitionSchema.safeParse({
      match_kind: 'payment_rail_narrative',
      rail_key: 'au_bpay',
      narrative_terms_normalised: ['BPAY'],
    });
    expect(result.success).toBe(true);
  });
});

describe('FDH-2 classification action_definition additions', () => {
  it('accepts a flag_candidate action', () => {
    const result = fdhRuleActionDefinitionSchema.safeParse({
      action_kind: 'flag_candidate', candidate_type: 'transfer_candidate',
    });
    expect(result.success).toBe(true);
  });

  it('a flag_candidate action never carries economic_transaction_type/category_id, even if a caller tries to smuggle one in', () => {
    // Black-box proof rather than introspecting zod internals: parse a
    // payload that ALSO supplies economic_transaction_type/category_id and
    // confirm the parsed output — what any caller would actually use —
    // contains neither key, because the flag_candidate member's shape has no
    // such field for Zod to keep.
    const parsed = fdhRuleActionDefinitionSchema.parse({
      action_kind: 'flag_candidate',
      candidate_type: 'transfer_candidate',
      economic_transaction_type: 'transfer',
      category_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed).not.toHaveProperty('economic_transaction_type');
    expect(parsed).not.toHaveProperty('category_id');
    expect(parsed).toEqual({ action_kind: 'flag_candidate', candidate_type: 'transfer_candidate' });
  });

  it('accepts an annotate_payment_rail action', () => {
    const result = fdhRuleActionDefinitionSchema.safeParse({
      action_kind: 'annotate_payment_rail', rail_key: 'in_upi',
    });
    expect(result.success).toBe(true);
  });

  it('an annotate_payment_rail action never carries economic_transaction_type/category_id, even if a caller tries to smuggle one in', () => {
    const parsed = fdhRuleActionDefinitionSchema.parse({
      action_kind: 'annotate_payment_rail',
      rail_key: 'in_upi',
      economic_transaction_type: 'expense',
    });
    expect(parsed).not.toHaveProperty('economic_transaction_type');
    expect(parsed).toEqual({ action_kind: 'annotate_payment_rail', rail_key: 'in_upi' });
  });

  it('still requires a classify action to change at least one field', () => {
    const result = fdhRuleActionDefinitionSchema.safeParse({ action_kind: 'classify' });
    expect(result.success).toBe(false);
  });

  it('a global rule of rule_type narrative_pattern must carry a matching match_kind', () => {
    const good = fdhGlobalClassificationRuleSchema.safeParse({
      rule_key: 'fee_account_generic',
      rule_type: 'narrative_pattern',
      match_definition: { match_kind: 'narrative_pattern', required_terms_normalised: ['ACCOUNT FEE'] },
      action_definition: { action_kind: 'classify', economic_transaction_type: 'fee' },
    });
    expect(good.success).toBe(true);

    const mismatched = fdhGlobalClassificationRuleSchema.safeParse({
      rule_key: 'fee_account_generic_bad',
      rule_type: 'narrative_pattern',
      match_definition: { match_kind: 'mcc', mcc: '6012' },
      action_definition: { action_kind: 'classify', economic_transaction_type: 'fee' },
    });
    expect(mismatched.success).toBe(false);
  });
});
