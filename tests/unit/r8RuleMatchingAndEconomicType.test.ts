/**
 * R8 — rule evaluation and the economic-type classification engine. Pure
 * functions, no database. Reference data is hand-built per test, never
 * imported from the real FDH-2 seed, so a seed-data change can never
 * silently change what these tests assert.
 */
import { describe, expect, it } from 'vitest';
import { evaluateRules, matchesRule } from '@/lib/financial-data-hub/classification/ruleMatching';
import { classifyTransaction } from '@/lib/financial-data-hub/classification/economicTypeEngine';
import type { ClassifiableTransaction, ClassificationReferenceData } from '@/lib/financial-data-hub/classification/types';
import type { FdhCategory, FdhClassificationRule, FdhMerchant, FdhUserClassificationRule } from '@/lib/financial-data-hub/domain/types';

function category(overrides: Partial<FdhCategory> = {}): FdhCategory {
  return {
    id: 'cat-1',
    category_key: 'groceries',
    display_name: 'Groceries',
    description: null,
    economic_type: 'expense',
    country_applicability: ['AU', 'IN'],
    essential_discretionary: 'essential',
    tax_reporting_flag: false,
    fhip_mapping_key: null,
    display_order: 1,
    icon_key: null,
    active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function globalRule(overrides: Partial<FdhClassificationRule> = {}): FdhClassificationRule {
  return {
    id: 'rule-1',
    rule_key: 'income_salary_generic',
    rule_type: 'narrative_pattern',
    country_applicability: ['AU', 'IN'],
    match_definition: { match_kind: 'narrative_pattern', required_terms_normalised: ['SALARY'], excluded_terms_normalised: ['SALARY SACRIFICE'] },
    action_definition: { action_kind: 'classify', economic_transaction_type: 'income' },
    priority: 220,
    status: 'approved',
    active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as FdhClassificationRule;
}

function txn(overrides: Partial<ClassifiableTransaction> = {}): ClassifiableTransaction {
  return {
    id: 't1',
    financial_account_id: 'acc-1',
    transaction_date: '2026-03-01',
    description_clean: 'EFTPOS PURCHASE',
    merchant_raw: null,
    amount_original: 50,
    currency_original: 'AUD',
    credit_debit: 'debit',
    transaction_type_hint: 'unknown',
    user_override: false,
    ...overrides,
  };
}

function emptyRef(overrides: Partial<ClassificationReferenceData> = {}): ClassificationReferenceData {
  return {
    categories: [],
    subcategories: [],
    merchants: [],
    merchantAliases: [],
    globalRules: [],
    userRules: [],
    ...overrides,
  };
}

describe('R8 ruleMatching — matchesRule', () => {
  it('description_contains matches case-insensitively by default', () => {
    expect(
      matchesRule(
        { descriptionClean: 'ATM WITHDRAWAL FEE', merchantRaw: null, financialAccountId: 'a', institutionId: null },
        { match_kind: 'description_contains', needle_normalised: 'atm' },
      ),
    ).toBe(true);
  });

  it('description_contains respects case_sensitive: true', () => {
    const t = { descriptionClean: 'atm withdrawal', merchantRaw: null, financialAccountId: 'a', institutionId: null };
    expect(matchesRule(t, { match_kind: 'description_contains', needle_normalised: 'ATM', case_sensitive: true })).toBe(false);
    expect(matchesRule(t, { match_kind: 'description_contains', needle_normalised: 'atm', case_sensitive: true })).toBe(true);
  });

  it('narrative_pattern requires all terms, excludes excluded terms', () => {
    const t = { descriptionClean: 'SALARY SACRIFICE ADJ', merchantRaw: null, financialAccountId: 'a', institutionId: null };
    expect(matchesRule(t, { match_kind: 'narrative_pattern', required_terms_normalised: ['SALARY'], excluded_terms_normalised: ['SALARY SACRIFICE'] })).toBe(false);
  });

  it('institution_narrative requires BOTH the institution id and the narrative', () => {
    const t = { descriptionClean: 'CBA FEE NOTICE', merchantRaw: null, financialAccountId: 'a', institutionId: 'inst-cba' };
    expect(matchesRule(t, { match_kind: 'institution_narrative', institution_id: 'inst-cba', narrative_normalised: 'FEE NOTICE' })).toBe(true);
    expect(matchesRule(t, { match_kind: 'institution_narrative', institution_id: 'inst-other', narrative_normalised: 'FEE NOTICE' })).toBe(false);
  });

  it('account_scoped_default matches only the named account', () => {
    const t = { descriptionClean: 'X', merchantRaw: null, financialAccountId: 'acc-1', institutionId: null };
    expect(matchesRule(t, { match_kind: 'account_scoped_default', financial_account_id: 'acc-1' })).toBe(true);
    expect(matchesRule(t, { match_kind: 'account_scoped_default', financial_account_id: 'acc-2' })).toBe(false);
  });

  it('mcc and source_provided_category NEVER match — no CSV transaction carries that data', () => {
    const t = { descriptionClean: 'ANYTHING', merchantRaw: null, financialAccountId: 'a', institutionId: null };
    expect(matchesRule(t, { match_kind: 'mcc', mcc: '5411' })).toBe(false);
    expect(matchesRule(t, { match_kind: 'source_provided_category', source_category_key: 'groceries' })).toBe(false);
  });

  it('payment_rail_narrative never feeds economic classification (always false here)', () => {
    const t = { descriptionClean: 'UPI PAYMENT TO MERCHANT', merchantRaw: null, financialAccountId: 'a', institutionId: null };
    expect(matchesRule(t, { match_kind: 'payment_rail_narrative', rail_key: 'upi', narrative_terms_normalised: ['UPI'] })).toBe(false);
  });

  it('merchant_exact always returns false — resolved by identity elsewhere', () => {
    const t = { descriptionClean: 'X', merchantRaw: null, financialAccountId: 'a', institutionId: null };
    expect(matchesRule(t, { match_kind: 'merchant_exact', merchant_id: 'm1' })).toBe(false);
  });
});

describe('R8 ruleMatching — evaluateRules', () => {
  const rules = [
    globalRule({ id: 'r-low-priority', priority: 300 }),
    globalRule({ id: 'r-high-priority', priority: 100 }),
    globalRule({ id: 'r-inactive', priority: 50, active: false }),
    globalRule({ id: 'r-no-match', match_definition: { match_kind: 'narrative_pattern', required_terms_normalised: ['NOPE'] } }),
  ];

  it('returns only active, matching rules, sorted by ascending priority', () => {
    const result = evaluateRules(
      { descriptionClean: 'MONTHLY SALARY', merchantRaw: null, financialAccountId: 'a', institutionId: null },
      rules,
    );
    expect(result.map((r) => r.id)).toEqual(['r-high-priority', 'r-low-priority']);
  });
});

describe('R8 economicTypeEngine — classifyTransaction', () => {
  it('resolves UNKNOWN/unresolved when nothing matches, and flags for review', () => {
    const result = classifyTransaction(txn({ description_clean: 'UNRECOGNISABLE NARRATIVE XYZ' }), null, emptyRef());
    expect(result.economicTransactionType).toBe('unknown');
    expect(result.confidence).toBe('UNRESOLVED');
    expect(result.classificationMethod).toBe('unclassified');
    expect(result.source.kind).toBe('unresolved');
  });

  it('a verified merchant match wins over nothing, sets category from the merchant default + economic type from the category', () => {
    const cat = category({ id: 'cat-groceries', economic_type: 'expense' });
    const merchant: FdhMerchant = {
      id: 'm1', canonical_name: 'Woolworths', display_name: 'Woolworths', country_code: 'AU', merchant_type: 'retail',
      default_category_id: 'cat-groceries', default_subcategory_id: null, mcc: null, subscription_possible: false,
      essential_discretionary: 'essential', verification_status: 'approved', merged_into_merchant_id: null, active: true,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', recurring_possible: null, typical_frequency: null,
      fixed_amount_expected: null, variable_amount_possible: null, recurring_type: null, is_payment_processor: null,
    };
    const result = classifyTransaction(
      txn({ description_clean: 'WOOLWORTHS 1234 MELBOURNE' }),
      null,
      emptyRef({ categories: [cat], merchants: [merchant], merchantAliases: [] }),
    );
    expect(result.merchantId).toBe('m1');
    expect(result.categoryId).toBe('cat-groceries');
    expect(result.economicTransactionType).toBe('expense');
    expect(result.classificationMethod).toBe('merchant_master');
    expect(result.confidence).toBe('HIGH');
  });

  it('a global narrative_pattern rule classifies a salary credit as income', () => {
    const result = classifyTransaction(
      txn({ description_clean: 'MONTHLY SALARY CREDIT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [globalRule()] }),
    );
    expect(result.economicTransactionType).toBe('income');
    expect(result.classificationMethod).toBe('global_rule');
    expect(result.confidence).toBe('MEDIUM');
  });

  it('a user rule OUTRANKS a global rule for the same transaction (precedence tier 1)', () => {
    const userRule: FdhUserClassificationRule = {
      id: 'u1', user_id: 'user-1', household_id: null, rule_type: 'description_contains',
      match_definition: { match_kind: 'description_contains', needle_normalised: 'SALARY' },
      action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' },
      priority: 100, active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    const result = classifyTransaction(
      txn({ description_clean: 'MONTHLY SALARY CREDIT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [globalRule()], userRules: [userRule] }),
    );
    expect(result.economicTransactionType).toBe('transfer'); // the user's rule wins, not the global 'income' default
    expect(result.classificationMethod).toBe('user_rule');
    expect(result.confidence).toBe('HIGH');
  });

  it('the global default row itself is never mutated by a user-rule win (spec worked example)', () => {
    const rule = globalRule();
    const frozen = JSON.stringify(rule);
    classifyTransaction(
      txn({ description_clean: 'MONTHLY SALARY CREDIT', credit_debit: 'credit' }),
      null,
      emptyRef({
        globalRules: [rule],
        userRules: [
          {
            id: 'u1', user_id: 'user-1', household_id: null, rule_type: 'description_contains',
            match_definition: { match_kind: 'description_contains', needle_normalised: 'SALARY' },
            action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' },
            priority: 100, active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(JSON.stringify(rule)).toBe(frozen);
  });

  it('a flag_candidate action never sets an economic type but does surface a candidate', () => {
    const flagRule = globalRule({
      id: 'r-transfer-candidate',
      match_definition: { match_kind: 'narrative_pattern', required_terms_normalised: ['TRANSFER TO'] },
      action_definition: { action_kind: 'flag_candidate', candidate_type: 'transfer_candidate' },
    });
    const result = classifyTransaction(
      txn({ description_clean: 'TRANSFER TO SAVINGS' }),
      null,
      emptyRef({ globalRules: [flagRule] }),
    );
    expect(result.economicTransactionType).toBe('unknown');
    expect(result.flaggedCandidate).toBe('transfer_candidate');
  });

  it('a structural transaction_type_hint alone (no rule match) proposes a candidate but never commits an economic type', () => {
    const result = classifyTransaction(
      txn({ description_clean: 'UNRECOGNISED NARRATIVE', transaction_type_hint: 'transfer_candidate' }),
      null,
      emptyRef(),
    );
    expect(result.economicTransactionType).toBe('unknown');
    expect(result.flaggedCandidate).toBe('transfer_candidate');
  });

  it('an inactive user rule is never applied', () => {
    const inactiveUserRule: FdhUserClassificationRule = {
      id: 'u1', user_id: 'user-1', household_id: null, rule_type: 'description_contains',
      match_definition: { match_kind: 'description_contains', needle_normalised: 'SALARY' },
      action_definition: { action_kind: 'classify', economic_transaction_type: 'transfer' },
      priority: 100, active: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    const result = classifyTransaction(
      txn({ description_clean: 'MONTHLY SALARY CREDIT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [globalRule()], userRules: [inactiveUserRule] }),
    );
    expect(result.classificationMethod).toBe('global_rule'); // falls through to the global rule, not the inactive user rule
  });
});
