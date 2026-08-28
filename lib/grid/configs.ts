import { FREQUENCY_OPTIONS } from '@/lib/engines/money';
import { COUNTRY_OPTIONS } from '@/lib/constants';
import { getAssetFieldMetadata } from './assetFieldMetadata';
import type { GridConfig } from './types';

export const incomeGridConfig: GridConfig = {
  category: 'income',
  resource: 'income',
  title: 'Income',
  description: 'Work down the list and tick anything that applies — most people forget one or two.',
  nameField: 'source_name',
  valueField: 'amount',
  isFlow: true,
  frequencyField: 'frequency',
  reviewSection: 'income',
  fields: [
    { name: 'amount', label: 'Gross Amount', type: 'number', step: '0.01', required: true },
    { name: 'net_amount', label: 'Net Amount', type: 'number', step: '0.01' },
    { name: 'frequency', label: 'Frequency', type: 'select', options: FREQUENCY_OPTIONS, required: true },
    { name: 'is_taxable', label: 'Taxable', type: 'checkbox', defaultValue: true },
    { name: 'employer_name', label: 'Employer', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};

export const expenseGridConfig: GridConfig = {
  category: 'expense',
  resource: 'expenses',
  title: 'Expenses',
  description: 'Every common household expense is already listed — tick what applies and fill in the amount.',
  nameField: 'expense_name',
  valueField: 'amount',
  isFlow: true,
  frequencyField: 'frequency',
  reviewSection: 'expenses',
  fields: [
    { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true },
    { name: 'frequency', label: 'Frequency', type: 'select', options: FREQUENCY_OPTIONS, required: true },
    { name: 'is_essential', label: 'Essential', type: 'checkbox' },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};

export const assetGridConfig: GridConfig = {
  category: 'asset',
  resource: 'assets',
  title: 'Assets',
  description: 'Cash, property, vehicles and other things you own.',
  nameField: 'asset_name',
  valueField: 'current_value',
  reviewSection: 'assets',
  propertyLinkSide: 'property',
  fields: [
    { name: 'current_value', label: 'Current Market Value', type: 'number', step: '0.01', required: true },
    { name: 'purchase_price', label: 'Purchase Price', type: 'number', step: '0.01' },
    { name: 'purchase_date', label: 'Purchase Date', type: 'date' },
    { name: 'country_code', label: 'Country', type: 'select', options: COUNTRY_OPTIONS },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
  // App Review tier-2 Fix 4: Purchase Price/Date are meaningless for
  // cash-type accounts (Wallet Cash, Savings/Cheque/Offset Account, Foreign
  // Currency) — see lib/grid/assetFieldMetadata.ts for the full per-item-
  // type table and root-cause writeup.
  fieldVisibleForRow: (fieldName, masterItemKey) => {
    if (fieldName !== 'purchase_price' && fieldName !== 'purchase_date') return true;
    const meta = getAssetFieldMetadata(masterItemKey);
    return fieldName === 'purchase_price' ? meta.supportsPurchasePrice : meta.supportsPurchaseDate;
  },
};

export const liabilityGridConfig: GridConfig = {
  category: 'liability',
  resource: 'liabilities',
  title: 'Liabilities',
  description: 'Mortgages, loans, credit cards and anything else you owe.',
  nameField: 'liability_name',
  valueField: 'balance',
  reviewSection: 'liabilities',
  propertyLinkSide: 'liability',
  zeroConfirmation: {
    section: 'liabilities',
    question: 'Do you currently have any debts or financial liabilities?',
    noLabel: 'No, I have no debts or liabilities',
  },
  fields: [
    { name: 'lender', label: 'Lender', type: 'text' },
    { name: 'balance', label: 'Outstanding Balance', type: 'number', step: '0.01', required: true },
    { name: 'interest_rate', label: 'Interest Rate %', type: 'number', step: '0.01' },
    {
      name: 'interest_rate_type',
      label: 'Rate Type',
      type: 'select',
      options: [
        { value: 'fixed', label: 'Fixed' },
        { value: 'variable', label: 'Variable' },
      ],
    },
    { name: 'fixed_rate_expiry', label: 'Fixed Rate Expiry', type: 'date' },
    { name: 'credit_limit', label: 'Credit Limit', type: 'number', step: '0.01' },
    { name: 'monthly_repayment', label: 'Monthly Repayment', type: 'number', step: '0.01' },
    { name: 'country_code', label: 'Country', type: 'select', options: COUNTRY_OPTIONS },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};

export const investmentGridConfig: GridConfig = {
  category: 'investment',
  resource: 'investments',
  title: 'Investments',
  description: 'Shares, funds, property and other investments outside super.',
  nameField: 'investment_name',
  valueField: 'current_value',
  reviewSection: 'investments',
  propertyLinkSide: 'property',
  goalLinkable: true,
  notApplicable: { profileField: 'not_applicable_investments', label: "I don't have any investments" },
  fields: [
    { name: 'institution', label: 'Institution', type: 'text' },
    { name: 'current_value', label: 'Current Value', type: 'number', step: '0.01', required: true },
    { name: 'cost_base', label: 'Cost Base', type: 'number', step: '0.01' },
    { name: 'annual_contribution', label: 'Annual Contribution', type: 'number', step: '0.01' },
    {
      name: 'risk_profile',
      label: 'Risk Profile',
      type: 'select',
      options: [
        { value: 'conservative', label: 'Conservative' },
        { value: 'balanced', label: 'Balanced' },
        { value: 'growth', label: 'Growth' },
        { value: 'high_growth', label: 'High growth' },
        { value: 'unknown', label: 'Unknown' },
      ],
    },
    { name: 'country_code', label: 'Country', type: 'select', options: COUNTRY_OPTIONS },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};

export const retirementGridConfig: GridConfig = {
  category: 'retirement',
  resource: 'retirement',
  title: 'Retirement',
  description: 'Superannuation, EPF, PPF, NPS and other retirement accounts.',
  nameField: 'account_name',
  valueField: 'current_balance',
  reviewSection: 'retirement',
  notApplicable: { profileField: 'not_applicable_retirement', label: "I don't have any retirement savings" },
  // Retirement Member UI (spec s.16-17): target retirement age is no longer
  // requested per account or per contribution row here — it is captured
  // once per member (Self/Spouse) in the "Retirement Planning" section
  // above this grid (components/retirement/RetirementPlanningSection.tsx),
  // backed by retirement_members. The legacy retirement_accounts.
  // target_retirement_age column is kept for backward compatibility (spec
  // s.27) but is deliberately no longer surfaced here.
  fields: [
    { name: 'current_balance', label: 'Current Balance', type: 'number', step: '0.01', required: true },
    { name: 'employer_contribution', label: 'Employer Contribution', type: 'number', step: '0.01' },
    { name: 'personal_contribution', label: 'Personal Contribution', type: 'number', step: '0.01' },
    {
      name: 'contribution_frequency',
      label: 'Contribution Frequency',
      type: 'select',
      options: FREQUENCY_OPTIONS,
    },
    { name: 'country_code', label: 'Country', type: 'select', options: COUNTRY_OPTIONS },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
  // SMSF-UI (spec s.4-38): SMSF has its own dedicated Fund/Members/
  // Summary-Detailed-Holdings management UI (components/retirement/smsf/
  // SmsfSection.tsx, rendered via beforeGrid above) — it must not also
  // appear as a plain spreadsheet row here, where this grid's generic
  // per-field PATCH would let a user overwrite retirement_accounts.
  // current_balance directly and desync it from smsf_funds.summary_balance
  // / detailed_net_value (the only two paths that are supposed to ever set
  // it). The underlying row still exists, still counts once in Net Worth
  // and completion stats via the real SMSF UI — this only removes it from
  // this specific editable table.
  excludeMasterItemKeys: ['smsf'],
};

export const insuranceGridConfig: GridConfig = {
  category: 'insurance',
  resource: 'insurance',
  title: 'Insurance',
  description: 'Life, income protection, health, home, vehicle and other cover.',
  nameField: 'policy_name',
  valueField: 'premium',
  isFlow: true,
  frequencyField: 'premium_frequency',
  reviewSection: 'insurance',
  // Phase 0C: replaces the old "this doesn't apply to me" checkbox with an
  // explicit Yes/No/Not-sure question — "no insurance" is real, scoreable
  // risk information for this category (unlike Investments/Retirement,
  // where genuine inapplicability is plausible), so it shouldn't be
  // excluded from the score the way notApplicable is. Any pre-Phase-0C user
  // who already set the old not_applicable_insurance flag keeps that
  // confirmation (migration 0031 backfills it), the engine still honours
  // it — this UI change only affects how new confirmations are made.
  zeroConfirmation: {
    section: 'insurance',
    question: 'Do you currently hold personal insurance cover?',
    noLabel: "No, I don't currently hold personal insurance",
    includeUnsure: true,
  },
  fields: [
    { name: 'provider', label: 'Provider', type: 'text' },
    { name: 'cover_amount', label: 'Cover Amount', type: 'number', step: '0.01', required: true },
    { name: 'premium', label: 'Premium', type: 'number', step: '0.01', required: true },
    {
      name: 'premium_frequency',
      label: 'Premium Frequency',
      type: 'select',
      options: FREQUENCY_OPTIONS,
      required: true,
    },
    { name: 'renewal_date', label: 'Renewal Date', type: 'date' },
    { name: 'waiting_period_days', label: 'Waiting Period (days)', type: 'number' },
    { name: 'benefit_period', label: 'Benefit Period', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};
