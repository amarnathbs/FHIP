import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('resilience_scores')
    .select('score_month, rounded_score, status_band, confidence_score, risk_override_applied')
    .eq('user_id', user.id)
    .order('score_month', { ascending: true })
    .limit(36);
  return error ? bad(error.message) : ok(data);
}
