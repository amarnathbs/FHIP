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
}

export async function listMasterItems(category: MasterItemCategory) {
  const supabase = await createClient();
  return supabase
    .from('master_financial_items')
    .select('id, category, item_key, item_label, sort_order')
    .eq('category', category)
    .eq('is_active', true)
    .order('sort_order');
}
