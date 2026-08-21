import { createClient } from '@/lib/supabase/server';

export type MasterItemCategory =
  | 'income'
  | 'expense'
  | 'asset'
  | 'liability'
  | 'investment'
  | 'retirement'
  | 'insurance';

export interface MasterFinancialItem {
  id: string;
  category: MasterItemCategory;
  item_key: string;
  item_label: string;
  sort_order: number;
  // Chunk 3a item 1 (Spec 1 §9 / Spec 2 §46) — category metadata added by
  // migrations 0033/0034. Optional so this interface stays valid even if a
  // caller queries an older selection that omits them.
  requires_purchase_date?: boolean;
  supports_purchase_date?: boolean;
  requires_purchase_price?: boolean;
  supports_purchase_price?: boolean;
  requires_country?: boolean;
  requires_currency?: boolean;
  supports_income_link?: boolean;
  supports_liability_link?: boolean;
  current_value_source?: 'balance' | 'market_value' | 'calculated' | null;
  future_flow_source?: boolean;
  purpose_dimension?: 'personal' | 'investment' | null;
}

const MASTER_ITEM_COLUMNS =
  'id, category, item_key, item_label, sort_order, ' +
  'requires_purchase_date, supports_purchase_date, requires_purchase_price, supports_purchase_price, ' +
  'requires_country, requires_currency, supports_income_link, supports_liability_link, ' +
  'current_value_source, future_flow_source, purpose_dimension';

export async function listMasterItems(category: MasterItemCategory) {
  const supabase = await createClient();
  return supabase
    .from('master_financial_items')
    .select(MASTER_ITEM_COLUMNS)
    .eq('category', category)
    .eq('is_active', true)
    .order('sort_order');
}
