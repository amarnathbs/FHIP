// Shared client-side types + label maps for the SMSF Summary/Detailed
// Holdings UI (spec s.4-38). Mirrors the row shapes returned by
// lib/services/smsfData.ts / migration 0084 exactly — kept here rather than
// re-exported from a server file so these components never accidentally
// pull in '@supabase/supabase-js' server helpers into the client bundle.
import { SMSF_HOLDING_CLASS_TYPES } from '@/lib/validation/smsf';

export type SmsfMode = 'summary' | 'detailed';
export type CurrencyCode = 'AUD' | 'INR';
export type CountryCode = 'AU' | 'IN';
export type HoldingClass = keyof typeof SMSF_HOLDING_CLASS_TYPES;

export interface SmsfFundRow {
  id: string;
  user_id: string;
  retirement_account_id: string;
  fund_name: string;
  mode: SmsfMode;
  summary_balance: number | null;
  summary_balance_date: string | null;
  detailed_net_value: number | null;
  activated_detailed_at: string | null;
  currency_code: CurrencyCode;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  retirement_accounts: {
    id: string;
    account_name: string;
    current_balance: number;
    currency_code: CurrencyCode;
    is_active: boolean;
  };
}

export interface SmsfHoldingRow {
  id: string;
  user_id: string;
  smsf_fund_id: string;
  holding_class: HoldingClass;
  holding_type: string;
  holding_name: string;
  value: number;
  currency_code: CurrencyCode;
  country_code: CountryCode | null;
  linked_income_source_id: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SmsfMemberRow {
  id: string;
  user_id: string;
  smsf_fund_id: string;
  retirement_member_id: string;
  member_interest_amount: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  retirement_members: { id: string; member_type: 'self' | 'spouse' } | null;
}

export interface LiabilityOption {
  id: string;
  liability_name: string;
  balance: number;
  currency_code: CurrencyCode;
}

export interface IncomeOption {
  id: string;
  source_name: string;
  amount: number;
  frequency: string;
  currency_code: CurrencyCode;
}

// spec s.12-14 holding taxonomy, grouped exactly as the migration's CHECK
// constraint groups it — label text only, never a source of validation
// truth (the server/DB remain authoritative).
export const HOLDING_CLASS_LABELS: Record<HoldingClass, string> = {
  cash: 'Cash & Banking',
  listed_investment: 'Listed Investments',
  fixed_income: 'Fixed Income',
  property: 'Property',
  other: 'Other',
};

export const HOLDING_TYPE_LABELS: Record<string, string> = {
  cash: 'Cash',
  cash_account: 'Cash Account',
  term_deposit: 'Term Deposit',
  au_shares: 'AU Shares',
  international_shares: 'International Shares',
  etf: 'ETF',
  managed_fund: 'Managed Fund',
  index_fund: 'Index Fund',
  reit: 'REIT',
  government_bond: 'Government Bond',
  corporate_bond: 'Corporate Bond',
  other_bond: 'Other Bond',
  residential_property: 'Residential Property',
  commercial_property: 'Commercial Property',
  other_smsf_property: 'Other Property',
  gold_precious_metals: 'Gold / Precious Metals',
  private_unlisted: 'Private / Unlisted Investment',
  crypto: 'Cryptocurrency',
  other_smsf_asset: 'Other SMSF Asset',
};

export const HOLDING_CLASS_OPTIONS = (Object.keys(SMSF_HOLDING_CLASS_TYPES) as HoldingClass[]).map((key) => ({
  value: key,
  label: HOLDING_CLASS_LABELS[key],
}));

export function holdingTypeOptionsFor(holdingClass: HoldingClass) {
  return SMSF_HOLDING_CLASS_TYPES[holdingClass].map((type) => ({ value: type, label: HOLDING_TYPE_LABELS[type] ?? type }));
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request to ${url} failed`);
  return json.data as T;
}
