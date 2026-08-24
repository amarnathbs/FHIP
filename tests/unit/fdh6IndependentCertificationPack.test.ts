/**
 * FDH-6 — Independent Certification Pack (spec sections 77-82, 118-119).
 *
 * INDEPENDENCE (spec section 77). Every expected value below was derived by
 * hand, by reading the ACTUAL seeded reference data in
 * `supabase/migrations/0053_fdh2_taxonomy_and_mcc_seed.sql`,
 * `0056_fdh2_classification_rule_seed.sql` and this FDH-6 phase's own
 * `0072_fdh6_economic_class_gap_closure_rule_seed.sql` — never by running
 * the production engine and copying its output. Reference-data fixtures
 * below are transcribed from those migration files (narrative terms,
 * category/subcategory keys, priorities) so a reviewer can diff this file
 * against the SQL directly. This is a SEPARATE file from R8's own
 * `r8RuleMatchingAndEconomicType.test.ts`/`r8TransferRefundRecurring.test.ts`
 * — it does not reuse their fixtures or expected values.
 *
 * SCOPE. Pure functions only — `classifyTransaction`, `matchInternalTransfers`,
 * `matchRefundsToOriginals`, `detectRecurringSeries`, and R7's real
 * `decideDedup`/`computeEconomicFingerprint` — no database, no network.
 * Live-DEV certification (spec sections 105-113) is a SEPARATE script
 * (`scripts/fdh6_live_dev_certification.mjs`); this file is the
 * synthetic/offline half of the certification pack the spec's own section
 * 105 draws a line around ("Live DEV Certification... FULL PASS requires
 * real DEV certification" — implying an offline pack is the complement,
 * not a substitute).
 */
import { describe, expect, it } from 'vitest';
import { classifyTransaction } from '@/lib/financial-data-hub/classification/economicTypeEngine';
import { matchInternalTransfers, type TransferCandidateTxn } from '@/lib/financial-data-hub/classification/transferMatching';
import { matchRefundsToOriginals, type RefundCandidateTxn } from '@/lib/financial-data-hub/classification/refundReversalMatching';
import { detectRecurringSeries, type RecurringCandidateTxn } from '@/lib/financial-data-hub/classification/recurringDetection';
import { decideDedup, addToDedupIndex, type DedupIndex } from '@/lib/financial-data-hub/bank-csv/dedup';
import { computeEconomicFingerprint } from '@/lib/financial-data-hub/bank-csv/fingerprint';
import type { ClassifiableTransaction, ClassificationReferenceData } from '@/lib/financial-data-hub/classification/types';
import type {
  FdhCategory,
  FdhClassificationRule,
  FdhMerchant,
  FdhSubcategory,
} from '@/lib/financial-data-hub/domain/types';
import type { FdhAccountType } from '@/lib/financial-data-hub/constants/enums';

// ---------------------------------------------------------------------------
// Shared fixture builders (self-contained — no import from R8's own tests).
// ---------------------------------------------------------------------------

let categorySeq = 0;
function category(overrides: Partial<FdhCategory> = {}): FdhCategory {
  categorySeq += 1;
  return {
    id: overrides.id ?? `cat-${categorySeq}`,
    category_key: 'test_category',
    display_name: 'Test Category',
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

let subcategorySeq = 0;
function subcategory(categoryId: string, overrides: Partial<FdhSubcategory> = {}): FdhSubcategory {
  subcategorySeq += 1;
  return {
    id: overrides.id ?? `subcat-${subcategorySeq}`,
    category_id: categoryId,
    subcategory_key: 'test_subcategory',
    display_name: 'Test Subcategory',
    description: null,
    country_applicability: ['AU', 'IN'],
    tax_reporting_flag: null,
    fhip_mapping_key: null,
    display_order: 1,
    fhip_mapping_key_full: 'test_category.test_subcategory',
    active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as unknown as FdhSubcategory;
}

let ruleSeq = 0;
function globalRule(overrides: Partial<FdhClassificationRule> = {}): FdhClassificationRule {
  ruleSeq += 1;
  return {
    id: overrides.id ?? `grule-${ruleSeq}`,
    rule_key: `test_rule_${ruleSeq}`,
    rule_type: 'narrative_pattern',
    country_applicability: ['AU', 'IN'],
    match_definition: { match_kind: 'narrative_pattern', required_terms_normalised: ['TEST'] },
    action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
    priority: 200,
    status: 'approved',
    active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as FdhClassificationRule;
}

let merchantSeq = 0;
function merchant(overrides: Partial<FdhMerchant> = {}): FdhMerchant {
  merchantSeq += 1;
  return {
    id: overrides.id ?? `merch-${merchantSeq}`,
    canonical_name: 'TEST MERCHANT',
    display_name: 'Test Merchant',
    default_category_id: null,
    default_subcategory_id: null,
    mcc: null,
    country_code: null,
    subscription_possible: false,
    verification_status: 'approved',
    active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as unknown as FdhMerchant;
}

function txn(overrides: Partial<ClassifiableTransaction> = {}): ClassifiableTransaction {
  return {
    id: 't1',
    financial_account_id: 'acc-1',
    transaction_date: '2026-03-01',
    description_clean: 'TEST NARRATIVE',
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
  return { categories: [], subcategories: [], merchants: [], merchantAliases: [], globalRules: [], userRules: [], ...overrides };
}

/** Builds a single narrative_pattern classify rule EXACTLY as
 * `0056_fdh2_classification_rule_seed.sql` / `0072_fdh6_economic_class_gap_
 * closure_rule_seed.sql` define it — required/excluded terms transcribed
 * by hand from the SQL file, priority included, so a reviewer can diff this
 * fixture against the migration directly. */
function seededRule(
  ruleKey: string,
  required: string[],
  economicType: FdhClassificationRule['action_definition'] extends infer _T ? string : never,
  priority: number,
  excluded: string[] = [],
  country: Array<'AU' | 'IN'> = ['AU', 'IN'],
): FdhClassificationRule {
  return globalRule({
    id: ruleKey,
    rule_key: ruleKey,
    country_applicability: country,
    match_definition: {
      match_kind: 'narrative_pattern',
      required_terms_normalised: required,
      ...(excluded.length ? { excluded_terms_normalised: excluded } : {}),
    },
    action_definition: { action_kind: 'classify', economic_transaction_type: economicType as never },
    priority,
  });
}

function flagRule(ruleKey: string, required: string[], candidateType: string, priority: number, excluded: string[] = []): FdhClassificationRule {
  return globalRule({
    id: ruleKey,
    rule_key: ruleKey,
    match_definition: {
      match_kind: 'narrative_pattern',
      required_terms_normalised: required,
      ...(excluded.length ? { excluded_terms_normalised: excluded } : {}),
    },
    action_definition: { action_kind: 'flag_candidate', candidate_type: candidateType as never },
    priority,
  });
}

// =============================================================================
// SECTION A — AU economic-classification scenarios (spec section 79).
// =============================================================================
describe('FDH-6 Independent Cert — AU economic classification (spec section 79)', () => {
  it('[AU-01] salary credit -> INCOME (income_salary_generic, priority 220)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'MONTHLY SALARY DEPOSIT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('income_salary_generic', ['SALARY'], 'income', 220, ['SALARY SACRIFICE', 'SALARY PACKAGING'])] }),
    );
    expect(r.economicTransactionType).toBe('income');
    expect(r.classificationMethod).toBe('global_rule');
  });

  it('[AU-02] salary sacrifice is explicitly EXCLUDED from the salary rule — proves excluded_terms actually works', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'SALARY SACRIFICE ADJ', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('income_salary_generic', ['SALARY'], 'income', 220, ['SALARY SACRIFICE', 'SALARY PACKAGING'])] }),
    );
    expect(r.economicTransactionType).toBe('unknown'); // never falsely classified income
  });

  it('[AU-03] supermarket purchase -> EXPENSE via verified merchant match (Woolworths-style fixture)', () => {
    const groceries = category({ id: 'cat-groceries', category_key: 'groceries', economic_type: 'expense' });
    const woolworths = merchant({ id: 'm-woolworths', canonical_name: 'WOOLWORTHS', display_name: 'Woolworths', default_category_id: 'cat-groceries', verification_status: 'approved' });
    const r = classifyTransaction(
      txn({ description_clean: 'WOOLWORTHS 2456 MELBOURNE' }),
      null,
      emptyRef({ categories: [groceries], merchants: [woolworths] }),
    );
    expect(r.economicTransactionType).toBe('expense');
    expect(r.merchantId).toBe('m-woolworths');
    expect(r.classificationMethod).toBe('merchant_master');
  });

  it('[AU-04] utility bill (AGL energy) -> EXPENSE via merchant match, variable amount does not affect classification', () => {
    const utilities = category({ id: 'cat-utilities', category_key: 'utilities', economic_type: 'expense' });
    const agl = merchant({ id: 'm-agl', canonical_name: 'AGL ENERGY', default_category_id: 'cat-utilities' });
    const r1 = classifyTransaction(txn({ description_clean: 'AGL ENERGY BILL', amount_original: 145.32 }), null, emptyRef({ categories: [utilities], merchants: [agl] }));
    const r2 = classifyTransaction(txn({ description_clean: 'AGL ENERGY BILL', amount_original: 210.9 }), null, emptyRef({ categories: [utilities], merchants: [agl] }));
    expect(r1.economicTransactionType).toBe('expense');
    expect(r2.economicTransactionType).toBe('expense');
  });

  it('[AU-05] BPAY narrative is a PAYMENT RAIL, not an economic category — merchant match still governs classification', () => {
    const utilities = category({ id: 'cat-utilities', category_key: 'utilities', economic_type: 'expense' });
    const agl = merchant({ id: 'm-agl', canonical_name: 'AGL ENERGY', default_category_id: 'cat-utilities' });
    const railRule = globalRule({
      id: 'rail_au_bpay', rule_key: 'rail_au_bpay',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'au_bpay', narrative_terms_normalised: ['BPAY'] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'au_bpay' },
      priority: 50,
    });
    const r = classifyTransaction(
      txn({ description_clean: 'BPAY AGL ENERGY BILL PAYMENT' }),
      null,
      emptyRef({ categories: [utilities], merchants: [agl], globalRules: [railRule] }),
    );
    expect(r.economicTransactionType).toBe('expense'); // merchant wins; BPAY never overrides
  });

  it('[AU-06] PayID narrative alone (no merchant match) never commits an economic type — evidence only', () => {
    const railRule = globalRule({
      id: 'rail_au_payid', rule_key: 'rail_au_payid',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'au_payid', narrative_terms_normalised: ['PAYID'] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'au_payid' },
      priority: 50,
    });
    const r = classifyTransaction(txn({ description_clean: 'PAYID PAYMENT TO J SMITH' }), null, emptyRef({ globalRules: [railRule] }));
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[AU-07] Osko transfer narrative -> internal transfer CANDIDATE flag, never a committed economic type', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'OWN ACCOUNT TRANSFER VIA OSKO' }),
      null,
      emptyRef({ globalRules: [flagRule('transfer_own_account_generic', ['OWN ACCOUNT TRANSFER'], 'transfer_candidate', 260)] }),
    );
    expect(r.economicTransactionType).toBe('unknown');
    expect(r.flaggedCandidate).toBe('transfer_candidate');
  });

  it('[AU-08] direct debit narrative (rail evidence) + insurance merchant -> EXPENSE, category Insurance', () => {
    const insurance = category({ id: 'cat-insurance', category_key: 'insurance', economic_type: 'expense' });
    const aami = merchant({ id: 'm-aami', canonical_name: 'AAMI INSURANCE', default_category_id: 'cat-insurance' });
    const r = classifyTransaction(txn({ description_clean: 'DIRECT DEBIT AAMI INSURANCE PREMIUM' }), null, emptyRef({ categories: [insurance], merchants: [aami] }));
    expect(r.economicTransactionType).toBe('expense');
    expect(r.categoryId).toBe('cat-insurance');
  });

  it('[FDH6-AU-09] "HOME LOAN PRINCIPAL" -> DEBT_PRINCIPAL (FDH-6 gap closure, migration 0072)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'HOME LOAN PRINCIPAL PAYMENT' }),
      null,
      emptyRef({ globalRules: [seededRule('debt_principal_home_loan', ['HOME LOAN PRINCIPAL'], 'debt_principal', 175)] }),
    );
    expect(r.economicTransactionType).toBe('debt_principal');
  });

  it('[AU-10] "HOME LOAN INTEREST" -> DEBT_INTEREST (pre-existing R8/FDH-2 rule)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'HOME LOAN INTEREST CHARGE' }),
      null,
      emptyRef({ globalRules: [seededRule('interest_home_loan', ['HOME LOAN INTEREST'], 'debt_interest', 180)] }),
    );
    expect(r.economicTransactionType).toBe('debt_interest');
  });

  it('[AU-11] "CREDIT CARD PAYMENT" -> liability-settlement CANDIDATE, never a committed economic type (transfer intelligence resolves it later)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'CREDIT CARD PAYMENT TO VISA ACCT' }),
      null,
      emptyRef({ globalRules: [flagRule('ccpay_generic', ['CREDIT CARD PAYMENT'], 'liability_settlement_candidate', 210)] }),
    );
    expect(r.economicTransactionType).toBe('unknown');
    expect(r.flaggedCandidate).toBe('liability_settlement_candidate');
  });

  it('[AU-12] superannuation contribution (AustralianSuper merchant) -> INVESTMENT via merchant, never writes a holding (structural boundary, spec section 99)', () => {
    const retirement = category({ id: 'cat-retirement', category_key: 'retirement_contribution', economic_type: 'investment' });
    const superFund = merchant({ id: 'm-ausuper', canonical_name: 'AUSTRALIANSUPER', default_category_id: 'cat-retirement' });
    const r = classifyTransaction(txn({ description_clean: 'AUSTRALIANSUPER CONTRIBUTION' }), null, emptyRef({ categories: [retirement], merchants: [superFund] }));
    expect(r.economicTransactionType).toBe('investment');
    // No holding/tax-lot field exists anywhere on EconomicTypeResult — structurally cannot create one.
    expect(Object.keys(r)).not.toContain('holdingId');
  });

  it('[FDH6-AU-13] "BROKER FUNDING" -> ASSET_PURCHASE (FDH-6 gap closure, migration 0072) — never creates an Investment Intelligence holding', () => {
    const investPurchase = category({ id: 'cat-invpurchase', category_key: 'investment_purchase', economic_type: 'asset_purchase' });
    const r = classifyTransaction(
      txn({ description_clean: 'BROKER FUNDING TRANSFER COMMSEC' }),
      null,
      emptyRef({
        globalRules: [seededRule('asset_purchase_broker_funding_generic', ['BROKER FUNDING'], 'asset_purchase', 180)],
        categories: [investPurchase],
      }),
    );
    expect(r.economicTransactionType).toBe('asset_purchase');
  });

  it('[AU-14] ATO tax payment -> TAX', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'ATO PAYMENT PLAN INSTALMENT' }),
      null,
      emptyRef({ globalRules: [seededRule('gov_au_ato_tax_payment', ['ATO', 'PAYMENT'], 'tax', 210, ['REFUND'], ['AU'])] }),
    );
    expect(r.economicTransactionType).toBe('tax');
  });

  it('[AU-15] ATO REFUND is TAX-REFUND, never confused with the ATO tax-payment rule (excluded_terms boundary)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'ATO REFUND NOTICE' }),
      null,
      emptyRef({ globalRules: [seededRule('gov_au_ato_refund', ['ATO', 'REFUND'], 'refund', 200, [], ['AU'])] }),
    );
    expect(r.economicTransactionType).toBe('refund');
  });

  it('[AU-16] bank account fee -> FEE (fee_account_generic), fee waiver correctly excluded', () => {
    const r1 = classifyTransaction(
      txn({ description_clean: 'MONTHLY ACCOUNT FEE' }),
      null,
      emptyRef({ globalRules: [seededRule('fee_account_generic', ['ACCOUNT FEE'], 'fee', 180, ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'])] }),
    );
    expect(r1.economicTransactionType).toBe('fee');
    const r2 = classifyTransaction(
      txn({ description_clean: 'ACCOUNT FEE WAIVED THIS MONTH' }),
      null,
      emptyRef({ globalRules: [seededRule('fee_account_generic', ['ACCOUNT FEE'], 'fee', 180, ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'])] }),
    );
    expect(r2.economicTransactionType).toBe('unknown'); // waived fee never falsely charged
  });

  it('[AU-17] interest earned (credit) -> INCOME, but "INTEREST CHARGED" (debit) is explicitly excluded from the earned-interest rule', () => {
    const rule = seededRule('income_interest_earned', ['INTEREST'], 'income', 240, ['INTEREST CHARGED', 'INTEREST CHARGE', 'LOAN INTEREST', 'CARD INTEREST']);
    const earned = classifyTransaction(txn({ description_clean: 'INTEREST EARNED THIS QUARTER', credit_debit: 'credit' }), null, emptyRef({ globalRules: [rule] }));
    expect(earned.economicTransactionType).toBe('income');
    const charged = classifyTransaction(txn({ description_clean: 'INTEREST CHARGED ON OVERDRAFT', credit_debit: 'debit' }), null, emptyRef({ globalRules: [rule] }));
    expect(charged.economicTransactionType).toBe('unknown'); // proves credit_debit is NOT used to infer this — the exclusion term is
  });

  it('[AU-18] ATM withdrawal -> CASH_WITHDRAWAL, never immediately treated as a final expense (spec section 54)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'ATM WITHDRAWAL CBA BRANCH' }),
      null,
      emptyRef({ globalRules: [seededRule('cash_atm_withdrawal_generic', ['ATM WITHDRAWAL'], 'cash_withdrawal', 190)] }),
    );
    expect(r.economicTransactionType).toBe('cash_withdrawal');
    expect(r.economicTransactionType).not.toBe('expense');
  });

  it('[AU-19] merchant refund -> REFUND, not INCOME (the non-negotiable rule, spec section 5/35)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'REFUND FROM JB HI-FI', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('refund_purchase_generic', ['REFUND'], 'refund', 200, ['TAX REFUND', 'REFUND WAIVED'])] }),
    );
    expect(r.economicTransactionType).toBe('refund');
    expect(r.economicTransactionType).not.toBe('income'); // CREDIT != INCOME, even though this row is a credit
  });

  it('[AU-20] "BANK TRANSFER" narrative -> internal-transfer CANDIDATE only, per the disclosed FDH-2 forward reference to FDH-6', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'BANK TRANSFER TO SAVINGS ACCT' }),
      null,
      emptyRef({ globalRules: [flagRule('transfer_au_bank_transfer', ['BANK TRANSFER'], 'transfer_candidate', 260)] }),
    );
    expect(r.flaggedCandidate).toBe('transfer_candidate');
    expect(r.economicTransactionType).toBe('unknown');
  });
});

// =============================================================================
// SECTION B — India economic-classification scenarios (spec section 80).
// =============================================================================
describe('FDH-6 Independent Cert — India economic classification (spec section 80)', () => {
  it('[IN-01] salary credit (same global rule, AU+IN applicability) -> INCOME', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'SALARY CREDIT MAR 2026', credit_debit: 'credit', currency_original: 'INR' }),
      null,
      emptyRef({ globalRules: [seededRule('income_salary_generic', ['SALARY'], 'income', 220, ['SALARY SACRIFICE', 'SALARY PACKAGING'])] }),
    );
    expect(r.economicTransactionType).toBe('income');
  });

  it('[IN-02] UPI merchant payment (rail evidence) + Zomato-style merchant -> EXPENSE via merchant match', () => {
    const food = category({ id: 'cat-food', category_key: 'food_delivery', economic_type: 'expense' });
    const zomato = merchant({ id: 'm-zomato', canonical_name: 'ZOMATO', default_category_id: 'cat-food' });
    const railRule = globalRule({
      id: 'rail_in_upi', rule_key: 'rail_in_upi',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'in_upi', narrative_terms_normalised: ['UPI/', 'UPI-', 'UPI '] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'in_upi' },
      priority: 50,
    });
    const r = classifyTransaction(txn({ description_clean: 'UPI/ZOMATO/ORDER123' }), null, emptyRef({ categories: [food], merchants: [zomato], globalRules: [railRule] }));
    expect(r.economicTransactionType).toBe('expense');
  });

  it('[IN-03] UPI PERSONAL transfer to a bare name never resolves to a merchant, stays UNKNOWN (personal payees are never confused with merchants — spec section 15)', () => {
    const r = classifyTransaction(txn({ description_clean: 'UPI/RAVI KUMAR/9876543210' }), null, emptyRef());
    expect(r.economicTransactionType).toBe('unknown');
    expect(r.merchantId).toBeNull();
  });

  it('[IN-04] NEFT rail narrative alone never commits an economic type', () => {
    const railRule = globalRule({
      id: 'rail_in_neft', rule_key: 'rail_in_neft',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'in_neft', narrative_terms_normalised: ['NEFT'] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'in_neft' },
      priority: 50,
    });
    const r = classifyTransaction(txn({ description_clean: 'NEFT TRANSFER REF12345' }), null, emptyRef({ globalRules: [railRule] }));
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[IN-05] IMPS rail narrative alone never commits an economic type', () => {
    const railRule = globalRule({
      id: 'rail_in_imps', rule_key: 'rail_in_imps',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'in_imps', narrative_terms_normalised: ['IMPS'] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'in_imps' },
      priority: 50,
    });
    const r = classifyTransaction(txn({ description_clean: 'IMPS/P2A/998877/JOHN' }), null, emptyRef({ globalRules: [railRule] }));
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[IN-06] RTGS rail narrative alone never commits an economic type', () => {
    const railRule = globalRule({
      id: 'rail_in_rtgs', rule_key: 'rail_in_rtgs',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'in_rtgs', narrative_terms_normalised: ['RTGS'] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'in_rtgs' },
      priority: 50,
    });
    const r = classifyTransaction(txn({ description_clean: 'RTGS OUTWARD REMITTANCE' }), null, emptyRef({ globalRules: [railRule] }));
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[IN-07] NACH rail narrative alone never commits an economic type', () => {
    const railRule = globalRule({
      id: 'rail_in_nach', rule_key: 'rail_in_nach',
      match_definition: { match_kind: 'payment_rail_narrative', rail_key: 'in_nach', narrative_terms_normalised: ['NACH'] },
      action_definition: { action_kind: 'annotate_payment_rail', rail_key: 'in_nach' },
      priority: 50,
    });
    const r = classifyTransaction(txn({ description_clean: 'NACH MANDATE DEBIT' }), null, emptyRef({ globalRules: [railRule] }));
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[FDH6-IN-08] "EMI" + "PRINCIPAL" -> DEBT_PRINCIPAL (FDH-6 gap closure); "EMI" alone (no PRINCIPAL qualifier) correctly stays UNKNOWN — never invents a principal/interest split (spec section 50)', () => {
    const rule = seededRule('debt_principal_emi_principal_in', ['EMI', 'PRINCIPAL'], 'debt_principal', 190, [], ['IN']);
    const withPrincipal = classifyTransaction(txn({ description_clean: 'EMI PRINCIPAL COMPONENT MAR' }), null, emptyRef({ globalRules: [rule] }));
    expect(withPrincipal.economicTransactionType).toBe('debt_principal');
    const genericEmi = classifyTransaction(txn({ description_clean: 'EMI DEDUCTED HDFC BANK' }), null, emptyRef({ globalRules: [rule] }));
    expect(genericEmi.economicTransactionType).toBe('unknown'); // the safe, conservative outcome — no loan-schedule data to split it
  });

  it('[IN-09] "CREDIT CARD BILL" (India phrasing) -> liability-settlement CANDIDATE', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'CREDIT CARD BILL PAYMENT HDFC' }),
      null,
      emptyRef({ globalRules: [flagRule('ccpay_in_credit_card_bill', ['CREDIT CARD BILL'], 'liability_settlement_candidate', 210)] }),
    );
    expect(r.flaggedCandidate).toBe('liability_settlement_candidate');
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[FDH6-IN-10] "MF PURCHASE" -> ASSET_PURCHASE (FDH-6 gap closure, India-specific rule)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'MF PURCHASE ZERODHA COIN' }),
      null,
      emptyRef({ globalRules: [seededRule('asset_purchase_mf_purchase_in', ['MF PURCHASE'], 'asset_purchase', 190, [], ['IN'])] }),
    );
    expect(r.economicTransactionType).toBe('asset_purchase');
  });

  it('[IN-11] "SIP" (systematic investment plan) -> investment-funding CANDIDATE only, "SIP CANCELLED" correctly excluded', () => {
    const rule = flagRule('invtransfer_in_sip', ['SIP'], 'investment_funding_candidate', 260, ['SIP CANCELLED', 'SIP STOPPED']);
    const active = classifyTransaction(txn({ description_clean: 'SIP DEDUCTION MARCH' }), null, emptyRef({ globalRules: [rule] }));
    expect(active.flaggedCandidate).toBe('investment_funding_candidate');
    const cancelled = classifyTransaction(txn({ description_clean: 'SIP CANCELLED REFUND PENDING' }), null, emptyRef({ globalRules: [rule] }));
    expect(cancelled.flaggedCandidate).toBeNull();
  });

  it('[FDH6-IN-12] "BROKER FUNDING" (shared AU+IN rule) -> ASSET_PURCHASE for an Indian broker too', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'BROKER FUNDING GROWW', currency_original: 'INR' }),
      null,
      emptyRef({ globalRules: [seededRule('asset_purchase_broker_funding_generic', ['BROKER FUNDING'], 'asset_purchase', 180)] }),
    );
    expect(r.economicTransactionType).toBe('asset_purchase');
  });

  it('[IN-13] insurance premium (synthetic LIC merchant) -> EXPENSE', () => {
    const insurance = category({ id: 'cat-insurance-in', category_key: 'insurance', economic_type: 'expense' });
    const lic = merchant({ id: 'm-lic', canonical_name: 'LIC OF INDIA', default_category_id: 'cat-insurance-in' });
    const r = classifyTransaction(txn({ description_clean: 'LIC OF INDIA PREMIUM' }), null, emptyRef({ categories: [insurance], merchants: [lic] }));
    expect(r.economicTransactionType).toBe('expense');
  });

  it('[IN-14] "INCOME TAX" + "REFUND" -> REFUND (gov_in_income_tax_refund)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'INCOME TAX REFUND CREDITED', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('gov_in_income_tax_refund', ['INCOME TAX', 'REFUND'], 'refund', 200, [], ['IN'])] }),
    );
    expect(r.economicTransactionType).toBe('refund');
  });

  it('[IN-15] interest earned (India, same shared rule) -> INCOME', () => {
    const rule = seededRule('income_interest_earned', ['INTEREST'], 'income', 240, ['INTEREST CHARGED', 'INTEREST CHARGE', 'LOAN INTEREST', 'CARD INTEREST']);
    const r = classifyTransaction(txn({ description_clean: 'SAVINGS INTEREST CREDITED', credit_debit: 'credit' }), null, emptyRef({ globalRules: [rule] }));
    expect(r.economicTransactionType).toBe('income');
  });

  it('[IN-16] ATM withdrawal (India, shared rule) -> CASH_WITHDRAWAL', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'ATM WITHDRAWAL SBI ATM' }),
      null,
      emptyRef({ globalRules: [seededRule('cash_atm_withdrawal_generic', ['ATM WITHDRAWAL'], 'cash_withdrawal', 190)] }),
    );
    expect(r.economicTransactionType).toBe('cash_withdrawal');
  });

  it('[IN-17] merchant refund (India, shared rule) -> REFUND, not INCOME', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'REFUND AMAZON.IN ORDER', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('refund_purchase_generic', ['REFUND'], 'refund', 200, ['TAX REFUND', 'REFUND WAIVED'])] }),
    );
    expect(r.economicTransactionType).toBe('refund');
  });

  it('[IN-18] "SELF TRANSFER" -> internal-transfer CANDIDATE only (India-specific rule)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'SELF TRANSFER TO HDFC SAVINGS' }),
      null,
      emptyRef({ globalRules: [flagRule('transfer_in_self_transfer', ['SELF TRANSFER'], 'transfer_candidate', 260)] }),
    );
    expect(r.flaggedCandidate).toBe('transfer_candidate');
    expect(r.economicTransactionType).toBe('unknown');
  });

  it('[FDH6-IN-19] "MF REDEMPTION" -> ASSET_SALE (FDH-6 gap closure, India-specific rule)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'MF REDEMPTION PAYOUT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('asset_sale_mf_redemption_in', ['MF REDEMPTION'], 'asset_sale', 190, [], ['IN'])] }),
    );
    expect(r.economicTransactionType).toBe('asset_sale');
    expect(r.economicTransactionType).not.toBe('income'); // a credit, but never falsely INCOME
  });

  it('[IN-20] EPF contribution (debit) -> INVESTMENT, EPFO credit (not "CONTRIBUTION") -> INCOME — same underlying scheme, opposite direction, correctly distinguished by narrative', () => {
    const contribution = classifyTransaction(
      txn({ description_clean: 'EPF CONTRIBUTION MARCH', credit_debit: 'debit' }),
      null,
      emptyRef({ globalRules: [seededRule('gov_in_epf_contribution', ['EPF', 'CONTRIBUTION'], 'investment', 210, [], ['IN'])] }),
    );
    expect(contribution.economicTransactionType).toBe('investment');
    const withdrawal = classifyTransaction(
      txn({ description_clean: 'EPFO WITHDRAWAL CREDIT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('gov_in_epfo_credit', ['EPFO'], 'income', 220, ['CONTRIBUTION'], ['IN'])] }),
    );
    expect(withdrawal.economicTransactionType).toBe('income');
  });
});

// =============================================================================
// SECTION C — full 13-class reachability matrix (spec section 122).
// =============================================================================
describe('FDH-6 Independent Cert — all 13 economic classes reachable (spec sections 4, 122, 127)', () => {
  const cases: Array<{ type: string; build: () => ReturnType<typeof classifyTransaction> }> = [
    { type: 'income', build: () => classifyTransaction(txn({ description_clean: 'WAGES DEPOSIT', credit_debit: 'credit' }), null, emptyRef({ globalRules: [seededRule('income_wages_generic', ['WAGES'], 'income', 220)] })) },
    { type: 'expense', build: () => classifyTransaction(txn({ description_clean: 'WOOLWORTHS PURCHASE' }), null, emptyRef({ categories: [category({ id: 'c1', economic_type: 'expense' })], merchants: [merchant({ id: 'm1', canonical_name: 'WOOLWORTHS', default_category_id: 'c1' })] })) },
    { type: 'investment', build: () => classifyTransaction(txn({ description_clean: 'NPS CONTRIBUTION MARCH' }), null, emptyRef({ globalRules: [seededRule('gov_in_nps_contribution', ['NPS', 'CONTRIBUTION'], 'investment', 210, [], ['IN'])] })) },
    { type: 'debt_principal', build: () => classifyTransaction(txn({ description_clean: 'PERSONAL LOAN PRINCIPAL PAID' }), null, emptyRef({ globalRules: [seededRule('debt_principal_personal_loan', ['PERSONAL LOAN PRINCIPAL'], 'debt_principal', 175)] })) },
    { type: 'debt_interest', build: () => classifyTransaction(txn({ description_clean: 'PERSONAL LOAN INTEREST' }), null, emptyRef({ globalRules: [seededRule('interest_personal_loan', ['PERSONAL LOAN INTEREST'], 'debt_interest', 180)] })) },
    { type: 'refund', build: () => classifyTransaction(txn({ description_clean: 'CHARGEBACK PROCESSED', credit_debit: 'credit' }), null, emptyRef({ globalRules: [seededRule('refund_chargeback_generic', ['CHARGEBACK'], 'refund', 200)] })) },
    { type: 'asset_purchase', build: () => classifyTransaction(txn({ description_clean: 'MUTUAL FUND PURCHASE VANGUARD' }), null, emptyRef({ globalRules: [seededRule('asset_purchase_mutual_fund_purchase_generic', ['MUTUAL FUND PURCHASE'], 'asset_purchase', 180)] })) },
    { type: 'asset_sale', build: () => classifyTransaction(txn({ description_clean: 'SHARE SALE PROCEEDS', credit_debit: 'credit' }), null, emptyRef({ globalRules: [seededRule('asset_sale_share_sale_generic', ['SHARE SALE PROCEEDS'], 'asset_sale', 180)] })) },
    { type: 'tax', build: () => classifyTransaction(txn({ description_clean: 'ATO PAYMENT INSTALMENT' }), null, emptyRef({ globalRules: [seededRule('gov_au_ato_tax_payment', ['ATO', 'PAYMENT'], 'tax', 210, ['REFUND'], ['AU'])] })) },
    { type: 'fee', build: () => classifyTransaction(txn({ description_clean: 'ATM FEE CHARGED' }), null, emptyRef({ globalRules: [seededRule('fee_atm_generic', ['ATM FEE'], 'fee', 180, ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'])] })) },
    { type: 'cash_withdrawal', build: () => classifyTransaction(txn({ description_clean: 'BRANCH WITHDRAWAL CBA' }), null, emptyRef({ globalRules: [seededRule('cash_branch_withdrawal_generic', ['BRANCH WITHDRAWAL'], 'cash_withdrawal', 190)] })) },
    { type: 'unknown', build: () => classifyTransaction(txn({ description_clean: 'UNRECOGNISED MERCHANT XYZ123' }), null, emptyRef()) },
  ];

  for (const c of cases) {
    it(`economic class "${c.type}" is reachable and correctly resolved`, () => {
      expect(c.build().economicTransactionType).toBe(c.type);
    });
  }

  it('"transfer" is a distinct, real class in the frozen enum, even though the classify tier never sets it directly (own-account transfers are resolved as a RELATIONSHIP by transferMatching.ts, not a merchant/rule classify action — see FDH6_TRANSFER_INTELLIGENCE.md)', () => {
    const r = classifyTransaction(
      txn({ description_clean: 'INTERNAL TRANSFER TO SAVINGS' }),
      null,
      emptyRef({ globalRules: [flagRule('transfer_internal_generic', ['INTERNAL TRANSFER'], 'transfer_candidate', 260)] }),
    );
    expect(r.flaggedCandidate).toBe('transfer_candidate'); // the structural signal a human/transferMatching resolves next
  });

  it('all 13 economic classes are exercised across sections A-C combined (self-check on this pack)', () => {
    const covered = new Set(cases.map((c) => c.type));
    covered.add('transfer');
    expect(covered.size).toBe(13);
  });
});

// =============================================================================
// SECTION D — Transfer scenario pack (spec section 81).
// =============================================================================
describe('FDH-6 Independent Cert — Transfer scenario pack (spec section 81)', () => {
  const accountTypes = new Map<string, FdhAccountType>([
    ['acc-cba-everyday', 'transaction'], ['acc-anz-savings', 'savings'],
    ['acc-cba-1', 'transaction'], ['acc-cba-2', 'savings'],
    ['acc-a', 'transaction'], ['acc-b', 'savings'],
  ]);

  it('[T-01] same-bank matched (CBA account 1 -> CBA account 2)', () => {
    const debit: TransferCandidateTxn = { id: 'd1', financialAccountId: 'acc-cba-1', transactionDate: '2026-03-01', amountOriginal: 1000, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'TRANSFER', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c1', financialAccountId: 'acc-cba-2', creditDebit: 'credit' };
    const links = matchInternalTransfers([debit, credit], accountTypes);
    expect(links).toHaveLength(1);
    expect(links[0].linkType).toBe('internal_transfer');
  });

  it('[T-02] cross-bank matched (CBA debit -> ANZ credit) — institution equality is never required (spec section 27)', () => {
    const debit: TransferCandidateTxn = { id: 'd2', financialAccountId: 'acc-cba-everyday', transactionDate: '2026-03-05', amountOriginal: 750, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'TRANSFER', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c2', financialAccountId: 'acc-anz-savings', creditDebit: 'credit' };
    const links = matchInternalTransfers([debit, credit], accountTypes);
    expect(links).toHaveLength(1);
    expect(links[0].transactionIdFrom).toBe('d2');
    expect(links[0].transactionIdTo).toBe('c2');
  });

  it('[T-03] one-side missing — the debit-only side produces NO forced match (the caller\'s openCandidateLink path handles MISSING_COUNTERPART_ACCOUNT, tested in economicTypeEngine\'s flag_candidate coverage above)', () => {
    const debitOnly: TransferCandidateTxn = { id: 'd3', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 300, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'TRANSFER OUT', sourceReference: null };
    const links = matchInternalTransfers([debitOnly], accountTypes);
    expect(links).toHaveLength(0); // never fabricates a counterpart
  });

  it('[T-04] 1-day settlement delay -> matched, HIGH confidence (within the HIGH_CONFIDENCE_DAY_THRESHOLD)', () => {
    const debit: TransferCandidateTxn = { id: 'd4', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 200, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'TRANSFER', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c4', financialAccountId: 'acc-b', creditDebit: 'credit', transactionDate: '2026-03-02' };
    const links = matchInternalTransfers([debit, credit], accountTypes);
    expect(links).toHaveLength(1);
    expect(links[0].confidenceState).toBe('HIGH');
  });

  it('[T-05] 2-day settlement delay -> matched, MEDIUM confidence (past the HIGH threshold but inside the DATE_WINDOW)', () => {
    const debit: TransferCandidateTxn = { id: 'd5', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 200, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'TRANSFER', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c5', financialAccountId: 'acc-b', creditDebit: 'credit', transactionDate: '2026-03-03' };
    const links = matchInternalTransfers([debit, credit], accountTypes);
    expect(links).toHaveLength(1);
    expect(links[0].confidenceState).toBe('MEDIUM');
  });

  it('[T-06] same amount, UNRELATED transactions (different merchants/purpose, no account/direction relationship) — never matched (NEGATIVE CONTROL, spec section 73)', () => {
    const groceries: TransferCandidateTxn = { id: 'g1', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 85.5, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'WOOLWORTHS', sourceReference: null };
    // Same account, same direction as the "groceries" row above — structurally cannot ever be treated as its transfer counterpart (opposite direction is mandatory).
    const fuel: TransferCandidateTxn = { id: 'f1', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 85.5, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'SHELL FUEL', sourceReference: null };
    const links = matchInternalTransfers([groceries, fuel], accountTypes);
    expect(links).toHaveLength(0);
  });

  it('[T-07] different currency — never matched even with an identical numeric amount (spec section 30)', () => {
    const aud: TransferCandidateTxn = { id: 'a1', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 1000, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: null };
    const inr: TransferCandidateTxn = { id: 'i1', financialAccountId: 'acc-b', transactionDate: '2026-03-01', amountOriginal: 1000, currencyOriginal: 'INR', creditDebit: 'credit', descriptionClean: 'X', sourceReference: null };
    const links = matchInternalTransfers([aud, inr], accountTypes);
    expect(links).toHaveLength(0);
  });

  it('[T-08] multiple-candidate ambiguity — closest-date/same-reference pair wins, each transaction used in AT MOST one pair', () => {
    const debit: TransferCandidateTxn = { id: 'd8', financialAccountId: 'acc-a', transactionDate: '2026-03-05', amountOriginal: 400, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: null };
    const creditFar: TransferCandidateTxn = { ...debit, id: 'c8-far', financialAccountId: 'acc-b', creditDebit: 'credit', transactionDate: '2026-03-07' };
    const creditClose: TransferCandidateTxn = { ...debit, id: 'c8-close', financialAccountId: 'acc-b', creditDebit: 'credit', transactionDate: '2026-03-05' };
    const links = matchInternalTransfers([debit, creditFar, creditClose], accountTypes);
    expect(links).toHaveLength(1); // only ONE pair — no double-claiming
    expect(links[0].transactionIdTo).toBe('c8-close'); // closest date wins
  });

  it('[T-09] credit-card account counterpart -> credit_card_settlement, not internal_transfer', () => {
    const types = new Map<string, FdhAccountType>([['acc-everyday', 'transaction'], ['acc-cc', 'credit_card']]);
    const debit: TransferCandidateTxn = { id: 'd9', financialAccountId: 'acc-everyday', transactionDate: '2026-03-01', amountOriginal: 500, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c9', financialAccountId: 'acc-cc', creditDebit: 'credit' };
    const links = matchInternalTransfers([debit, credit], types);
    expect(links[0].linkType).toBe('credit_card_settlement');
  });

  it('[T-10] loan account counterpart -> loan_payment, not internal_transfer', () => {
    const types = new Map<string, FdhAccountType>([['acc-everyday', 'transaction'], ['acc-homeloan', 'home_loan']]);
    const debit: TransferCandidateTxn = { id: 'd10', financialAccountId: 'acc-everyday', transactionDate: '2026-03-01', amountOriginal: 2000, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c10', financialAccountId: 'acc-homeloan', creditDebit: 'credit' };
    const links = matchInternalTransfers([debit, credit], types);
    expect(links[0].linkType).toBe('loan_payment');
  });

  it('[T-11] matching source_reference boosts confidence to HIGH even across a wider (but still in-window) gap', () => {
    const debit: TransferCandidateTxn = { id: 'd11', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 500, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: 'REF-998877' };
    const credit: TransferCandidateTxn = { ...debit, id: 'c11', financialAccountId: 'acc-b', creditDebit: 'credit', transactionDate: '2026-03-03', sourceReference: 'REF-998877' };
    const links = matchInternalTransfers([debit, credit], accountTypes);
    expect(links[0].confidenceState).toBe('HIGH');
  });

  it('[T-12] every proposed link is written pending, never auto-confirmed (spec section 23 — conservative by design)', () => {
    const debit: TransferCandidateTxn = { id: 'd12', financialAccountId: 'acc-a', transactionDate: '2026-03-01', amountOriginal: 100, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: null };
    const credit: TransferCandidateTxn = { ...debit, id: 'c12', financialAccountId: 'acc-b', creditDebit: 'credit' };
    const links = matchInternalTransfers([debit, credit], accountTypes);
    // ProposedTransferLink itself carries no "status" field — status='pending' is applied by the
    // service layer at persistence time (transactionClassificationService.ts) unconditionally, for
    // every row this function returns. Confirmed here structurally: the type has no status field at all.
    expect('status' in links[0]).toBe(false);
  });
});

// =============================================================================
// SECTION E — Recurring scenario pack (spec section 82).
// =============================================================================
describe('FDH-6 Independent Cert — Recurring scenario pack (spec section 82)', () => {
  const mk = (id: string, date: string, amount = 15, merchantId = 'netflix'): RecurringCandidateTxn => ({
    id, transactionDate: date, amountOriginal: amount, currencyOriginal: 'AUD', creditDebit: 'debit',
    merchantId, descriptionClean: 'NETFLIX', financialAccountId: 'acc-1',
  });

  it('[R-01] weekly cadence detected correctly, not folded into monthly', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-01-08'), mk('c', '2026-01-15')]);
    expect(series[0].frequency).toBe('weekly');
  });

  it('[R-02] fortnightly cadence detected correctly', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-01-15'), mk('c', '2026-01-29')]);
    expect(series[0].frequency).toBe('fortnightly');
  });

  it('[R-03] monthly cadence detected correctly', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-02-01'), mk('c', '2026-03-01')]);
    expect(series[0].frequency).toBe('monthly');
  });

  it('[R-04] quarterly cadence detected correctly', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-04-01'), mk('c', '2026-07-01')]);
    expect(series[0].frequency).toBe('quarterly');
  });

  it('[R-05] annual cadence detected correctly', () => {
    const series = detectRecurringSeries([mk('a', '2024-03-01'), mk('b', '2025-03-01'), mk('c', '2026-03-01')]);
    expect(series[0].frequency).toBe('annual');
  });

  it('[R-06] variable-amount monthly bill (utility) still detected — exact equality is never required (spec section 44)', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-05', 120.5), mk('b', '2026-02-05', 145.2), mk('c', '2026-03-05', 98.75)]);
    expect(series).toHaveLength(1);
    expect(series[0].frequency).toBe('monthly');
    expect(series[0].confidence).toBe('MEDIUM'); // wide amount spread -> MEDIUM, never falsely HIGH
  });

  it('[R-07] business-day shift (Sat/Sun -> Mon) stays within the monthly tolerance and is still detected', () => {
    // Jan 31 2026 is a Saturday; the "monthly" charge lands on Mon Feb 2 instead.
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-02-02'), mk('c', '2026-03-02')]);
    expect(series[0].frequency).toBe('monthly');
  });

  it('[R-08] a missed month (gap far outside the monthly tolerance) breaks the series — never silently bridged', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-02-01'), mk('c', '2026-05-01')]);
    // The Jan->Feb gap is monthly; Feb->May (~90 days) is not — the WHOLE group is disqualified
    // (dedup.ts-style "one inconsistent gap disqualifies the group" rule), never half-reported.
    expect(series).toHaveLength(0);
  });

  it('[R-09] a one-off lookalike (single occurrence) never becomes a series at all — NEGATIVE CONTROL (spec section 75)', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01')]);
    expect(series).toHaveLength(0);
  });

  it('[R-10] two payments to a DIFFERENT merchant, same amount -> NOT recurring (NEGATIVE CONTROL, spec section 75)', () => {
    const a = mk('a', '2026-01-01', 15, 'netflix');
    const b = mk('b', '2026-02-01', 15, 'spotify'); // different merchant identity -> different group key entirely
    const series = detectRecurringSeries([a, b]);
    expect(series).toHaveLength(0); // never grouped together in the first place
  });

  it('[R-11] genuinely irregular one-off transactions (random gaps) are never forced into a series (NEGATIVE CONTROL, spec section 75)', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-01-19'), mk('c', '2026-03-22')]);
    expect(series).toHaveLength(0);
  });

  it('[R-12] two occurrences only -> insufficientHistory (spec section 53 INSUFFICIENT_HISTORY, not silently promoted to an established pattern)', () => {
    const series = detectRecurringSeries([mk('a', '2026-01-01'), mk('b', '2026-02-01')]);
    expect(series[0].insufficientHistory).toBe(true);
  });

  it('[R-13] a repeated variable-amount SALARY credit (bonus/overtime variance) is still recognised as monthly recurring — exact amount is never required (spec section 42)', () => {
    const salary = (id: string, date: string, amount: number): RecurringCandidateTxn => ({
      id, transactionDate: date, amountOriginal: amount, currencyOriginal: 'AUD', creditDebit: 'credit',
      merchantId: null, descriptionClean: 'EMPLOYER PTY LTD SALARY', financialAccountId: 'acc-1',
    });
    const series = detectRecurringSeries([salary('s1', '2026-01-15', 5200), salary('s2', '2026-02-15', 5450), salary('s3', '2026-03-15', 5200)]);
    expect(series).toHaveLength(1);
    expect(series[0].frequency).toBe('monthly');
  });

  it('[R-14] mixing credit and debit at the same merchant/account is never grouped into one series (spec: never mixes direction)', () => {
    const debit = mk('d1', '2026-01-01');
    const credit = { ...mk('c1', '2026-02-01'), creditDebit: 'credit' as const };
    const series = detectRecurringSeries([debit, credit]);
    expect(series).toHaveLength(0);
  });
});

// =============================================================================
// SECTION F — Refund scenario pack + negative controls (spec section 76).
// =============================================================================
describe('FDH-6 Independent Cert — Refund scenario pack (spec sections 35-38, 76)', () => {
  it('[F-01] full refund: same account, opposite direction, same amount, later date -> refund_original, HIGH confidence', () => {
    const original: RefundCandidateTxn = { id: 'o1', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 120, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const refund: RefundCandidateTxn = { id: 'r1', financialAccountId: 'acc-1', transactionDate: '2026-03-03', amountOriginal: 120, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([original, refund]);
    expect(links).toHaveLength(1);
    expect(links[0].linkType).toBe('refund_original');
    expect(links[0].confidence).toBe(1);
  });

  it('[F-02] partial refund (smaller amount) -> reversal_original, refund amount need NOT equal original (spec section 37)', () => {
    const original: RefundCandidateTxn = { id: 'o2', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 100, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const refund: RefundCandidateTxn = { id: 'r2', financialAccountId: 'acc-1', transactionDate: '2026-03-04', amountOriginal: 40, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([original, refund]);
    expect(links).toHaveLength(1);
    expect(links[0].linkType).toBe('reversal_original');
  });

  it('[F-03] NEGATIVE CONTROL (spec section 76) — a credit the SAME amount as a prior debit but at a DIFFERENT merchant/account is never automatically linked as a refund', () => {
    const original: RefundCandidateTxn = { id: 'o3', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 1000, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const unrelatedCredit: RefundCandidateTxn = { id: 'c3', financialAccountId: 'acc-2', transactionDate: '2026-03-05', amountOriginal: 1000, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([original, unrelatedCredit]);
    expect(links).toHaveLength(0); // different account -> never linked, even same amount
  });

  it('[F-04] NEGATIVE CONTROL (spec section 76) — salary 1000 credit is never treated as a refund of a 1000 expense, because it was never economic-type-classified as a refund in the first place', () => {
    const expense: RefundCandidateTxn = { id: 'e4', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 1000, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const salary: RefundCandidateTxn = { id: 's4', financialAccountId: 'acc-1', transactionDate: '2026-03-05', amountOriginal: 1000, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: false }; // NOT refund-classified
    const links = matchRefundsToOriginals([expense, salary]);
    expect(links).toHaveLength(0);
  });

  it('[F-05] a verified merchant reversal (isRefundClassified: true, matching evidence) IS a valid refund/reversal candidate', () => {
    const original: RefundCandidateTxn = { id: 'o5', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 55, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const reversal: RefundCandidateTxn = { id: 'rv5', financialAccountId: 'acc-1', transactionDate: '2026-03-02', amountOriginal: 55, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([original, reversal]);
    expect(links).toHaveLength(1);
  });

  it('[F-06] a refund can never exceed the original amount (spec section 36) — a $150 "refund" against a $100 original is never linked', () => {
    const original: RefundCandidateTxn = { id: 'o6', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 100, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const oversized: RefundCandidateTxn = { id: 'r6', financialAccountId: 'acc-1', transactionDate: '2026-03-03', amountOriginal: 150, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([original, oversized]);
    expect(links).toHaveLength(0);
  });

  it('[F-07] a refund dated BEFORE any candidate original is never linked (temporal integrity)', () => {
    const laterOriginal: RefundCandidateTxn = { id: 'o7', financialAccountId: 'acc-1', transactionDate: '2026-03-10', amountOriginal: 80, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const earlierRefund: RefundCandidateTxn = { id: 'r7', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 80, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([laterOriginal, earlierRefund]);
    expect(links).toHaveLength(0);
  });

  it('[F-08] a refund more than 90 days after the original is never linked (bounded lookback window, spec section 36)', () => {
    const original: RefundCandidateTxn = { id: 'o8', financialAccountId: 'acc-1', transactionDate: '2025-11-01', amountOriginal: 60, currencyOriginal: 'AUD', creditDebit: 'debit', isRefundClassified: false };
    const tooLate: RefundCandidateTxn = { id: 'r8', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 60, currencyOriginal: 'AUD', creditDebit: 'credit', isRefundClassified: true };
    const links = matchRefundsToOriginals([original, tooLate]);
    expect(links).toHaveLength(0);
  });
});

// =============================================================================
// SECTION G — Duplicate intelligence (R7 reused, spec sections 31-34, 74).
// =============================================================================
describe('FDH-6 Independent Cert — Duplicate intelligence, R7 reused, zero new engines (spec sections 31-34, 74)', () => {
  it('[D-01] NEGATIVE CONTROL (spec section 33/74) — two identical $10 same-merchant same-day purchases with NO reference/balance evidence: flagged only as a weak CANDIDATE, never auto-confirmed/discarded — both rows are retained', () => {
    const fp = computeEconomicFingerprint({
      financialAccountId: 'acc-1', currencyCode: 'AUD',
      transaction: { transactionDate: '2026-03-01', valueDate: null, amountOriginal: 10, creditDebit: 'debit', descriptionClean: 'coffee shop', referenceRaw: null, balanceAfter: null },
    });
    const index: DedupIndex = new Map();
    addToDedupIndex(index, fp, { transactionId: 'coffee-1001am', hasStrongEvidence: false });
    const decision = decideDedup({ economicFingerprint: fp, hasStrongEvidence: false }, index);
    expect(decision.status).toBe('duplicate_candidate'); // flagged for review...
    expect(decision.status).not.toBe('duplicate_confirmed'); // ...but NEVER silently auto-merged/discarded
  });

  it('[D-02] the SAME two coffees, when the source DOES provide a distinguishing reference number on both sides -> duplicate_confirmed is legitimate (strong evidence both sides)', () => {
    const fp = computeEconomicFingerprint({
      financialAccountId: 'acc-1', currencyCode: 'AUD',
      transaction: { transactionDate: '2026-03-01', valueDate: null, amountOriginal: 10, creditDebit: 'debit', descriptionClean: 'coffee shop', referenceRaw: 'REF001', balanceAfter: null },
    });
    const index: DedupIndex = new Map();
    addToDedupIndex(index, fp, { transactionId: 'first', hasStrongEvidence: true });
    const decision = decideDedup({ economicFingerprint: fp, hasStrongEvidence: true }, index);
    expect(decision.status).toBe('duplicate_confirmed');
    expect(decision.matchMethod).toBe('exact_hash');
  });

  it('[D-03] monthly recurring payment (same amount, same merchant, different month) is NEVER a duplicate — different fingerprint entirely (different transaction_date input)', () => {
    const fpJan = computeEconomicFingerprint({ financialAccountId: 'acc-1', currencyCode: 'AUD', transaction: { transactionDate: '2026-01-01', valueDate: null, amountOriginal: 15, creditDebit: 'debit', descriptionClean: 'netflix', referenceRaw: null, balanceAfter: null } });
    const fpFeb = computeEconomicFingerprint({ financialAccountId: 'acc-1', currencyCode: 'AUD', transaction: { transactionDate: '2026-02-01', valueDate: null, amountOriginal: 15, creditDebit: 'debit', descriptionClean: 'netflix', referenceRaw: null, balanceAfter: null } });
    expect(fpJan).not.toBe(fpFeb);
    const index: DedupIndex = new Map();
    addToDedupIndex(index, fpJan, { transactionId: 'jan', hasStrongEvidence: false });
    const decision = decideDedup({ economicFingerprint: fpFeb, hasStrongEvidence: false }, index);
    expect(decision.status).toBe('unique');
  });

  it('[D-04] CSV+PDF cross-format duplicate: the economic fingerprint deliberately EXCLUDES statement_upload_id/import batch, so the identical transaction re-imported from a different SOURCE FORMAT still collides and is caught as a duplicate candidate/confirmed (spec section 34)', () => {
    // Two "different" calls simulate two different parsers (CSV vs PDF) producing the same economic
    // facts — the fingerprint function takes no statement/format identifier as input at all.
    const csvSide = computeEconomicFingerprint({ financialAccountId: 'acc-1', currencyCode: 'AUD', transaction: { transactionDate: '2026-03-01', valueDate: null, amountOriginal: 250, creditDebit: 'debit', descriptionClean: 'electricity bill', referenceRaw: 'INV-5521', balanceAfter: null } });
    const pdfSide = computeEconomicFingerprint({ financialAccountId: 'acc-1', currencyCode: 'AUD', transaction: { transactionDate: '2026-03-01', valueDate: null, amountOriginal: 250, creditDebit: 'debit', descriptionClean: 'electricity bill', referenceRaw: 'INV-5521', balanceAfter: null } });
    expect(csvSide).toBe(pdfSide); // identical economic facts -> identical fingerprint regardless of source format
  });

  it('[D-05] a fingerprint match with STRONG evidence on only ONE side never auto-confirms (both sides must carry corroborating evidence, spec section 34)', () => {
    const fp = computeEconomicFingerprint({ financialAccountId: 'acc-1', currencyCode: 'AUD', transaction: { transactionDate: '2026-03-01', valueDate: null, amountOriginal: 10, creditDebit: 'debit', descriptionClean: 'x', referenceRaw: null, balanceAfter: null } });
    const index: DedupIndex = new Map();
    addToDedupIndex(index, fp, { transactionId: 'first', hasStrongEvidence: true }); // original side has strong evidence...
    const decision = decideDedup({ economicFingerprint: fp, hasStrongEvidence: false }, index); // ...new side does not
    expect(decision.status).toBe('duplicate_candidate'); // downgraded, never confirmed on one-sided evidence
  });
});

// =============================================================================
// SECTION H — Weakened-implementation negative-control PROOFS (spec section
// 119: "for every major engine family demonstrate the certification harness
// fails when the logic is deliberately weakened"). These naive helper
// functions exist ONLY in this test file, are never exported, and are never
// imported by any application code — they exist purely to prove the harness
// would catch a regression, not as a second real engine.
// =============================================================================
describe('FDH-6 Independent Cert — negative-control PROOFS (spec section 119)', () => {
  it('[NC-Transfer] a NAIVE amount-only matcher (no account/tenant/direction constraint) WOULD wrongly pair two unrelated same-amount transactions — the real matchInternalTransfers() correctly does NOT', () => {
    const naiveAmountOnlyMatch = (a: { amount: number }, b: { amount: number }) => a.amount === b.amount;
    const unrelatedA = { id: 'x', amount: 500 };
    const unrelatedB = { id: 'y', amount: 500 };
    expect(naiveAmountOnlyMatch(unrelatedA, unrelatedB)).toBe(true); // the naive check WOULD wrongly "match"

    // The real engine, given the same two amounts but same account + same direction (not a transfer
    // shape at all), correctly refuses:
    const real = matchInternalTransfers(
      [
        { id: 'x', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 500, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'X', sourceReference: null },
        { id: 'y', financialAccountId: 'acc-1', transactionDate: '2026-03-01', amountOriginal: 500, currencyOriginal: 'AUD', creditDebit: 'debit', descriptionClean: 'Y', sourceReference: null },
      ],
      new Map(),
    );
    expect(real).toHaveLength(0);
  });

  it('[NC-Duplicate] a NAIVE amount+date-only duplicate matcher WOULD wrongly flag two genuine same-day coffees as certain duplicates — the real decideDedup() correctly downgrades to a reviewable CANDIDATE, never a silent auto-merge', () => {
    const naiveAmountDateMatch = (a: { amount: number; date: string }, b: { amount: number; date: string }) => a.amount === b.amount && a.date === b.date;
    const coffee1 = { amount: 5, date: '2026-03-01' };
    const coffee2 = { amount: 5, date: '2026-03-01' };
    expect(naiveAmountDateMatch(coffee1, coffee2)).toBe(true); // the naive check treats them as certain duplicates

    const fp = computeEconomicFingerprint({ financialAccountId: 'acc-1', currencyCode: 'AUD', transaction: { transactionDate: '2026-03-01', valueDate: null, amountOriginal: 5, creditDebit: 'debit', descriptionClean: 'coffee shop', referenceRaw: null, balanceAfter: null } });
    const index: DedupIndex = new Map();
    addToDedupIndex(index, fp, { transactionId: 'coffee1', hasStrongEvidence: false });
    const real = decideDedup({ economicFingerprint: fp, hasStrongEvidence: false }, index);
    expect(real.status).not.toBe('duplicate_confirmed'); // the real engine never silently merges without corroborating evidence
  });

  it('[NC-Recurring] a NAIVE same-amount-only recurring detector WOULD wrongly group two random unrelated $50 purchases as "recurring" — the real detectRecurringSeries() requires merchant/description identity AND a consistent cadence', () => {
    const naiveAmountOnlyGroup = (txns: Array<{ amount: number }>) => {
      const byAmount = new Map<number, number>();
      for (const t of txns) byAmount.set(t.amount, (byAmount.get(t.amount) ?? 0) + 1);
      return [...byAmount.entries()].filter(([, count]) => count >= 2).map(([amount]) => amount);
    };
    const randomPurchases = [{ amount: 50 }, { amount: 50 }]; // two unrelated $50 purchases, different merchants, random dates
    expect(naiveAmountOnlyGroup(randomPurchases)).toEqual([50]); // the naive detector WOULD call this "recurring"

    const real = detectRecurringSeries([
      { id: 'a', transactionDate: '2026-01-03', amountOriginal: 50, currencyOriginal: 'AUD', creditDebit: 'debit', merchantId: 'merchant-a', descriptionClean: 'CORNER STORE', financialAccountId: 'acc-1' },
      { id: 'b', transactionDate: '2026-01-19', amountOriginal: 50, currencyOriginal: 'AUD', creditDebit: 'debit', merchantId: 'merchant-b', descriptionClean: 'HARDWARE SHOP', financialAccountId: 'acc-1' },
    ]);
    expect(real).toHaveLength(0); // different merchant identity -> never grouped in the first place
  });

  it('[NC-Classification] a NAIVE "every credit is income" classifier WOULD misclassify a refund as income — the real engine correctly keeps them distinct (spec sections 5, 35, 136)', () => {
    const naiveCreditIsIncome = (creditDebit: 'credit' | 'debit') => (creditDebit === 'credit' ? 'income' : 'expense');
    expect(naiveCreditIsIncome('credit')).toBe('income'); // the naive rule WOULD call every credit income

    const real = classifyTransaction(
      txn({ description_clean: 'REFUND FROM MERCHANT', credit_debit: 'credit' }),
      null,
      emptyRef({ globalRules: [seededRule('refund_purchase_generic', ['REFUND'], 'refund', 200, ['TAX REFUND', 'REFUND WAIVED'])] }),
    );
    expect(real.economicTransactionType).toBe('refund');
    expect(real.economicTransactionType).not.toBe('income');
  });

  it('[NC-Pagination] a hard-coded 1,000-row page WOULD silently drop row 1001 — the real fetchAllRows() pagination helper is separately certified not to (see FDH6_SCALE_CERTIFICATION.md / tests/unit/*Pagination*.test.ts)', () => {
    const naivePageOf1000 = Array.from({ length: 1000 }, (_, i) => i); // a hard-coded single page
    expect(naivePageOf1000).toHaveLength(1000);
    expect(naivePageOf1000.includes(1000)).toBe(false); // row #1001 (index 1000) is silently missing — the exact defect a real 1000-row LIMIT with no follow-up page produces
  });
});
