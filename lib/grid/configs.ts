import { FREQUENCY_OPTIONS } from '@/lib/engines/money';
import { COUNTRY_OPTIONS } from '@/lib/constants';
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
  fields: [
    { name: 'current_value', label: 'Current Market Value', type: 'number', step: '0.01', required: true },
    { name: 'purchase_price', label: 'Purchase Price', type: 'number', step: '0.01' },
    { name: 'purchase_date', label: 'Purchase Date', type: 'date' },
    { name: 'country_code', label: 'Country', type: 'select', options: COUNTRY_OPTIONS },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};

export const liabilityGridConfig: GridConfig = {
  category: 'liability',
  resource: 'liabilities',
  title: 'Liabilities',
  description: 'Mortgages, loans, credit cards and anything else you owe.',
  nameField: 'liability_name',
  valueField: 'balance',
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
    { name: 'target_retirement_age', label: 'Target Retirement Age', type: 'number' },
    { name: 'country_code', label: 'Country', type: 'select', options: COUNTRY_OPTIONS },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
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
