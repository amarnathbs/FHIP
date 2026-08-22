// FDH-2 — classification-rule seed library (global, service-role-owned rows
// in fdh_classification_rules). See FDH2_CLASSIFICATION_RULE_SEEDS.md for the
// full precedence documentation. Nothing here is executed by any engine in
// FDH-2 — these are DATA a future engine (FDH-6) will read.
//
// STRUCTURAL SAFETY RULE, enforced by every row below: `flag_candidate` and
// `annotate_payment_rail` actions NEVER set economic_transaction_type,
// category_id or subcategory_id. Only genuinely unambiguous patterns (bank
// fees, interest direction, cash withdrawal, refund/reversal, well-formed
// salary/government-benefit narratives) use `classify` — and even then,
// `narrative_pattern` rules are LOWER priority than a verified merchant
// alias or MCC mapping (see the precedence order in
// FDH2_CLASSIFICATION_RULE_SEEDS.md), reflected here as a higher numeric
// `priority` value (lower priority number = evaluated first / more trusted).
const D = 'fhip_taxonomy_design';
const AU = ['AU'];
const IN = ['IN'];
const BOTH = ['AU', 'IN'];

function narrativeRule(rule_key, country_applicability, required, excluded, action, opts = {}) {
  return {
    rule_key,
    rule_type: 'narrative_pattern',
    country_applicability,
    match_definition: {
      match_kind: 'narrative_pattern',
      required_terms_normalised: required,
      ...(excluded && excluded.length ? { excluded_terms_normalised: excluded } : {}),
      ...(opts.source_context ? { source_context: opts.source_context } : {}),
    },
    action_definition: action,
    priority: opts.priority ?? 250,
    source_key: D,
  };
}

function railRule(rule_key, country_applicability, rail_key, terms, opts = {}) {
  return {
    rule_key,
    rule_type: 'payment_rail_narrative',
    country_applicability,
    match_definition: {
      match_kind: 'payment_rail_narrative',
      rail_key,
      narrative_terms_normalised: terms,
    },
    action_definition: { action_kind: 'annotate_payment_rail', rail_key },
    priority: opts.priority ?? 50,
    source_key: D,
  };
}

const classify = (economic_transaction_type, category, subcategory) => ({
  action_kind: 'classify',
  economic_transaction_type,
  // category_key/subcategory_key are resolved to real UUIDs by the generator
  // (scripts/fdh2_generate_master_data_migration.mjs) — kept as machine keys
  // here so this source file needs no database round-trip to author.
  category_key: category,
  subcategory_key: subcategory ?? null,
});

const flag = (candidate_type, note) => ({ action_kind: 'flag_candidate', candidate_type, ...(note ? { note } : {}) });

export const classificationRules = [
  // =====================================================================
  // INCOME / SALARY patterns. Bare terms like "PAY"/"PAYMENT"/"TRANSFER"/
  // "CREDIT" are deliberately NEVER used alone — every rule below requires
  // a genuinely salary-shaped term and excludes common false positives.
  // =====================================================================
  narrativeRule('income_salary_generic', BOTH, ['SALARY'], ['SALARY SACRIFICE', 'SALARY PACKAGING'], classify('income', 'income', 'salary_wages'), { priority: 220 }),
  narrativeRule('income_wages_generic', BOTH, ['WAGES'], null, classify('income', 'income', 'salary_wages'), { priority: 220 }),
  narrativeRule('income_payroll_generic', BOTH, ['PAYROLL'], null, classify('income', 'income', 'salary_wages'), { priority: 220 }),
  narrativeRule('income_bonus_generic', BOTH, ['BONUS'], ['BONUS POINTS', 'BONUS REWARD'], classify('income', 'income', 'bonus_commission'), { priority: 230 }),
  narrativeRule('income_commission_generic', BOTH, ['COMMISSION'], null, classify('income', 'income', 'bonus_commission'), { priority: 230 }),
  narrativeRule('income_dividend_generic', BOTH, ['DIVIDEND'], null, classify('income', 'income', 'dividend_income'), { priority: 220 }),
  narrativeRule('income_rental_generic', BOTH, ['RENTAL INCOME'], null, classify('income', 'income', 'rental_income'), { priority: 230 }),
  narrativeRule('income_interest_earned', BOTH, ['INTEREST'], ['INTEREST CHARGED', 'INTEREST CHARGE', 'LOAN INTEREST', 'CARD INTEREST'], classify('income', 'income', 'interest_income'), { priority: 240, }),

  // =====================================================================
  // GOVERNMENT PAYMENT patterns.
  // =====================================================================
  narrativeRule('gov_au_centrelink_benefit', AU, ['CENTRELINK'], ['REPAYMENT', 'DEBT RECOVERY'], classify('income', 'income', 'government_benefit'), { priority: 210 }),
  narrativeRule('gov_au_services_australia_benefit', AU, ['SERVICES AUSTRALIA'], ['REPAYMENT', 'DEBT RECOVERY'], classify('income', 'income', 'government_benefit'), { priority: 210 }),
  narrativeRule('gov_au_ato_refund', AU, ['ATO', 'REFUND'], null, classify('refund', 'refund_reversal', 'tax_refund'), { priority: 200 }),
  narrativeRule('gov_au_ato_tax_payment', AU, ['ATO', 'PAYMENT'], ['REFUND'], classify('tax', 'government_tax', 'income_tax_payment'), { priority: 210 }),
  narrativeRule('gov_in_epfo_credit', IN, ['EPFO'], ['CONTRIBUTION'], classify('income', 'income', 'government_benefit'), { priority: 220, note: 'EPFO withdrawal/settlement credit. A CONTRIBUTION-worded narrative is instead handled by gov_in_epf_contribution below.' }),
  narrativeRule('gov_in_epf_contribution', IN, ['EPF', 'CONTRIBUTION'], null, classify('investment', 'retirement_contribution', 'epf_contribution'), { priority: 210 }),
  narrativeRule('gov_in_income_tax_refund', IN, ['INCOME TAX', 'REFUND'], null, classify('refund', 'refund_reversal', 'tax_refund'), { priority: 200 }),
  narrativeRule('gov_in_nps_contribution', IN, ['NPS', 'CONTRIBUTION'], null, classify('investment', 'retirement_contribution', 'nps_contribution'), { priority: 210 }),

  // =====================================================================
  // TRANSFER patterns — CANDIDATE ONLY, never auto-classified as a
  // confirmed transfer. FDH-6 must match the counterpart movement.
  // =====================================================================
  narrativeRule('transfer_own_account_generic', BOTH, ['OWN ACCOUNT TRANSFER'], null, flag('transfer_candidate'), { priority: 260 }),
  narrativeRule('transfer_internal_generic', BOTH, ['INTERNAL TRANSFER'], null, flag('transfer_candidate'), { priority: 260 }),
  narrativeRule('transfer_au_bank_transfer', AU, ['BANK TRANSFER'], null, flag('transfer_candidate'), { priority: 270 }),
  narrativeRule('transfer_in_self_transfer', IN, ['SELF TRANSFER'], null, flag('transfer_candidate'), { priority: 260 }),

  // =====================================================================
  // CREDIT-CARD PAYMENT patterns — LIABILITY_SETTLEMENT_CANDIDATE, never
  // EXPENSE.
  // =====================================================================
  narrativeRule('ccpay_generic', BOTH, ['CREDIT CARD PAYMENT'], null, flag('liability_settlement_candidate'), { priority: 210 }),
  narrativeRule('ccpay_cc_bill', BOTH, ['CC BILL PAYMENT'], null, flag('liability_settlement_candidate'), { priority: 210 }),
  narrativeRule('ccpay_card_payment_received', BOTH, ['CARD PAYMENT RECEIVED'], null, flag('liability_settlement_candidate'), { priority: 210 }),
  narrativeRule('ccpay_in_credit_card_bill', IN, ['CREDIT CARD BILL'], null, flag('liability_settlement_candidate'), { priority: 210 }),

  // =====================================================================
  // INVESTMENT TRANSFER patterns — INVESTMENT_FUNDING_CANDIDATE, never
  // auto-classified as a confirmed investment purchase. Investment
  // Intelligence remains the canonical owner of any resulting holding.
  // =====================================================================
  narrativeRule('invtransfer_mutual_fund_purchase', BOTH, ['MUTUAL FUND'], ['REDEMPTION', 'DIVIDEND'], flag('investment_funding_candidate'), { priority: 260 }),
  narrativeRule('invtransfer_in_sip', IN, ['SIP'], ['SIP CANCELLED', 'SIP STOPPED'], flag('investment_funding_candidate'), { priority: 260, note: 'Systematic Investment Plan instalment.' }),
  narrativeRule('invtransfer_broker_funding', BOTH, ['BROKER'], ['BROKERAGE FEE', 'BROKER FEE'], flag('investment_funding_candidate'), { priority: 280 }),

  // =====================================================================
  // BANK FEE patterns — direct classify (fee narratives are unusually
  // unambiguous), always excluding a waived/reversed/refunded fee.
  // =====================================================================
  narrativeRule('fee_account_generic', BOTH, ['ACCOUNT FEE'], ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'], classify('fee', 'financial_fees', 'bank_account_fee'), { priority: 180 }),
  narrativeRule('fee_annual_generic', BOTH, ['ANNUAL FEE'], ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'], classify('fee', 'financial_fees', 'card_annual_fee'), { priority: 180 }),
  narrativeRule('fee_late_generic', BOTH, ['LATE FEE'], ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'], classify('fee', 'financial_fees', 'late_payment_fee'), { priority: 180 }),
  narrativeRule('fee_overdraft_generic', BOTH, ['OVERDRAFT FEE'], ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'], classify('fee', 'financial_fees', 'overdraft_fee'), { priority: 180 }),
  narrativeRule('fee_atm_generic', BOTH, ['ATM FEE'], ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'], classify('fee', 'financial_fees', 'atm_fee'), { priority: 180 }),
  narrativeRule('fee_foreign_transaction_generic', BOTH, ['FOREIGN TRANSACTION FEE'], ['FEE WAIVED', 'FEE REVERSED', 'FEE REFUND'], classify('fee', 'financial_fees', 'foreign_transaction_fee'), { priority: 180 }),
  narrativeRule('fee_dishonour_au', AU, ['DISHONOUR FEE'], ['FEE WAIVED', 'FEE REVERSED'], classify('fee', 'financial_fees', 'other_fee'), { priority: 180 }),
  narrativeRule('fee_in_penal_charge', IN, ['PENAL CHARGE'], ['CHARGE WAIVED', 'CHARGE REVERSED'], classify('fee', 'financial_fees', 'other_fee'), { priority: 190 }),

  // =====================================================================
  // INTEREST patterns — direction resolved by required/excluded terms:
  // "INTEREST CHARGED"/"INTEREST CHARGE" means an EXPENSE (loan/card
  // interest), while a bare account-credit "INTEREST" (excluding those
  // phrases — see income_interest_earned above) means INCOME.
  // =====================================================================
  narrativeRule('interest_charged_generic', BOTH, ['INTEREST CHARGED'], null, classify('debt_interest', 'loan_interest', 'other_loan_interest'), { priority: 190 }),
  narrativeRule('interest_charge_card', BOTH, ['INTEREST CHARGE'], null, classify('debt_interest', 'loan_interest', 'credit_card_interest'), { priority: 190 }),
  narrativeRule('interest_home_loan', BOTH, ['HOME LOAN INTEREST'], null, classify('debt_interest', 'loan_interest', 'home_loan_interest'), { priority: 180 }),
  narrativeRule('interest_personal_loan', BOTH, ['PERSONAL LOAN INTEREST'], null, classify('debt_interest', 'loan_interest', 'personal_loan_interest'), { priority: 180 }),

  // =====================================================================
  // CASH WITHDRAWAL patterns — never automatically household consumption.
  // =====================================================================
  narrativeRule('cash_atm_withdrawal_generic', BOTH, ['ATM WITHDRAWAL'], null, classify('cash_withdrawal', 'cash_withdrawal', 'atm_cash_withdrawal'), { priority: 190 }),
  narrativeRule('cash_withdrawal_generic', BOTH, ['CASH WITHDRAWAL'], null, classify('cash_withdrawal', 'cash_withdrawal', 'atm_cash_withdrawal'), { priority: 200 }),
  narrativeRule('cash_branch_withdrawal_generic', BOTH, ['BRANCH WITHDRAWAL'], null, classify('cash_withdrawal', 'cash_withdrawal', 'branch_cash_withdrawal'), { priority: 190 }),

  // =====================================================================
  // REFUND / REVERSAL patterns. FDH-2 does NOT attempt to link a refund to
  // its original transaction (that is FDH-6).
  // =====================================================================
  narrativeRule('refund_purchase_generic', BOTH, ['REFUND'], ['TAX REFUND', 'REFUND WAIVED'], classify('refund', 'refund_reversal', 'purchase_refund'), { priority: 210 }),
  narrativeRule('refund_reversal_generic', BOTH, ['REVERSAL'], null, classify('refund', 'refund_reversal', 'transaction_reversal_chargeback'), { priority: 210 }),
  narrativeRule('refund_reversed_generic', BOTH, ['REVERSED'], null, classify('refund', 'refund_reversal', 'transaction_reversal_chargeback'), { priority: 220 }),
  narrativeRule('refund_chargeback_generic', BOTH, ['CHARGEBACK'], null, classify('refund', 'refund_reversal', 'transaction_reversal_chargeback'), { priority: 200 }),

  // =====================================================================
  // PAYMENT RAIL annotation patterns — mechanism only, NEVER an economic
  // category (specification section 38-43, explicitly critical).
  // =====================================================================
  railRule('rail_au_eftpos', AU, 'au_eftpos', ['EFTPOS']),
  railRule('rail_au_bpay', AU, 'au_bpay', ['BPAY']),
  railRule('rail_au_osko', AU, 'au_osko', ['OSKO']),
  railRule('rail_au_payid', AU, 'au_payid', ['PAYID']),
  railRule('rail_au_direct_debit', AU, 'au_direct_debit', ['DIRECT DEBIT']),
  railRule('rail_au_direct_credit', AU, 'au_direct_credit', ['DIRECT CREDIT']),
  railRule('rail_au_atm', AU, 'au_atm', ['ATM']),
  railRule('rail_in_upi', IN, 'in_upi', ['UPI/', 'UPI-', 'UPI ']),
  railRule('rail_in_imps', IN, 'in_imps', ['IMPS']),
  railRule('rail_in_neft', IN, 'in_neft', ['NEFT']),
  railRule('rail_in_rtgs', IN, 'in_rtgs', ['RTGS']),
  railRule('rail_in_nach', IN, 'in_nach', ['NACH']),
  railRule('rail_in_ecs', IN, 'in_ecs', ['ECS']),
  railRule('rail_in_pos_card', IN, 'in_pos_card', ['POS ']),
];
