import { createClient } from '@/lib/supabase/server';
import type { CountryCode } from '@/lib/services/jurisdiction';

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

/**
 * GEO-1: server/domain-level filtering (spec s.13-17 prefers this over
 * "load everything and hide half in React"). When `countryCode` is
 * provided, items whose country_applicability doesn't include it are
 * excluded from the result entirely — e.g. an IN resident's request never
 * gets the SMSF row back at all, so no UI code anywhere has to remember to
 * hide it. `countryCode` is optional (not every caller of this function is
 * jurisdiction-sensitive) and, when provided, must be the caller's own
 * resolved home country (lib/services/jurisdiction.ts) — never a
 * client-supplied value.
 */
export async function listMasterItems(category: MasterItemCategory, countryCode?: CountryCode | null) {
  const supabase = await createClient();
  let query = supabase
    .from('master_financial_items')
    .select('id, category, item_key, item_label, sort_order, country_applicability')
    .eq('category', category)
    .eq('is_active', true)
    .order('sort_order');

  if (countryCode) {
    query = query.or(`country_applicability.is.null,country_applicability.cs.{${countryCode}}`);
  }

  return query;
}
