import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';

export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('RESILIENCE', request);
  if (!user) return blocked!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('resilience_scores')
    .select('score_month, rounded_score, status_band, confidence_score, risk_override_applied')
    .eq('user_id', user.id)
    .order('score_month', { ascending: true })
    .limit(36);
  return error ? bad(error.message) : ok(data);
}
