import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_types')
    .select('type_key, category, type_label, forecast_logic_key, default_priority, default_importance_type, default_inflation_category, suggested_horizon_years, country_applicability')
    .eq('is_active', true)
    .order('sort_order');
  return error ? bad(error.message) : ok(data);
}
